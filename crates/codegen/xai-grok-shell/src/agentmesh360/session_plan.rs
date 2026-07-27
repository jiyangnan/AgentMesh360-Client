use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::agent::MvpAgent;
use crate::session::commands::SessionPlanItem;
use crate::tools::todo::TodoStatus;

use super::registry::AgentRegistry;

const MAX_PLAN_ENTRIES: usize = 50;
const MAX_CONTENT_CHARS: usize = 300;
const MAX_CONTENT_BYTES: usize = 1_200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionPlanRequest {
    pub(crate) agent_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionPlanResponse {
    entries: Vec<SessionPlanEntry>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SessionPlanEntry {
    content: String,
    status: SessionPlanStatus,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SessionPlanStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

pub(crate) async fn get(
    agent: &MvpAgent,
    registry: &AgentRegistry,
    owner_account_id: i64,
    agent_id: &str,
) -> Result<SessionPlanResponse> {
    let record = registry.get(owner_account_id, agent_id)?;
    if record.desired_state != "running" {
        bail!("Agent is not active");
    }
    let session_id = record
        .main_session_id
        .ok_or_else(|| anyhow::anyhow!("active Agent has no Main Session"))?;
    let entries = agent
        .list_session_plan(&session_id)
        .await
        .ok_or_else(|| anyhow::anyhow!("Agent Main Session is not resident"))?;
    project(entries)
}

fn project(entries: Vec<SessionPlanItem>) -> Result<SessionPlanResponse> {
    if entries.len() > MAX_PLAN_ENTRIES {
        bail!("Harness returned too many Session plan entries");
    }
    let mut projected = Vec::with_capacity(entries.len());
    for entry in entries {
        let content = entry.content.trim();
        if content.is_empty()
            || content.len() > MAX_CONTENT_BYTES
            || content.chars().count() > MAX_CONTENT_CHARS
            || content.chars().any(char::is_control)
        {
            bail!("Harness Session plan content is invalid");
        }
        projected.push(SessionPlanEntry {
            content: content.to_owned(),
            status: match entry.status {
                TodoStatus::Pending => SessionPlanStatus::Pending,
                TodoStatus::InProgress => SessionPlanStatus::InProgress,
                TodoStatus::Completed => SessionPlanStatus::Completed,
                TodoStatus::Cancelled => SessionPlanStatus::Cancelled,
            },
        });
    }
    Ok(SessionPlanResponse { entries: projected })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(content: &str, status: TodoStatus) -> SessionPlanItem {
        SessionPlanItem {
            content: content.into(),
            status,
        }
    }

    #[test]
    fn projects_only_bounded_content_and_status() {
        let response = project(vec![
            entry("  核对岗位要求  ", TodoStatus::InProgress),
            entry("输出岗位清单", TodoStatus::Pending),
            entry("运行交叉测试", TodoStatus::Completed),
            entry("取消旧方案", TodoStatus::Cancelled),
        ])
        .expect("safe projection");

        assert_eq!(
            response,
            SessionPlanResponse {
                entries: vec![
                    SessionPlanEntry {
                        content: "核对岗位要求".into(),
                        status: SessionPlanStatus::InProgress,
                    },
                    SessionPlanEntry {
                        content: "输出岗位清单".into(),
                        status: SessionPlanStatus::Pending,
                    },
                    SessionPlanEntry {
                        content: "运行交叉测试".into(),
                        status: SessionPlanStatus::Completed,
                    },
                    SessionPlanEntry {
                        content: "取消旧方案".into(),
                        status: SessionPlanStatus::Cancelled,
                    },
                ],
            }
        );
        let serialized = serde_json::to_string(&response).expect("serialize response");
        for forbidden in ["priority", "meta"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn rejects_empty_control_and_oversized_content() {
        assert!(project(vec![entry(" \n ", TodoStatus::Pending)]).is_err());
        assert!(project(vec![entry("bad\u{85}plan", TodoStatus::Pending)]).is_err());
        assert!(
            project(vec![entry(
                &"a".repeat(MAX_CONTENT_CHARS + 1),
                TodoStatus::Pending,
            )])
            .is_err()
        );
        assert!(
            project(vec![entry(
                &"界".repeat((MAX_CONTENT_BYTES / 3) + 1),
                TodoStatus::Pending,
            )])
            .is_err()
        );
    }

    #[test]
    fn rejects_oversized_plan() {
        assert!(
            project(
                (0..=MAX_PLAN_ENTRIES)
                    .map(|index| entry(&format!("step {index}"), TodoStatus::Pending))
                    .collect(),
            )
            .is_err()
        );
    }
}
