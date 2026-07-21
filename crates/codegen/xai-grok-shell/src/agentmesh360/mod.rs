//! AgentMesh360's persistent first-party product-agent layer.
//!
//! Grok Build remains the execution harness and the source of truth for session
//! transcripts, tools, permissions, memory, and subagents. This module adds the
//! stable product identity that a desktop client needs: one catalog entry and one
//! deterministic main conversation per activated product agent.

mod profiles;
pub mod registry;

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

pub const AGENTS_LIST_METHOD: &str = "x.agentmesh360/agents/list";
pub const AGENTS_ACTIVATE_METHOD: &str = "x.agentmesh360/agents/activate";

#[derive(Default)]
pub(crate) struct AgentMesh360Runtime {
    registry: AgentRegistry,
    pinned_sessions: RefCell<HashSet<acp::SessionId>>,
    restore_started: Cell<bool>,
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
    let result = match args.method.as_ref() {
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
        other => Err(anyhow!("unknown AgentMesh360 extension method: {other}")),
    };
    crate::extensions::to_ext_response(result)
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
