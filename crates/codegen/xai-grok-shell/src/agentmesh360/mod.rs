//! AgentMesh360's persistent first-party product-agent layer.
//!
//! Grok Build remains the execution harness and the source of truth for session
//! transcripts, tools, permissions, memory, and subagents. This module adds the
//! stable product identity that a desktop client needs: one catalog entry and one
//! deterministic main conversation per activated product agent.

mod access;
mod credential_lease;
mod credential_vault;
mod model_assignments;
mod model_policy;
mod model_routing;
mod profiles;
mod provider_catalog;
mod provider_profiles;
mod providers;
pub mod registry;
mod session_bindings;
mod state;
mod turn_routes;
pub(crate) mod turn_submission;

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::path::PathBuf;

use agent_client_protocol as acp;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use crate::agent::MvpAgent;
use crate::agent::mvp_agent::LocalRef;
use crate::agent::roster::RosterActivity;
use registry::{AgentRegistry, ProductAgentRecord};

pub const ACCOUNT_BOOTSTRAP_METHOD: &str = "x.agentmesh360/account/bootstrap";
pub const AGENTS_LIST_METHOD: &str = "x.agentmesh360/agents/list";
pub const AGENTS_ACTIVATE_METHOD: &str = "x.agentmesh360/agents/activate";

pub(crate) struct AgentMesh360Runtime {
    registry: AgentRegistry,
    providers: providers::ProviderService<credential_vault::RuntimeCredentialVault>,
    model_routing: model_routing::ModelRoutingService,
    access: access::ClientAccess,
    state_home: PathBuf,
    credential_vault: credential_vault::RuntimeCredentialVault,
    pinned_sessions: RefCell<HashSet<acp::SessionId>>,
    restore_started: Cell<bool>,
    access_generation: Cell<u64>,
}

impl Default for AgentMesh360Runtime {
    fn default() -> Self {
        let state_home = state::default_state_home();
        let credential_vault = credential_vault::RuntimeCredentialVault::default();
        Self::new(
            state_home,
            access::ClientAccess::default(),
            credential_vault,
        )
    }
}

impl AgentMesh360Runtime {
    fn new(
        state_home: PathBuf,
        access: access::ClientAccess,
        credential_vault: credential_vault::RuntimeCredentialVault,
    ) -> Self {
        Self {
            registry: AgentRegistry::in_home(&state_home),
            providers: providers::ProviderService::new(
                provider_profiles::ProviderProfileStore::in_home(&state_home),
                credential_vault.clone(),
            ),
            model_routing: model_routing::ModelRoutingService::in_home(&state_home),
            access,
            state_home,
            credential_vault,
            pinned_sessions: RefCell::default(),
            restore_started: Cell::default(),
            access_generation: Cell::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_host_test(
        state_home: impl Into<PathBuf>,
        core_base_url: impl Into<String>,
    ) -> Self {
        Self::new(
            state_home.into(),
            access::ClientAccess::new(core_base_url),
            credential_vault::RuntimeCredentialVault::Memory(
                credential_vault::MemoryCredentialVault::default(),
            ),
        )
    }

    pub(crate) fn registry(&self) -> &AgentRegistry {
        &self.registry
    }

    pub(crate) fn pin(&self, session_id: acp::SessionId) {
        self.pinned_sessions.borrow_mut().insert(session_id);
    }

    pub(crate) fn is_pinned(&self, session_id: &acp::SessionId) -> bool {
        self.pinned_sessions.borrow().contains(session_id)
    }

    fn suspend_residency(&self) -> bool {
        let had_pins = !self.pinned_sessions.borrow().is_empty();
        self.pinned_sessions.borrow_mut().clear();
        let had_restore = self.restore_started.replace(false);
        had_pins || had_restore
    }

    fn next_access_generation(&self) -> u64 {
        let next = self.access_generation.get().wrapping_add(1);
        self.access_generation.set(next);
        next
    }

    pub(crate) fn session_route_context(
        &self,
        session_id: &acp::SessionId,
    ) -> Result<Option<turn_submission::AgentMeshSessionRouteContext>> {
        let Some((owner_account_id, agent_id)) =
            self.registry.main_session_identity(session_id.0.as_ref())?
        else {
            return Ok(None);
        };
        let Some(owner_account_id) = owner_account_id else {
            return Ok(None);
        };
        if self.access.current_account_id() != Some(owner_account_id) {
            bail!("product Session account access is unavailable");
        }
        Ok(Some(turn_submission::AgentMeshSessionRouteContext::new(
            owner_account_id,
            agent_id,
            self.access.guard(owner_account_id),
            self.state_home.clone(),
            self.credential_vault.clone(),
        )))
    }
}

pub(crate) use turn_submission::ProductTurnRoute;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapRequest {
    access_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateRequest {
    agent_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentListResponse {
    agents: Vec<ProductAgentRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivateResponse {
    agent: ProductAgentRecord,
    resumed: bool,
}

pub(crate) async fn handle(
    agent: &MvpAgent,
    args: &acp::ExtRequest,
) -> crate::extensions::ExtResult {
    if args.method.as_ref() != ACCOUNT_BOOTSTRAP_METHOD {
        require_runtime_access(agent)?;
    }
    let result = match args.method.as_ref() {
        ACCOUNT_BOOTSTRAP_METHOD => {
            let request: BootstrapRequest = crate::extensions::parse_params(args)?;
            let access_generation = agent.agentmesh360.next_access_generation();
            let previous_account_id = agent.agentmesh360.access.current_account_id();
            match agent
                .agentmesh360
                .access
                .bootstrap(&request.access_token)
                .await
            {
                Ok(response) => {
                    if agent.agentmesh360.access.is_granted() {
                        let owner_account_id = response.account.account_id;
                        if previous_account_id != Some(owner_account_id) {
                            suspend_product_agents(agent, true);
                        }
                        if let Err(error) = agent
                            .agentmesh360
                            .registry()
                            .claim_legacy_and_seed(owner_account_id)
                        {
                            agent.agentmesh360.access.invalidate();
                            suspend_product_agents(agent, true);
                            tracing::error!(
                                %error,
                                owner_account_id,
                                "failed to initialize account-scoped AgentMesh360 agents"
                            );
                            return Err(acp::Error::internal_error()
                                .data("failed to initialize AgentMesh360 account state"));
                        }
                        spawn_restore_activated_agents(agent);
                        spawn_access_expiry(agent, access_generation);
                    } else {
                        suspend_product_agents(agent, true);
                    }
                    serde_json::to_value(response).map_err(Into::into)
                }
                Err(error) => {
                    suspend_product_agents(agent, true);
                    return Err(error.to_acp_error());
                }
            }
        }
        AGENTS_LIST_METHOD => list_agents(agent).map(|agents| {
            serde_json::to_value(AgentListResponse { agents })
                .expect("AgentListResponse is serializable")
        }),
        AGENTS_ACTIVATE_METHOD => {
            let request: ActivateRequest = crate::extensions::parse_params(args)?;
            activate(agent, &request.agent_id)
                .await
                .and_then(|response| serde_json::to_value(response).map_err(Into::into))
        }
        method if model_routing::handles(method) => {
            let owner_account_id = agent
                .agentmesh360
                .access
                .current_account_id()
                .ok_or_else(|| anyhow!("AgentMesh360 account access is unavailable"))?;
            return model_routing::handle(
                &agent.agentmesh360.model_routing,
                owner_account_id,
                args,
            );
        }
        method if method.starts_with("x.agentmesh360/providers/") => {
            let owner_account_id = agent
                .agentmesh360
                .access
                .current_account_id()
                .ok_or_else(|| anyhow!("AgentMesh360 account access is unavailable"))?;
            return providers::handle(&agent.agentmesh360.providers, owner_account_id, args);
        }
        other => Err(anyhow!("unknown AgentMesh360 extension method: {other}")),
    };
    crate::extensions::to_ext_response(result)
}

fn spawn_access_expiry(agent: &MvpAgent, access_generation: u64) {
    let Some(delay) = agent.agentmesh360.access.remaining_validity() else {
        return;
    };
    let agent_ref = LocalRef::new(agent);
    tokio::task::spawn_local(async move {
        tokio::time::sleep(delay).await;
        let agent = agent_ref.get();
        if agent.agentmesh360.access_generation.get() != access_generation {
            return;
        }
        if agent.agentmesh360.access.require().is_err() {
            suspend_product_agents(agent, true);
        }
    });
}

fn suspend_product_agents(agent: &MvpAgent, force_notify: bool) {
    let residency_changed = agent.agentmesh360.suspend_residency();
    if !force_notify && !residency_changed {
        return;
    }
    let removed = agent
        .agentmesh360
        .registry()
        .all_main_session_ids()
        .map(|ids| ids.into_iter().collect())
        .unwrap_or_default();
    agent.emit_roster_changed(Vec::new(), removed);
}

fn require_runtime_access(agent: &MvpAgent) -> Result<(), acp::Error> {
    agent.agentmesh360.access.require().inspect_err(|_| {
        suspend_product_agents(agent, false);
    })
}

pub(crate) fn require_product_session_access(
    agent: &MvpAgent,
    session_id: &acp::SessionId,
) -> Result<(), acp::Error> {
    let owner_account_id = agent
        .agentmesh360
        .registry()
        .main_session_owner(session_id.0.as_ref())
        .map_err(|_| {
            acp::Error::internal_error().data("failed to verify AgentMesh360 session identity")
        })?;
    let Some(owner_account_id) = owner_account_id else {
        return Ok(());
    };

    require_runtime_access(agent)?;
    let current_account_id = agent
        .agentmesh360
        .access
        .current_account_id()
        .ok_or_else(|| acp::Error::auth_required().data("AgentMesh360 access is unavailable"))?;
    if owner_account_id != Some(current_account_id) {
        return Err(acp::Error::invalid_params().data("session not found"));
    }
    Ok(())
}

pub(crate) fn hidden_product_session_ids(agent: &MvpAgent) -> Result<HashSet<String>, acp::Error> {
    let all_product_sessions = agent
        .agentmesh360
        .registry()
        .all_main_session_ids()
        .map_err(|_| {
            acp::Error::internal_error().data("failed to protect AgentMesh360 session history")
        })?;
    let Some(owner_account_id) = agent.agentmesh360.access.current_account_id() else {
        suspend_product_agents(agent, false);
        return Ok(all_product_sessions);
    };
    let visible_sessions = agent
        .agentmesh360
        .registry()
        .main_session_ids(owner_account_id)
        .map_err(|_| {
            acp::Error::internal_error().data("failed to read AgentMesh360 account sessions")
        })?;
    Ok(all_product_sessions
        .difference(&visible_sessions)
        .cloned()
        .collect())
}

fn list_agents(agent: &MvpAgent) -> Result<Vec<ProductAgentRecord>> {
    let owner_account_id = current_account_id(agent)?;
    let mut records = agent.agentmesh360.registry().list(owner_account_id)?;
    for record in &mut records {
        refresh_runtime_view(agent, record);
    }
    Ok(records)
}

async fn activate(agent: &MvpAgent, agent_id: &str) -> Result<ActivateResponse> {
    let owner_account_id = current_account_id(agent)?;
    let record = agent
        .agentmesh360
        .registry()
        .prepare_activation(owner_account_id, agent_id)?;
    let session_id = record
        .main_session_id
        .as_deref()
        .map(acp::SessionId::new)
        .ok_or_else(|| anyhow!("activation did not allocate a main session"))?;

    if agent.sessions.borrow().contains_key(&session_id) {
        agent.agentmesh360.pin(session_id);
        agent
            .agentmesh360
            .registry()
            .mark_runtime(owner_account_id, agent_id, "resident", None)?;
        let mut agent_record = agent
            .agentmesh360
            .registry()
            .get(owner_account_id, agent_id)?;
        refresh_runtime_view(agent, &mut agent_record);
        return Ok(ActivateResponse {
            agent: agent_record,
            resumed: true,
        });
    }

    let workspace_dir = record
        .workspace_dir
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("activation did not allocate a workspace"))?;
    let profile = profiles::profile_for(agent_id)?;
    let persisted_cwd = crate::session::resolve_local_session_any_cwd(session_id.0.as_ref());
    let mut meta = acp::Meta::new();
    meta.insert("agentProfile".into(), profile.to_json_value());
    meta.insert("agentmesh360AgentId".into(), agent_id.into());
    meta.insert("agentmesh360AccountId".into(), owner_account_id.into());
    meta.insert(
        "clientIdentifier".into(),
        "agentmesh360-product-agent".into(),
    );

    let resumed = persisted_cwd.is_some();
    let session_result = if let Some(cwd) = persisted_cwd {
        let request = acp::LoadSessionRequest::new(session_id.clone(), cwd).meta(meta);
        acp::Agent::load_session(agent, request)
            .await
            .map(|_| session_id.clone())
    } else {
        meta.insert("sessionId".into(), session_id.0.as_ref().into());
        let request = acp::NewSessionRequest::new(workspace_dir).meta(meta);
        acp::Agent::new_session(agent, request)
            .await
            .map(|response| response.session_id)
    };

    match session_result {
        Ok(actual_session_id) if actual_session_id == session_id => {
            agent.agentmesh360.pin(session_id);
            agent.agentmesh360.registry().mark_runtime(
                owner_account_id,
                agent_id,
                "resident",
                None,
            )?;
            let mut agent_record = agent
                .agentmesh360
                .registry()
                .get(owner_account_id, agent_id)?;
            refresh_runtime_view(agent, &mut agent_record);
            Ok(ActivateResponse {
                agent: agent_record,
                resumed,
            })
        }
        Ok(actual_session_id) => {
            let error = format!(
                "Grok session identity mismatch: expected {}, received {}",
                session_id.0, actual_session_id.0
            );
            let _ = agent.agentmesh360.registry().mark_runtime(
                owner_account_id,
                agent_id,
                "error",
                Some(&error),
            );
            Err(anyhow!(error))
        }
        Err(error) => {
            let message = error.to_string();
            let _ = agent.agentmesh360.registry().mark_runtime(
                owner_account_id,
                agent_id,
                "error",
                Some(&message),
            );
            Err(anyhow!(error).context(format!("activate {agent_id}")))
        }
    }
}

fn refresh_runtime_view(agent: &MvpAgent, record: &mut ProductAgentRecord) {
    if record.desired_state != "running" {
        record.runtime_state = "available".into();
        return;
    }
    let Some(session_id) = record.main_session_id.as_deref().map(acp::SessionId::new) else {
        record.runtime_state = "error".into();
        return;
    };
    record.runtime_state = if agent.sessions.borrow().contains_key(&session_id) {
        activity_name(agent.resident_activity(&session_id)).into()
    } else if crate::session::resolve_local_session_any_cwd(session_id.0.as_ref()).is_some() {
        "dormant".into()
    } else if record.runtime_state == "error" {
        "error".into()
    } else {
        "starting".into()
    };
}

fn activity_name(activity: RosterActivity) -> &'static str {
    match activity {
        RosterActivity::Working => "working",
        RosterActivity::Idle => "resident",
        RosterActivity::NeedsInput => "needs_input",
        RosterActivity::Dormant => "dormant",
        RosterActivity::Completed => "completed",
        RosterActivity::Dead => "error",
    }
}

pub(crate) fn spawn_restore_activated_agents(agent: &MvpAgent) {
    if cfg!(test) || agent.agentmesh360.restore_started.replace(true) {
        return;
    }
    let agent_ref = LocalRef::new(agent);
    tokio::task::spawn_local(async move {
        let agent = agent_ref.get();
        let owner_account_id = match current_account_id(agent) {
            Ok(owner_account_id) => owner_account_id,
            Err(error) => {
                tracing::error!(%error, "cannot restore AgentMesh360 agents without account access");
                return;
            }
        };
        let records = match agent.agentmesh360.registry().list(owner_account_id) {
            Ok(records) => records,
            Err(error) => {
                tracing::error!(%error, "failed to read persistent AgentMesh360 agents at startup");
                return;
            }
        };
        for record in records
            .into_iter()
            .filter(|record| record.desired_state == "running")
        {
            if let Err(error) = activate(agent, &record.agent_id).await {
                tracing::error!(agent_id = %record.agent_id, %error, "failed to restore persistent product agent");
            }
        }
    });
}

fn current_account_id(agent: &MvpAgent) -> Result<i64> {
    agent
        .agentmesh360
        .access
        .current_account_id()
        .ok_or_else(|| anyhow!("AgentMesh360 account access is unavailable"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use xai_acp_lib::AcpAgentGatewaySender as GatewaySender;

    use super::*;
    use crate::agent::config::Config;
    use crate::auth::{AuthManager, GrokComConfig};

    const ACTIVE_BOOTSTRAP: &str = r#"{
        "schema_version":1,
        "server_time":"2026-07-22T00:00:00Z",
        "account":{"id":1,"email":"u@example.com","account_id":41,"display_name":null,"avatar_url":null},
        "subscription":{"status":"active","source":"monthly_pass","plan":"monthly_pass","period_start":"2026-07-01 00:00:00","period_end":"2026-08-31 00:00:00","auto_renews":false},
        "credits":{"balance":0,"source":"monthly_pass","expires_at":"2026-08-31 00:00:00"},
        "access":{"can_enter_client":true,"reason":"active_subscription"}
    }"#;

    fn ext_request(method: &str, params: serde_json::Value) -> acp::ExtRequest {
        acp::ExtRequest::new(
            method,
            Arc::from(serde_json::value::to_raw_value(&params).expect("request params")),
        )
    }

    fn ext_result(response: acp::ExtResponse) -> serde_json::Value {
        let envelope: serde_json::Value =
            serde_json::from_str(response.0.get()).expect("extension response");
        envelope
            .get("result")
            .cloned()
            .unwrap_or_else(|| panic!("extension response has no result: {envelope}"))
    }

    async fn serve_bootstrap_once() -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Core mock");
        let address = listener.local_addr().expect("Core mock address");
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept Core request");
            let mut request = vec![0; 4096];
            let read = stream.read(&mut request).await.expect("read Core request");
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ACTIVE_BOOTSTRAP}",
                ACTIVE_BOOTSTRAP.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write Core response");
            request
        });
        (format!("http://{address}"), task)
    }

    fn build_host_test_agent(state_home: &std::path::Path, core_base_url: String) -> MvpAgent {
        let auth_home = tempfile::tempdir().expect("auth home");
        let auth_manager = Arc::new(AuthManager::new(auth_home.path(), GrokComConfig::default()));
        let (gateway_tx, _gateway_rx) = tokio::sync::mpsc::unbounded_channel();
        let gateway = GatewaySender::new(gateway_tx);
        let mut agent =
            MvpAgent::new(gateway, &Config::default(), auth_manager, None).expect("test agent");
        agent.agentmesh360 = AgentMesh360Runtime::for_host_test(state_home, core_base_url);
        agent
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn host_test_runtime_shares_memory_vault_across_acp_and_prompt_routing() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let agent = build_host_test_agent(state_home.path(), core_base_url);

                let bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "sentinel-bootstrap-token"}),
                    ),
                )
                .await
                .expect("bootstrap response");
                let bootstrap = ext_result(bootstrap);
                assert_eq!(bootstrap["access"]["canEnterClient"], true);
                assert_eq!(bootstrap["credits"]["balance"], 0);
                let core_request = core.await.expect("Core request task");
                assert!(core_request.contains("authorization: Bearer sentinel-bootstrap-token"));

                let provider = handle(
                    &agent,
                    &ext_request(
                        providers::PROVIDERS_CREATE_METHOD,
                        serde_json::json!({
                            "profile": {
                                "presetId": "local-openai-chat",
                                "displayName": "Host E2E Local",
                                "protocol": "openai_chat",
                                "baseUrl": "http://127.0.0.1:11434/v1",
                                "authKind": "bearer_api_key",
                                "enabledModels": ["model-main"]
                            },
                            "apiKey": "sentinel-provider-secret-1234"
                        }),
                    ),
                )
                .await
                .expect("create Provider response");
                let provider = ext_result(provider);
                let profile_id = provider["profile"]["profileId"]
                    .as_str()
                    .expect("profile id")
                    .to_owned();
                assert!(
                    !provider
                        .to_string()
                        .contains("sentinel-provider-secret-1234")
                );

                handle(
                    &agent,
                    &ext_request(
                        model_routing::ASSIGNMENTS_UPSERT_METHOD,
                        serde_json::json!({
                            "assignment": {
                                "scopeKind": "agent",
                                "scopeId": "job-agent",
                                "role": "main",
                                "providerProfileId": profile_id,
                                "modelId": "model-main"
                            }
                        }),
                    ),
                )
                .await
                .expect("upsert Assignment");

                let record = agent
                    .agentmesh360
                    .registry()
                    .prepare_activation(41, "job-agent")
                    .expect("prepare product Agent");
                let session_id = record.main_session_id.expect("main Session");
                let route_context = agent
                    .agentmesh360
                    .session_route_context(&acp::SessionId::new(session_id.clone()))
                    .expect("route context lookup")
                    .expect("product Session route context");
                let mut route = route_context
                    .prepare_turn(&session_id, "turn-host-shared-vault")
                    .expect("prepare bound turn using ACP-created credential");
                route
                    .submit(|config| {
                        assert!(config.api_key.is_none());
                        assert!(config.bearer_resolver.is_some());
                        Ok(())
                    })
                    .expect("accept bound turn");

                let history = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "main",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("Turn Route history response");
                let history = ext_result(history);
                assert_eq!(history["turnRoutes"].as_array().map(Vec::len), Some(1));
                assert!(
                    !history
                        .to_string()
                        .contains("sentinel-provider-secret-1234")
                );
                assert!(!format!("{route:?}").contains("sentinel-provider-secret-1234"));
            })
            .await;
    }
}
