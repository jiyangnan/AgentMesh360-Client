//! Public handle for talking to the sampler actor.

use tokio::sync::{mpsc, oneshot};

use xai_grok_sampling_types::{ConversationRequest, ConversationResponse, SamplingError};

use crate::commands::SamplerCommand;
use crate::config::SamplerConfig;
use crate::metrics::InferenceLatencyStats;
use crate::types::RequestId;

struct CancelOnDrop {
    cmd_tx: mpsc::UnboundedSender<SamplerCommand>,
    request_id: RequestId,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(SamplerCommand::Cancel {
            request_id: self.request_id.clone(),
        });
    }
}

/// A request that has been accepted by the sampler actor command channel.
///
/// Dropping this value cancels the in-flight request. Keeping acceptance and
/// completion separate gives trusted hosts an exact boundary for durable route
/// auditing without claiming that a merely prepared request was submitted.
pub struct PendingSamplingRequest {
    completion_rx:
        oneshot::Receiver<Result<(ConversationResponse, InferenceLatencyStats), SamplingError>>,
    _cancel_on_drop: CancelOnDrop,
}

impl std::fmt::Debug for PendingSamplingRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingSamplingRequest")
            .field("accepted", &true)
            .finish()
    }
}

impl PendingSamplingRequest {
    pub async fn collect(
        self,
    ) -> Result<(ConversationResponse, InferenceLatencyStats), SamplingError> {
        self.completion_rx.await.unwrap_or_else(|_| {
            Err(SamplingError::Auth(
                "sampler actor dropped before completion".to_string(),
            ))
        })
    }
}

/// Cheaply-cloneable handle to the sampler actor.
///
/// Internally just an `mpsc::UnboundedSender<SamplerCommand>`. All
/// methods are non-blocking (fire-and-forget) except for the
/// `*_async` queries which return a future awaiting an
/// `oneshot::Receiver`.
#[derive(Clone)]
pub struct SamplerHandle {
    cmd_tx: mpsc::UnboundedSender<SamplerCommand>,
}

impl SamplerHandle {
    /// Construct a handle from a command sender. `pub(crate)` because
    /// only [`SamplerActor::spawn`](crate::actor::SamplerActor::spawn)
    /// produces one of these.
    pub(crate) fn new(cmd_tx: mpsc::UnboundedSender<SamplerCommand>) -> Self {
        Self { cmd_tx }
    }

    /// Create a no-op handle that discards all commands.
    ///
    /// Useful for tests and callers that need a `SamplerHandle` field
    /// before the actor is wired up. Mirrors
    /// [`HunkTrackerHandle::noop`](https://docs.rs/xai-hunk-tracker).
    pub fn noop() -> Self {
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel();
        // Receiver is dropped immediately; sends will fail but every
        // send-site uses `let _ = ...` so that is fine.
        Self { cmd_tx }
    }

    /// Submit a sampling request. Fire-and-forget -- results arrive
    /// via the shared event channel.
    pub fn submit(&self, request_id: RequestId, request: ConversationRequest) {
        let _ = self.cmd_tx.send(SamplerCommand::Submit {
            request_id,
            request: Box::new(request),
            config: None,
            broadcast_events: true,
            completion_tx: None,
        });
    }

    /// Submit a sampling request with an explicit per-request config
    /// override (e.g., a different model than the actor's default).
    pub fn submit_with_config(
        &self,
        request_id: RequestId,
        request: ConversationRequest,
        config: SamplerConfig,
    ) {
        let _ = self.cmd_tx.send(SamplerCommand::Submit {
            request_id,
            request: Box::new(request),
            config: Some(Box::new(config)),
            broadcast_events: true,
            completion_tx: None,
        });
    }

    /// Cancel an in-flight request. No-op if the request id is
    /// unknown (already finished or never submitted).
    pub fn cancel(&self, request_id: RequestId) {
        let _ = self.cmd_tx.send(SamplerCommand::Cancel { request_id });
    }

    /// Update the default sampling config (e.g., after model switch
    /// or auth refresh). The next request submitted without an
    /// override will use it.
    pub fn update_config(&self, config: SamplerConfig) {
        let _ = self.cmd_tx.send(SamplerCommand::UpdateConfig {
            config: Box::new(config),
        });
    }

    /// Query whether a request is still in flight. Returns `false`
    /// for unknown / finished / cancelled ids.
    pub async fn is_active(&self, request_id: RequestId) -> bool {
        let (reply_tx, reply_rx) = oneshot::channel();
        let _ = self.cmd_tx.send(SamplerCommand::IsActive {
            request_id,
            reply: reply_tx,
        });
        reply_rx.await.unwrap_or(false)
    }

    /// Query the number of in-flight requests. Returns 0 if the
    /// actor has been shut down.
    pub async fn active_count(&self) -> usize {
        let (reply_tx, reply_rx) = oneshot::channel();
        let _ = self
            .cmd_tx
            .send(SamplerCommand::ActiveCount { reply: reply_tx });
        reply_rx.await.unwrap_or(0)
    }

    /// Submit a request and await its completion. Events still flow
    /// to the shared channel for live UI updates -- this method just
    /// additionally awaits the per-request completion oneshot so the
    /// caller gets a clean `Result` without filtering events.
    ///
    /// Used by sequential callers like compaction / summary /
    /// `/btw` side questions.
    pub async fn submit_and_collect(
        &self,
        request_id: RequestId,
        request: ConversationRequest,
    ) -> Result<(ConversationResponse, InferenceLatencyStats), SamplingError> {
        self.begin_submit_and_collect(request_id, request)?
            .collect()
            .await
    }

    /// Enqueue a request and return as soon as the sampler actor command
    /// channel accepts it. No network completion is awaited here.
    pub fn begin_submit_and_collect(
        &self,
        request_id: RequestId,
        request: ConversationRequest,
    ) -> Result<PendingSamplingRequest, SamplingError> {
        self.begin_submit_and_collect_inner(request_id, request, None, true)
    }

    /// Enqueue a request with a per-request config and return the exact actor
    /// acceptance receipt used by AgentMesh360 bound-turn routing.
    pub fn begin_submit_and_collect_with_config(
        &self,
        request_id: RequestId,
        mut request: ConversationRequest,
        config: SamplerConfig,
    ) -> Result<PendingSamplingRequest, SamplingError> {
        // A bound per-request route owns the actual model identity. Session
        // request builders may already contain the ordinary Grok default;
        // leaving it intact would send that model to the leased endpoint while
        // the Host audit records `config.model`.
        request.model = Some(config.model.clone());
        self.begin_submit_and_collect_inner(request_id, request, Some(config), true)
    }

    /// Enqueue an auxiliary request with a per-request config without
    /// broadcasting its stream on the session's main event channel. The
    /// completion receipt still carries the full response and metrics.
    pub fn begin_side_query_and_collect_with_config(
        &self,
        request_id: RequestId,
        mut request: ConversationRequest,
        config: SamplerConfig,
    ) -> Result<PendingSamplingRequest, SamplingError> {
        request.model = Some(config.model.clone());
        self.begin_submit_and_collect_inner(request_id, request, Some(config), false)
    }

    fn begin_submit_and_collect_inner(
        &self,
        request_id: RequestId,
        request: ConversationRequest,
        config: Option<SamplerConfig>,
        broadcast_events: bool,
    ) -> Result<PendingSamplingRequest, SamplingError> {
        let (completion_tx, completion_rx) = oneshot::channel();
        let cancel_id = request_id.clone();
        self.cmd_tx
            .send(SamplerCommand::Submit {
                request_id,
                request: Box::new(request),
                config: config.map(Box::new),
                broadcast_events,
                completion_tx: Some(completion_tx),
            })
            .map_err(|_| {
                SamplingError::Auth("sampler actor dropped before submission".to_string())
            })?;
        Ok(PendingSamplingRequest {
            completion_rx,
            _cancel_on_drop: CancelOnDrop {
                cmd_tx: self.cmd_tx.clone(),
                request_id: cancel_id,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_fails_when_the_actor_command_channel_is_closed() {
        let handle = SamplerHandle::noop();
        let error = handle
            .begin_submit_and_collect(RequestId::random(), ConversationRequest::default())
            .expect_err("closed actor channel must reject submission");
        assert!(error.to_string().contains("before submission"));
    }

    #[tokio::test]
    async fn begin_returns_only_after_submit_is_enqueued_and_drop_cancels() {
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
        let handle = SamplerHandle::new(cmd_tx);
        let request_id = RequestId::random();
        let pending = handle
            .begin_submit_and_collect_with_config(
                request_id.clone(),
                ConversationRequest::default(),
                SamplerConfig {
                    model: "bound-model".into(),
                    ..SamplerConfig::default()
                },
            )
            .expect("actor accepts submit command");

        let command = cmd_rx.recv().await.expect("submit command");
        match command {
            SamplerCommand::Submit {
                request_id: accepted_id,
                config,
                completion_tx,
                ..
            } => {
                assert_eq!(accepted_id, request_id);
                assert_eq!(
                    config.as_ref().map(|config| config.model.as_str()),
                    Some("bound-model")
                );
                assert!(completion_tx.is_some());
            }
            _ => panic!("expected submit command"),
        }

        drop(pending);
        let cancel = cmd_rx.recv().await.expect("cancel command");
        assert!(matches!(
            cancel,
            SamplerCommand::Cancel { request_id: id } if id == request_id
        ));
    }
}
