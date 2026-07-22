//! AgentMesh360's persistent first-party product-agent layer.
//!
//! Grok Build remains the execution harness and the source of truth for session
//! transcripts, tools, permissions, memory, and subagents. This module adds the
//! stable product identity that a desktop client needs: one catalog entry and one
//! deterministic main conversation per activated product agent.

mod access;
mod credential_vault;
mod profiles;
mod provider_profiles;
mod providers;
pub mod registry;
mod state;

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::path::PathBuf;

use agent_client_protocol as acp;
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::agent::MvpAgent;
use crate::agent::mvp_agent::LocalRef;
use crate::agent::roster::RosterActivity;
use registry::{AgentRegistry, ProductAgentRecord};

pub const ACCOUNT_BOOTSTRAP_METHOD: &str = "x.agentmesh360/account/bootstrap";
pub const AGENTS_LIST_METHOD: &str = "x.agentmesh360/agents/list";
pub const AGENTS_ACTIVATE_METHOD: &str = "x.agentmesh360/agents/activate";

#[derive(Default)]
pub(crate) struct AgentMesh360Runtime {
    registry: AgentRegistry,
    providers: providers::ProviderService<credential_vault::SystemCredentialVault>,
    access: access::ClientAccess,
    pinned_sessions: RefCell<HashSet<acp::SessionId>>,
    restore_started: Cell<bool>,
    access_generation: Cell<u64>,
}

impl AgentMesh360Runtime {
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
}

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
            match agent
                .agentmesh360
                .access
                .bootstrap(&request.access_token)
                .await
            {
                Ok(response) => {
                    if agent.agentmesh360.access.is_granted() {
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
        .main_session_ids()
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
    let is_product_session = agent
        .agentmesh360
        .registry()
        .contains_main_session(session_id.0.as_ref())
        .map_err(|_| {
            acp::Error::internal_error().data("failed to verify AgentMesh360 session identity")
        })?;
    if is_product_session {
        require_runtime_access(agent)?;
    }
    Ok(())
}

pub(crate) fn hidden_product_session_ids(agent: &MvpAgent) -> Result<HashSet<String>, acp::Error> {
    if agent.agentmesh360.access.is_granted() {
        return Ok(HashSet::new());
    }
    suspend_product_agents(agent, false);
    agent
        .agentmesh360
        .registry()
        .main_session_ids()
        .map_err(|_| {
            acp::Error::internal_error().data("failed to protect AgentMesh360 session history")
        })
}

fn list_agents(agent: &MvpAgent) -> Result<Vec<ProductAgentRecord>> {
    let mut records = agent.agentmesh360.registry().list()?;
    for record in &mut records {
        refresh_runtime_view(agent, record);
    }
    Ok(records)
}

async fn activate(agent: &MvpAgent, agent_id: &str) -> Result<ActivateResponse> {
    let record = agent.agentmesh360.registry().prepare_activation(agent_id)?;
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
            .mark_runtime(agent_id, "resident", None)?;
        let mut agent_record = agent.agentmesh360.registry().get(agent_id)?;
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
            agent
                .agentmesh360
                .registry()
                .mark_runtime(agent_id, "resident", None)?;
            let mut agent_record = agent.agentmesh360.registry().get(agent_id)?;
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
            let _ = agent
                .agentmesh360
                .registry()
                .mark_runtime(agent_id, "error", Some(&error));
            Err(anyhow!(error))
        }
        Err(error) => {
            let message = error.to_string();
            let _ = agent
                .agentmesh360
                .registry()
                .mark_runtime(agent_id, "error", Some(&message));
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
        let records = match agent.agentmesh360.registry().list() {
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
