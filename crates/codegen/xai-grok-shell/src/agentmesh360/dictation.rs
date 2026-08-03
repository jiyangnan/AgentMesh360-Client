//! Account-scoped desktop dictation backed by the existing Grok voice pipeline.
//!
//! Security/product boundaries:
//! - microphone audio streams directly from this Host process to the selected
//!   xAI STT endpoint; it is never serialized into AgentMesh360 state or logs;
//! - the Provider secret is leased from the Host-owned credential vault and is
//!   never included in an ACP response/notification;
//! - a final transcript is projected as editable text only. This module never
//!   submits a prompt or starts a model turn.

use std::future::{Future, ready};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol as acp;
use anyhow::{Context, Result, anyhow, bail};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use url::Url;
use uuid::Uuid;
use xai_acp_lib::AcpAgentGatewaySender;
use xai_grok_voice::{
    SharedVoiceAuth, VoiceAuthProvider, VoiceCommand, VoiceConfig, VoiceEvent, run_voice_pipeline,
};

use crate::agent::MvpAgent;

use super::credential_vault::{CredentialRef, CredentialVault, SecretValue};
use super::model_assignments::ModelAssignmentStore;
use super::provider_profiles::{ProviderAuthKind, ProviderProfileRecord, ProviderProfileStore};

pub const STATUS_METHOD: &str = "x.agentmesh360/dictation/status";
pub const START_METHOD: &str = "x.agentmesh360/dictation/start";
pub const STOP_METHOD: &str = "x.agentmesh360/dictation/stop";
pub const CANCEL_METHOD: &str = "x.agentmesh360/dictation/cancel";
pub const CHANGED_METHOD: &str = "x.agentmesh360/dictation/changed";

pub const DISCLOSURE: &str = "录音会发送给你选择的听写服务进行转写；听写结果不会自动发送。";
pub const MAX_DURATION_SECONDS: u64 = 60;
pub const MAX_AUDIO_BYTES: u64 = 16_000 * 2 * MAX_DURATION_SECONDS;
const TRANSCRIPT_MAX_CHARS: usize = 20_000;
const FINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Debug, Default)]
pub struct DictationService {
    inner: Arc<Mutex<DictationState>>,
}

#[derive(Debug, Default)]
struct DictationState {
    revision: u64,
    active: Option<ActiveDictation>,
}

#[derive(Debug)]
struct ActiveDictation {
    owner_account_id: i64,
    agent_id: String,
    dictation_id: String,
    phase: DictationPhase,
    interim_text: String,
    transcript: String,
    error: Option<DictationError>,
    service: PublicService,
    command_tx: mpsc::Sender<VoiceCommand>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DictationPhase {
    Idle,
    Starting,
    Listening,
    Transcribing,
    Complete,
    Error,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DictationError {
    code: String,
    message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PublicService {
    provider_profile_id: String,
    display_name: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DictationLimits {
    max_duration_seconds: u64,
    max_audio_bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictationSnapshot {
    revision: u64,
    phase: DictationPhase,
    dictation_id: Option<String>,
    agent_id: String,
    interim_text: String,
    transcript: String,
    error: Option<DictationError>,
    service: Option<PublicService>,
    limits: DictationLimits,
    disclosure: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusRequest {
    agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRequest {
    agent_id: String,
    disclosure_accepted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MutationRequest {
    dictation_id: String,
}

struct VoiceRoute {
    config: VoiceConfig,
    auth: SharedVoiceAuth,
    service: PublicService,
}

struct VaultVoiceAuth(SecretValue);

impl std::fmt::Debug for VaultVoiceAuth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("VaultVoiceAuth([REDACTED])")
    }
}

impl VoiceAuthProvider for VaultVoiceAuth {
    fn bearer(&self) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        // The WebSocket library needs an owned Authorization header. The source
        // remains a zeroizing vault value and neither copy is serialized/logged.
        let bearer = std::str::from_utf8(self.0.as_bytes())
            .ok()
            .map(str::to_owned);
        Box::pin(ready(bearer))
    }
}

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        STATUS_METHOD | START_METHOD | STOP_METHOD | CANCEL_METHOD
    )
}

pub async fn handle(agent: &MvpAgent, args: &acp::ExtRequest) -> crate::extensions::ExtResult {
    let owner_account_id = super::current_account_id(agent)
        .map_err(|_| acp::Error::auth_required().data("AgentMesh360 access is unavailable"))?;
    let snapshot = match args.method.as_ref() {
        STATUS_METHOD => {
            let request: StatusRequest = crate::extensions::parse_params(args)?;
            agent
                .agentmesh360
                .dictation
                .snapshot(owner_account_id, &request.agent_id)
        }
        START_METHOD => {
            let request: StartRequest = crate::extensions::parse_params(args)?;
            start(agent, owner_account_id, request).await
        }
        STOP_METHOD => {
            let request: MutationRequest = crate::extensions::parse_params(args)?;
            stop(agent, owner_account_id, &request.dictation_id)
        }
        CANCEL_METHOD => {
            let request: MutationRequest = crate::extensions::parse_params(args)?;
            cancel(agent, owner_account_id, &request.dictation_id)
        }
        _ => unreachable!("dictation method was pre-filtered"),
    };
    crate::extensions::to_ext_response(Ok(snapshot))
}

async fn start(
    agent: &MvpAgent,
    owner_account_id: i64,
    request: StartRequest,
) -> DictationSnapshot {
    let agent_id = request.agent_id.trim().to_owned();
    if agent_id.is_empty() || agent_id.len() > 200 || agent_id.chars().any(char::is_control) {
        return error_snapshot(
            0,
            agent_id,
            "invalid_dictation_request",
            "无法开始听写，请重新打开当前 Agent 后再试。",
        );
    }
    if !request.disclosure_accepted {
        return error_snapshot(
            0,
            agent_id,
            "dictation_disclosure_required",
            "请先确认录音会交给所选听写服务进行转写。",
        );
    }

    {
        let mut state = agent.agentmesh360.dictation.inner.lock();
        if let Some(active) = state.active.as_ref()
            && active.phase != DictationPhase::Complete
            && active.phase != DictationPhase::Error
        {
            if active.owner_account_id == owner_account_id && active.agent_id == agent_id {
                return active_snapshot(state.revision, active);
            }
            return error_snapshot(
                state.revision,
                agent_id,
                "dictation_busy",
                "已有一段听写正在进行，请先停止或取消。",
            );
        }
        // A completed/error result has already been returned to the client and
        // must not block a new recording. Starting a new one discards it.
        state.active = None;
    }

    let route = match resolve_voice_route(agent, owner_account_id, &agent_id) {
        Ok(route) => route,
        Err(_) => {
            let snapshot = error_snapshot(
                agent.agentmesh360.dictation.revision(),
                agent_id,
                "dictation_provider_required",
                "需要配置支持听写的模型供应商。",
            );
            emit_changed(agent, &snapshot);
            return snapshot;
        }
    };

    let dictation_id = format!("dict_{}", Uuid::new_v4().simple());
    let (command_tx, command_rx) = mpsc::channel(4);
    let (event_tx, event_rx) = mpsc::channel(32);
    let service = agent.agentmesh360.dictation.clone();
    let gateway = agent.gateway.clone();
    let collector_id = dictation_id.clone();
    tokio::spawn(run_voice_pipeline(
        route.config,
        route.auth,
        command_rx,
        event_tx,
    ));
    tokio::spawn(async move {
        collect_voice_events(service, gateway, collector_id, event_rx).await;
    });

    let snapshot = {
        let mut state = agent.agentmesh360.dictation.inner.lock();
        state.revision = state.revision.saturating_add(1);
        state.active = Some(ActiveDictation {
            owner_account_id,
            agent_id,
            dictation_id: dictation_id.clone(),
            phase: DictationPhase::Starting,
            interim_text: String::new(),
            transcript: String::new(),
            error: None,
            service: route.service,
            command_tx: command_tx.clone(),
        });
        active_snapshot(
            state.revision,
            state.active.as_ref().expect("inserted dictation"),
        )
    };
    emit_changed(agent, &snapshot);

    if command_tx.send(VoiceCommand::PttPress).await.is_err() {
        let snapshot = agent.agentmesh360.dictation.fail_active(
            &dictation_id,
            "dictation_unavailable",
            "听写服务暂时不可用，请稍后重试。",
        );
        emit_changed(agent, &snapshot);
        return snapshot;
    }

    let snapshot = agent.agentmesh360.dictation.set_listening(&dictation_id);
    emit_changed(agent, &snapshot);
    spawn_duration_limit(
        agent.agentmesh360.dictation.clone(),
        agent.gateway.clone(),
        dictation_id,
    );
    snapshot
}

fn stop(agent: &MvpAgent, owner_account_id: i64, dictation_id: &str) -> DictationSnapshot {
    let (snapshot, command_tx, should_wait) = agent
        .agentmesh360
        .dictation
        .begin_stop(owner_account_id, dictation_id);
    if let Some(command_tx) = command_tx {
        let _ = command_tx.try_send(VoiceCommand::PttRelease);
    }
    emit_changed(agent, &snapshot);
    if should_wait {
        spawn_final_timeout(
            agent.agentmesh360.dictation.clone(),
            agent.gateway.clone(),
            dictation_id.to_owned(),
        );
    }
    snapshot
}

fn cancel(agent: &MvpAgent, owner_account_id: i64, dictation_id: &str) -> DictationSnapshot {
    let (snapshot, command_tx) = agent
        .agentmesh360
        .dictation
        .cancel(owner_account_id, dictation_id);
    if let Some(command_tx) = command_tx {
        let _ = command_tx.try_send(VoiceCommand::Shutdown);
    }
    emit_changed(agent, &snapshot);
    snapshot
}

fn resolve_voice_route(
    agent: &MvpAgent,
    owner_account_id: i64,
    agent_id: &str,
) -> Result<VoiceRoute> {
    let record = agent
        .agentmesh360
        .registry
        .get(owner_account_id, agent_id)
        .context("resolve dictation Agent")?;
    if record.desired_state != "running" || record.main_session_id.is_none() {
        bail!("dictation Agent is not active");
    }
    let session_id = record.main_session_id.as_deref();
    let assignment = ModelAssignmentStore::in_home(&agent.agentmesh360.state_home)
        .resolve(owner_account_id, "main", Some(agent_id), session_id)
        .ok();
    let profiles =
        ProviderProfileStore::in_home(&agent.agentmesh360.state_home).list(owner_account_id)?;
    let mut candidates = profiles
        .into_iter()
        .filter(is_official_xai_voice_profile)
        .collect::<Vec<_>>();
    let selected = assignment
        .and_then(|assignment| {
            candidates
                .iter()
                .position(|profile| profile.profile_id == assignment.provider_profile_id)
                .map(|index| candidates.remove(index))
        })
        .or_else(|| (candidates.len() == 1).then(|| candidates.remove(0)))
        .ok_or_else(|| anyhow!("no unambiguous xAI voice Provider is configured"))?;
    let credential_ref = CredentialRef::parse(selected.credential_ref.clone())
        .context("xAI Provider credential handle is invalid")?;
    let secret = agent
        .agentmesh360
        .credential_vault
        .get(&credential_ref)
        .context("xAI Provider credential is unavailable")?;
    let mut config = VoiceConfig {
        api_base: selected.base_url.clone(),
        language: "auto".into(),
        ..VoiceConfig::default()
    };
    // Validate TLS/deduplication before opening the mic. This also prevents a
    // malformed profile from receiving a credential.
    config.stt_ws_url()?;
    config.client_identifier = "agentmesh360-desktop".into();
    config.user_agent = "AgentMesh360 Desktop".into();
    Ok(VoiceRoute {
        config,
        auth: Arc::new(VaultVoiceAuth(secret)),
        service: PublicService {
            provider_profile_id: selected.profile_id,
            display_name: selected.display_name,
        },
    })
}

fn is_official_xai_voice_profile(profile: &ProviderProfileRecord) -> bool {
    if profile.preset_id.as_deref() != Some("xai")
        || profile.auth_kind != ProviderAuthKind::BearerApiKey
        || !profile.credential_configured
    {
        return false;
    }
    let Ok(url) = Url::parse(&profile.base_url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("api.x.ai")
        && url.port_or_known_default() == Some(443)
}

async fn collect_voice_events(
    service: DictationService,
    gateway: AcpAgentGatewaySender,
    dictation_id: String,
    mut event_rx: mpsc::Receiver<VoiceEvent>,
) {
    while let Some(event) = event_rx.recv().await {
        let snapshot = service.apply_event(&dictation_id, event);
        if let Some(snapshot) = snapshot {
            emit_changed_with_gateway(&gateway, &snapshot);
        }
    }
}

fn spawn_duration_limit(
    service: DictationService,
    gateway: AcpAgentGatewaySender,
    dictation_id: String,
) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(MAX_DURATION_SECONDS)).await;
        let (snapshot, command_tx, should_wait) = service.begin_stop_any(&dictation_id);
        if let Some(command_tx) = command_tx {
            let _ = command_tx.try_send(VoiceCommand::PttRelease);
        }
        if let Some(snapshot) = snapshot {
            emit_changed_with_gateway(&gateway, &snapshot);
        }
        if should_wait {
            spawn_final_timeout(service, gateway, dictation_id);
        }
    });
}

fn spawn_final_timeout(
    service: DictationService,
    gateway: AcpAgentGatewaySender,
    dictation_id: String,
) {
    tokio::spawn(async move {
        tokio::time::sleep(FINAL_DRAIN_TIMEOUT).await;
        if let Some(snapshot) = service.finish_after_timeout(&dictation_id) {
            emit_changed_with_gateway(&gateway, &snapshot);
        }
    });
}

fn emit_changed(agent: &MvpAgent, snapshot: &DictationSnapshot) {
    emit_changed_with_gateway(&agent.gateway, snapshot);
}

fn emit_changed_with_gateway(gateway: &AcpAgentGatewaySender, snapshot: &DictationSnapshot) {
    if let Ok(raw) = serde_json::value::to_raw_value(snapshot) {
        gateway.forward_fire_and_forget(acp::ExtNotification::new(CHANGED_METHOD, Arc::from(raw)));
    }
}

impl DictationService {
    fn revision(&self) -> u64 {
        self.inner.lock().revision
    }

    fn snapshot(&self, owner_account_id: i64, agent_id: &str) -> DictationSnapshot {
        let state = self.inner.lock();
        match state.active.as_ref() {
            Some(active)
                if active.owner_account_id == owner_account_id && active.agent_id == agent_id =>
            {
                active_snapshot(state.revision, active)
            }
            _ => idle_snapshot(state.revision, agent_id.to_owned()),
        }
    }

    fn set_listening(&self, dictation_id: &str) -> DictationSnapshot {
        let mut state = self.inner.lock();
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let Some(active) = state
            .active
            .as_mut()
            .filter(|active| active.dictation_id == dictation_id)
        else {
            return idle_snapshot(revision, String::new());
        };
        active.phase = DictationPhase::Listening;
        active_snapshot(revision, active)
    }

    fn fail_active(&self, dictation_id: &str, code: &str, message: &str) -> DictationSnapshot {
        let mut state = self.inner.lock();
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let Some(active) = state
            .active
            .as_mut()
            .filter(|active| active.dictation_id == dictation_id)
        else {
            return idle_snapshot(revision, String::new());
        };
        active.phase = DictationPhase::Error;
        active.interim_text.clear();
        active.error = Some(DictationError {
            code: code.into(),
            message: message.into(),
        });
        active_snapshot(revision, active)
    }

    fn begin_stop(
        &self,
        owner_account_id: i64,
        dictation_id: &str,
    ) -> (DictationSnapshot, Option<mpsc::Sender<VoiceCommand>>, bool) {
        let mut state = self.inner.lock();
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let Some(active) = state.active.as_mut().filter(|active| {
            active.owner_account_id == owner_account_id && active.dictation_id == dictation_id
        }) else {
            return (
                error_snapshot(
                    revision,
                    String::new(),
                    "dictation_not_found",
                    "这段听写已经结束，请重新开始。",
                ),
                None,
                false,
            );
        };
        let should_wait = matches!(
            active.phase,
            DictationPhase::Starting | DictationPhase::Listening
        );
        if should_wait {
            active.phase = DictationPhase::Transcribing;
            active.interim_text.clear();
        }
        (
            active_snapshot(revision, active),
            should_wait.then(|| active.command_tx.clone()),
            should_wait,
        )
    }

    fn begin_stop_any(
        &self,
        dictation_id: &str,
    ) -> (
        Option<DictationSnapshot>,
        Option<mpsc::Sender<VoiceCommand>>,
        bool,
    ) {
        let mut state = self.inner.lock();
        if !state
            .active
            .as_ref()
            .is_some_and(|active| active.dictation_id == dictation_id)
        {
            return (None, None, false);
        }
        if !matches!(
            state.active.as_ref().map(|active| active.phase),
            Some(DictationPhase::Starting | DictationPhase::Listening)
        ) {
            return (None, None, false);
        }
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let active = state.active.as_mut().expect("checked active dictation");
        active.phase = DictationPhase::Transcribing;
        active.interim_text.clear();
        let command_tx = active.command_tx.clone();
        (
            Some(active_snapshot(revision, active)),
            Some(command_tx),
            true,
        )
    }

    fn cancel(
        &self,
        owner_account_id: i64,
        dictation_id: &str,
    ) -> (DictationSnapshot, Option<mpsc::Sender<VoiceCommand>>) {
        let mut state = self.inner.lock();
        let Some(active) = state.active.as_ref().filter(|active| {
            active.owner_account_id == owner_account_id && active.dictation_id == dictation_id
        }) else {
            return (
                error_snapshot(
                    state.revision,
                    String::new(),
                    "dictation_not_found",
                    "这段听写已经结束，请重新开始。",
                ),
                None,
            );
        };
        let command_tx = active.command_tx.clone();
        let agent_id = active.agent_id.clone();
        state.active = None;
        state.revision = state.revision.saturating_add(1);
        (idle_snapshot(state.revision, agent_id), Some(command_tx))
    }

    fn apply_event(&self, dictation_id: &str, event: VoiceEvent) -> Option<DictationSnapshot> {
        let mut state = self.inner.lock();
        if !state
            .active
            .as_ref()
            .is_some_and(|active| active.dictation_id == dictation_id)
        {
            return None;
        }
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let active = state.active.as_mut().expect("checked active dictation");
        match event {
            VoiceEvent::InterimTranscript { text } => {
                if !matches!(
                    active.phase,
                    DictationPhase::Starting | DictationPhase::Listening
                ) {
                    return None;
                }
                active.phase = DictationPhase::Listening;
                active.interim_text = limited_text(&text);
            }
            VoiceEvent::UtteranceFinal { text } => {
                append_final(&mut active.transcript, &text);
                active.interim_text.clear();
                if active.phase == DictationPhase::Transcribing {
                    active.phase = DictationPhase::Complete;
                }
            }
            VoiceEvent::Error { message } => {
                let error = public_voice_error(&message);
                active.phase = DictationPhase::Error;
                active.interim_text.clear();
                active.error = Some(error);
            }
        }
        Some(active_snapshot(revision, active))
    }

    fn finish_after_timeout(&self, dictation_id: &str) -> Option<DictationSnapshot> {
        let mut state = self.inner.lock();
        if !state.active.as_ref().is_some_and(|active| {
            active.dictation_id == dictation_id && active.phase == DictationPhase::Transcribing
        }) {
            return None;
        }
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let active = state.active.as_mut().expect("checked active dictation");
        if active.transcript.trim().is_empty() {
            active.phase = DictationPhase::Error;
            active.error = Some(DictationError {
                code: "dictation_no_speech".into(),
                message: "没有识别到语音，请检查麦克风权限后重试。".into(),
            });
        } else {
            active.phase = DictationPhase::Complete;
        }
        Some(active_snapshot(revision, active))
    }

    pub fn cancel_all(&self) -> bool {
        let mut state = self.inner.lock();
        let Some(active) = state.active.take() else {
            return false;
        };
        let _ = active.command_tx.try_send(VoiceCommand::Shutdown);
        state.revision = state.revision.saturating_add(1);
        true
    }
}

fn active_snapshot(revision: u64, active: &ActiveDictation) -> DictationSnapshot {
    DictationSnapshot {
        revision,
        phase: active.phase,
        dictation_id: Some(active.dictation_id.clone()),
        agent_id: active.agent_id.clone(),
        interim_text: active.interim_text.clone(),
        transcript: active.transcript.clone(),
        error: active.error.clone(),
        service: Some(active.service.clone()),
        limits: limits(),
        disclosure: DISCLOSURE,
    }
}

fn idle_snapshot(revision: u64, agent_id: String) -> DictationSnapshot {
    DictationSnapshot {
        revision,
        phase: DictationPhase::Idle,
        dictation_id: None,
        agent_id,
        interim_text: String::new(),
        transcript: String::new(),
        error: None,
        service: None,
        limits: limits(),
        disclosure: DISCLOSURE,
    }
}

fn error_snapshot(revision: u64, agent_id: String, code: &str, message: &str) -> DictationSnapshot {
    DictationSnapshot {
        revision,
        phase: DictationPhase::Error,
        dictation_id: None,
        agent_id,
        interim_text: String::new(),
        transcript: String::new(),
        error: Some(DictationError {
            code: code.into(),
            message: message.into(),
        }),
        service: None,
        limits: limits(),
        disclosure: DISCLOSURE,
    }
}

fn limits() -> DictationLimits {
    DictationLimits {
        max_duration_seconds: MAX_DURATION_SECONDS,
        max_audio_bytes: MAX_AUDIO_BYTES,
    }
}

fn append_final(transcript: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() || transcript.ends_with(text) {
        return;
    }
    if !transcript.is_empty() && !transcript.ends_with(char::is_whitespace) {
        transcript.push(' ');
    }
    let remaining = TRANSCRIPT_MAX_CHARS.saturating_sub(transcript.chars().count());
    transcript.extend(text.chars().take(remaining));
}

fn limited_text(text: &str) -> String {
    text.trim().chars().take(TRANSCRIPT_MAX_CHARS).collect()
}

fn public_voice_error(message: &str) -> DictationError {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("permission") || normalized.contains("denied") {
        return DictationError {
            code: "microphone_permission_denied".into(),
            message: "没有麦克风权限，请在系统设置中允许 AgentMesh360 使用麦克风。".into(),
        };
    }
    if normalized.contains("no default input") || normalized.contains("audio device") {
        return DictationError {
            code: "microphone_unavailable".into(),
            message: "没有找到可用麦克风，请连接麦克风后重试。".into(),
        };
    }
    DictationError {
        code: "dictation_failed".into(),
        message: "听写没有完成，请稍后重试。".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(service: &DictationService) -> String {
        let (tx, _rx) = mpsc::channel(1);
        let id = "dict_test".to_owned();
        service.inner.lock().active = Some(ActiveDictation {
            owner_account_id: 41,
            agent_id: "job-agent".into(),
            dictation_id: id.clone(),
            phase: DictationPhase::Listening,
            interim_text: String::new(),
            transcript: String::new(),
            error: None,
            service: PublicService {
                provider_profile_id: "pp_xai".into(),
                display_name: "xAI".into(),
            },
            command_tx: tx,
        });
        id
    }

    #[test]
    fn final_transcript_is_editable_output_only_and_never_auto_submitted() {
        let service = DictationService::default();
        let id = active(&service);
        service.apply_event(
            &id,
            VoiceEvent::UtteranceFinal {
                text: "第一段".into(),
            },
        );
        service.apply_event(
            &id,
            VoiceEvent::UtteranceFinal {
                text: "第二段".into(),
            },
        );
        let snapshot = service.snapshot(41, "job-agent");
        assert_eq!(snapshot.phase, DictationPhase::Listening);
        assert_eq!(snapshot.transcript, "第一段 第二段");
        assert_eq!(snapshot.disclosure, DISCLOSURE);
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("apiKey"));
        assert!(!json.contains("credential"));
        assert!(!json.contains("audio"));
    }

    #[test]
    fn stop_then_final_completes_and_cancel_discards_all_text() {
        let service = DictationService::default();
        let id = active(&service);
        let (stopping, _, should_wait) = service.begin_stop(41, &id);
        assert!(should_wait);
        assert_eq!(stopping.phase, DictationPhase::Transcribing);
        let complete = service
            .apply_event(
                &id,
                VoiceEvent::UtteranceFinal {
                    text: "保留在草稿".into(),
                },
            )
            .unwrap();
        assert_eq!(complete.phase, DictationPhase::Complete);
        assert_eq!(complete.transcript, "保留在草稿");

        let (cancelled, _) = service.cancel(41, &id);
        assert_eq!(cancelled.phase, DictationPhase::Idle);
        assert!(cancelled.transcript.is_empty());
    }

    #[test]
    fn account_and_agent_status_are_isolated() {
        let service = DictationService::default();
        active(&service);
        assert_eq!(
            service.snapshot(41, "job-agent").phase,
            DictationPhase::Listening
        );
        assert_eq!(
            service.snapshot(42, "job-agent").phase,
            DictationPhase::Idle
        );
        assert_eq!(
            service.snapshot(41, "deploy-agent").phase,
            DictationPhase::Idle
        );
    }

    #[test]
    fn permission_and_provider_errors_are_stable_and_redacted() {
        assert_eq!(
            public_voice_error("grant mic permission in System Settings"),
            DictationError {
                code: "microphone_permission_denied".into(),
                message: "没有麦克风权限，请在系统设置中允许 AgentMesh360 使用麦克风。".into(),
            }
        );
        let snapshot = error_snapshot(
            1,
            "job-agent".into(),
            "dictation_provider_required",
            "需要配置支持听写的模型供应商。",
        );
        assert_eq!(snapshot.phase, DictationPhase::Error);
        assert_eq!(snapshot.error.unwrap().code, "dictation_provider_required");
    }

    #[test]
    fn bounds_are_explicit_and_transcripts_are_capped() {
        assert_eq!(MAX_AUDIO_BYTES, 1_920_000);
        let mut transcript = String::new();
        append_final(&mut transcript, &"字".repeat(TRANSCRIPT_MAX_CHARS + 50));
        assert_eq!(transcript.chars().count(), TRANSCRIPT_MAX_CHARS);
    }
}
