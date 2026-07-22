use anyhow::{Context, Result};
use xai_grok_sampler::SamplerConfig;

use super::access::ClientAccessGuard;
use super::credential_lease::{CredentialLeaseResolver, LeasedSamplingRoute};
use super::credential_vault::{CredentialVault, RuntimeCredentialVault};
use super::model_routing::ModelRoutingService;
use super::session_bindings::SessionProviderBinding;
use super::turn_routes::{TurnRouteRecord, TurnRouteStore};

/// Host-side preparation for one product-agent turn.
///
/// The leased config and immutable Binding stay together until the caller's
/// submit function confirms actor acceptance. Only then can the trusted Turn
/// Route store be written.
pub struct BoundTurnSubmission {
    owner_account_id: i64,
    turn_id: String,
    leased_route: LeasedSamplingRoute,
    turn_routes: TurnRouteStore,
}

impl std::fmt::Debug for BoundTurnSubmission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundTurnSubmission")
            .field("owner_account_id", &self.owner_account_id)
            .field("turn_id", &self.turn_id)
            .field("leased_route", &self.leased_route)
            .finish()
    }
}

/// Submission receipt paired with the durable non-secret route audit record.
#[derive(Debug)]
pub struct AcceptedBoundTurn<T> {
    pub accepted: T,
    pub turn_route: TurnRouteRecord,
    active: ActiveBoundTurn,
}

impl<T> AcceptedBoundTurn<T> {
    pub fn into_active(self) -> (T, ActiveBoundTurn) {
        (self.accepted, self.active)
    }
}

/// Reusable, non-serializable routing authority for the remaining model calls
/// inside one Prompt turn. It never re-resolves Assignment/Profile state and
/// never writes a second Turn Route record.
pub struct ActiveBoundTurn {
    sampler_config: SamplerConfig,
    turn_route: TurnRouteRecord,
}

impl std::fmt::Debug for ActiveBoundTurn {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ActiveBoundTurn")
            .field("turn_route", &self.turn_route)
            .field("sampler_config", &self.sampler_config)
            .finish()
    }
}

impl ActiveBoundTurn {
    pub fn submit_again<T>(&self, submit: impl FnOnce(SamplerConfig) -> Result<T>) -> Result<T> {
        submit(self.sampler_config.clone()).context("resubmit active bound turn")
    }

    pub fn turn_route(&self) -> &TurnRouteRecord {
        &self.turn_route
    }

    #[cfg(test)]
    fn sampler_config(&self) -> &SamplerConfig {
        &self.sampler_config
    }
}

pub struct TurnSubmissionCoordinator {
    turn_routes: TurnRouteStore,
}

/// Trusted, non-secret route identity injected by `MvpAgent` after it verifies
/// the Registry owner. The access guard shares the live subscription state;
/// serde clients cannot construct this type.
#[derive(Clone, Debug)]
pub struct AgentMeshSessionRouteContext {
    owner_account_id: i64,
    agent_id: String,
    role: String,
    access: ClientAccessGuard,
    state_home: std::path::PathBuf,
    vault: RuntimeCredentialVault,
}

impl AgentMeshSessionRouteContext {
    pub(super) fn new(
        owner_account_id: i64,
        agent_id: String,
        access: ClientAccessGuard,
        state_home: std::path::PathBuf,
        vault: RuntimeCredentialVault,
    ) -> Self {
        Self {
            owner_account_id,
            agent_id,
            role: "main".into(),
            access,
            state_home,
            vault,
        }
    }

    pub fn prepare_turn(&self, session_id: &str, turn_id: &str) -> Result<ProductTurnRoute> {
        self.access
            .require()
            .map_err(|_| anyhow::anyhow!("AgentMesh360 subscription access is unavailable"))?;
        ModelRoutingService::in_home(&self.state_home).ensure_product_binding(
            self.owner_account_id,
            session_id,
            &self.agent_id,
            &self.role,
        )?;
        let resolver = CredentialLeaseResolver::in_home(&self.state_home, self.vault.clone());
        let prepared = TurnSubmissionCoordinator::in_home(&self.state_home).prepare(
            &resolver,
            self.owner_account_id,
            session_id,
            &self.role,
            turn_id,
        )?;
        Ok(ProductTurnRoute::Prepared(Some(Box::new(prepared))))
    }
}

/// State machine for every model call within one product-agent Prompt turn.
pub enum ProductTurnRoute {
    Prepared(Option<Box<BoundTurnSubmission>>),
    Active(Box<ActiveBoundTurn>),
}

impl std::fmt::Debug for ProductTurnRoute {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Prepared(prepared) => formatter
                .debug_tuple("ProductTurnRoute::Prepared")
                .field(prepared)
                .finish(),
            Self::Active(active) => formatter
                .debug_tuple("ProductTurnRoute::Active")
                .field(active)
                .finish(),
        }
    }
}

impl ProductTurnRoute {
    pub fn submit<T>(&mut self, submit: impl FnOnce(SamplerConfig) -> Result<T>) -> Result<T> {
        match self {
            Self::Prepared(prepared) => {
                let prepared = prepared
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("bound turn submission is unavailable"))?;
                let accepted = prepared.submit(submit)?;
                let (receipt, active) = accepted.into_active();
                *self = Self::Active(Box::new(active));
                Ok(receipt)
            }
            Self::Active(active) => active.submit_again(submit),
        }
    }
}

impl Default for TurnSubmissionCoordinator {
    fn default() -> Self {
        Self::in_home(super::state::default_state_home())
    }
}

impl TurnSubmissionCoordinator {
    pub fn in_home(state_home: impl Into<std::path::PathBuf>) -> Self {
        Self {
            turn_routes: TurnRouteStore::in_home(state_home),
        }
    }

    pub fn prepare<V: CredentialVault>(
        &self,
        resolver: &CredentialLeaseResolver<V>,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
        turn_id: impl Into<String>,
    ) -> Result<BoundTurnSubmission> {
        let leased_route = resolver.resolve(owner_account_id, session_id, role)?;
        Ok(BoundTurnSubmission {
            owner_account_id,
            turn_id: turn_id.into(),
            leased_route,
            turn_routes: self.turn_routes.clone(),
        })
    }
}

impl BoundTurnSubmission {
    /// Invoke the exact Sampling-actor acceptance operation and persist the
    /// route only if it succeeds. If persistence then fails, `accepted` is
    /// dropped; D1c passes `PendingSamplingRequest`, whose Drop cancels it.
    pub fn submit<T>(
        self,
        submit: impl FnOnce(SamplerConfig) -> Result<T>,
    ) -> Result<AcceptedBoundTurn<T>> {
        let (sampler_config, binding) = self.leased_route.into_parts();
        self.turn_routes
            .validate_submission(self.owner_account_id, &self.turn_id, &binding)?;
        let active_config = sampler_config.clone();
        let accepted = submit(sampler_config).context("submit bound turn to Sampling actor")?;
        let turn_route = self
            .turn_routes
            .record_submitted(self.owner_account_id, &self.turn_id, &binding)
            .context("record accepted bound turn route")?;
        Ok(AcceptedBoundTurn {
            accepted,
            turn_route: turn_route.clone(),
            active: ActiveBoundTurn {
                sampler_config: active_config,
                turn_route,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;
    use crate::agentmesh360::credential_vault::{
        CredentialRef, MemoryCredentialVault, SecretValue,
    };
    use crate::agentmesh360::model_routing::PreparedRoute;
    use crate::agentmesh360::provider_catalog::{ModelCapability, ProviderClassification};
    use crate::agentmesh360::provider_profiles::{
        ProviderAuthKind, ProviderProfileInput, ProviderProfileStore, ProviderProtocol,
    };
    use crate::agentmesh360::session_bindings::{BindingChangeReason, SessionBindingStore};

    const ACCOUNT_ID: i64 = 41;
    const SECRET: &str = "sentinel-turn-secret-1234";

    fn route(profile_revision: u64, endpoint: &str) -> PreparedRoute {
        PreparedRoute {
            provider_profile_id: "pp_turn".into(),
            provider_preset_id: None,
            provider_display_name: "Turn Provider".into(),
            endpoint_classification: ProviderClassification::Custom,
            endpoint_origin: endpoint.trim_end_matches("/v1").into(),
            protocol: ProviderProtocol::OpenaiResponses,
            base_url: endpoint.into(),
            auth_kind: ProviderAuthKind::BearerApiKey,
            model_id: "turn-model".into(),
            profile_route_revision: profile_revision,
            assignment_id: "ma_turn".into(),
            assignment_revision: profile_revision,
            catalog_revision: 1,
            capability: ModelCapability::unknown(),
            quirks: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn setup() -> (
        tempfile::TempDir,
        CredentialLeaseResolver<MemoryCredentialVault>,
        TurnSubmissionCoordinator,
        SessionBindingStore,
    ) {
        setup_with_base_url("https://turn.example/v1")
    }

    fn setup_with_base_url(
        base_url: &str,
    ) -> (
        tempfile::TempDir,
        CredentialLeaseResolver<MemoryCredentialVault>,
        TurnSubmissionCoordinator,
        SessionBindingStore,
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let credential_ref = CredentialRef::generate();
        let vault = MemoryCredentialVault::default();
        vault
            .put(
                &credential_ref,
                &SecretValue::new(SECRET.into()).expect("secret"),
            )
            .expect("store secret");
        ProviderProfileStore::in_home(temp.path())
            .insert(
                ACCOUNT_ID,
                "pp_turn",
                credential_ref.as_str(),
                "1234",
                &ProviderProfileInput {
                    preset_id: None,
                    display_name: "Turn Provider".into(),
                    protocol: ProviderProtocol::OpenaiResponses,
                    base_url: base_url.into(),
                    auth_kind: ProviderAuthKind::BearerApiKey,
                    enabled_models: vec!["turn-model".into()],
                }
                .normalized()
                .expect("profile input"),
            )
            .expect("profile");
        let bindings = SessionBindingStore::in_home(temp.path());
        bindings
            .bind_initial(
                ACCOUNT_ID,
                "session-turn",
                "main",
                Some("job-agent"),
                &route(1, base_url),
            )
            .expect("binding");
        let resolver = CredentialLeaseResolver::in_home(temp.path(), vault);
        let coordinator = TurnSubmissionCoordinator::in_home(temp.path());
        (temp, resolver, coordinator, bindings)
    }

    fn route_history(temp: &tempfile::TempDir) -> Vec<TurnRouteRecord> {
        TurnRouteStore::in_home(temp.path())
            .list_session(ACCOUNT_ID, "session-turn", "main")
            .expect("route history")
    }

    #[test]
    fn records_only_after_the_submitter_accepts_the_turn() {
        let (temp, resolver, coordinator, _) = setup();
        let called = Rc::new(Cell::new(false));
        let called_by_submitter = Rc::clone(&called);
        let prepared = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-1")
            .expect("prepare");
        assert!(route_history(&temp).is_empty());

        let accepted = prepared
            .submit(move |config| {
                called_by_submitter.set(true);
                assert!(config.api_key.is_none());
                assert!(config.bearer_resolver.is_some());
                Ok("actor-accepted")
            })
            .expect("submit and record");

        assert!(called.get());
        assert_eq!(accepted.accepted, "actor-accepted");
        assert_eq!(accepted.turn_route.turn_id, "turn-1");
        assert_eq!(route_history(&temp).len(), 1);
    }

    #[test]
    fn submitter_failure_never_creates_a_ghost_turn() {
        let (temp, resolver, coordinator, _) = setup();
        let prepared = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-failed")
            .expect("prepare");

        let error = prepared
            .submit::<()>(|_| anyhow::bail!("actor rejected submit"))
            .expect_err("rejected submit must fail");
        assert!(error.to_string().contains("submit bound turn"));
        assert!(route_history(&temp).is_empty());
    }

    #[test]
    fn same_binding_retry_is_idempotent() {
        let (temp, resolver, coordinator, _) = setup();
        let first = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-retry")
            .expect("first prepare")
            .submit(|_| Ok("first"))
            .expect("first submit");
        let second = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-retry")
            .expect("retry prepare")
            .submit(|_| Ok("retry"))
            .expect("retry submit");

        assert_eq!(
            first.turn_route.turn_route_id,
            second.turn_route.turn_route_id
        );
        assert_eq!(route_history(&temp).len(), 1);
    }

    #[test]
    fn conflicting_binding_is_rejected_before_submitter_runs() {
        let (temp, resolver, coordinator, bindings) = setup();
        coordinator
            .prepare(
                &resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-conflict",
            )
            .expect("prepare first binding")
            .submit(|_| Ok(()))
            .expect("record first binding");
        bindings
            .append(
                ACCOUNT_ID,
                "session-turn",
                "main",
                Some("job-agent"),
                BindingChangeReason::ExplicitSwitch,
                &route(1, "https://turn.example/v1"),
            )
            .expect("append Binding revision");
        let called = Cell::new(false);

        let error = coordinator
            .prepare(
                &resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-conflict",
            )
            .expect("prepare conflicting binding")
            .submit::<()>(|_| {
                called.set(true);
                Ok(())
            })
            .expect_err("different Binding must not replace a Turn");

        assert!(!called.get());
        assert!(error.to_string().contains("different Binding revision"));
        assert_eq!(route_history(&temp).len(), 1);
    }

    #[test]
    fn preparation_failure_never_calls_the_submitter() {
        let (temp, _resolver, coordinator, _) = setup();
        let empty_resolver =
            CredentialLeaseResolver::in_home(temp.path(), MemoryCredentialVault::default());

        let error = coordinator
            .prepare(
                &empty_resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-missing-secret",
            )
            .expect_err("missing secret must fail before a submission exists");
        assert!(error.to_string().contains("credential is unavailable"));
        assert!(route_history(&temp).is_empty());
    }

    #[test]
    fn active_turn_reuses_one_binding_without_writing_more_records() {
        let (temp, resolver, coordinator, _) = setup();
        let first = coordinator
            .prepare(
                &resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-multi-call",
            )
            .expect("prepare")
            .submit(|config| {
                assert_eq!(config.model, "turn-model");
                Ok("first-accepted")
            })
            .expect("first submit");
        let (receipt, active) = first.into_active();
        assert_eq!(receipt, "first-accepted");

        let tool_follow_up = active
            .submit_again(|config| Ok((config.model, config.api_backend)))
            .expect("tool follow-up");
        let auth_retry = active
            .submit_again(|config| Ok((config.base_url, config.auth_scheme)))
            .expect("auth retry");

        assert_eq!(tool_follow_up.0, "turn-model");
        assert_eq!(
            tool_follow_up.1,
            xai_grok_sampling_types::ApiBackend::Responses
        );
        assert_eq!(auth_retry.0, "https://turn.example/v1");
        assert_eq!(auth_retry.1, xai_grok_sampler::AuthScheme::Bearer);
        assert_eq!(active.turn_route().turn_id, "turn-multi-call");
        assert_eq!(route_history(&temp).len(), 1);

        let serialized =
            serde_json::to_string(active.sampler_config()).expect("serialize sampler config");
        let debug = format!("{active:?}");
        assert!(!serialized.contains(SECRET));
        assert!(!debug.contains(SECRET));
        assert!(active.sampler_config().api_key.is_none());
        assert!(active.sampler_config().bearer_resolver.is_some());
    }

    #[test]
    fn product_turn_state_machine_promotes_once_then_reuses_active_route() {
        let (temp, resolver, coordinator, _) = setup();
        let prepared = coordinator
            .prepare(
                &resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-state-machine",
            )
            .expect("prepare");
        let mut route = ProductTurnRoute::Prepared(Some(Box::new(prepared)));

        let first = route
            .submit(|config| Ok(config.model))
            .expect("first actor acceptance");
        let second = route
            .submit(|config| Ok(config.model))
            .expect("same-turn follow-up");

        assert_eq!(first, "turn-model");
        assert_eq!(second, "turn-model");
        assert!(matches!(route, ProductTurnRoute::Active(_)));
        assert_eq!(route_history(&temp).len(), 1);
        assert!(!format!("{route:?}").contains(SECRET));
    }

    #[tokio::test]
    async fn real_sampler_actor_acceptance_writes_route_before_provider_result() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock Provider");
        let address = listener.local_addr().expect("mock address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let mut bytes = vec![0; 16 * 1024];
            let read = stream.read(&mut bytes).await.expect("read request");
            let request = String::from_utf8_lossy(&bytes[..read]).to_string();
            let body = r#"{"error":{"message":"rejected by mock"}}"#;
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            request
        });
        let base_url = format!("http://{address}/v1");
        let (temp, resolver, coordinator, _) = setup_with_base_url(&base_url);
        let prepared = coordinator
            .prepare(
                &resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-real-actor",
            )
            .expect("prepare bound route");
        let mut route = ProductTurnRoute::Prepared(Some(Box::new(prepared)));
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = xai_grok_sampler::SamplerActor::spawn(
            SamplerConfig::default(),
            xai_grok_sampler::RetryPolicy {
                max_retries: 0,
                rate_limit_retry_threshold: 0,
            },
            event_tx,
        );

        let request = xai_grok_sampling_types::ConversationRequest {
            model: Some("stale-session-model".into()),
            ..Default::default()
        };
        let pending = route
            .submit(|config| {
                handle
                    .begin_submit_and_collect_with_config(
                        xai_grok_sampler::RequestId::random(),
                        request,
                        config,
                    )
                    .map_err(anyhow::Error::new)
            })
            .expect("sampler actor accepts request");
        assert_eq!(route_history(&temp).len(), 1);

        let provider_error = pending.collect().await.expect_err("mock returns 401");
        assert!(provider_error.to_string().contains("Unauthorized"));
        let request = server.await.expect("mock Provider task");
        assert!(request.starts_with("POST /v1/responses HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains(&format!("authorization: bearer {SECRET}").to_ascii_lowercase())
        );
        assert!(request.contains("\"model\":\"turn-model\""));
        assert!(!request.contains("stale-session-model"));
        assert_eq!(route_history(&temp)[0].turn_id, "turn-real-actor");
    }
}
