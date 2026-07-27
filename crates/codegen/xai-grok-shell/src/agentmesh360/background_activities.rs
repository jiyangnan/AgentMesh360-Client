use std::collections::HashSet;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use xai_grok_tools::computer::types::{TaskKind, TaskSnapshot};

use crate::agent::MvpAgent;

use super::registry::AgentRegistry;

const MAX_ACTIVITIES: usize = 50;
const MAX_TASK_ID_BYTES: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BackgroundActivityListRequest {
    pub(crate) agent_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundActivityListResponse {
    activities: Vec<BackgroundActivity>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BackgroundActivity {
    task_id: String,
    kind: BackgroundActivityKind,
    status: BackgroundActivityStatus,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BackgroundActivityKind {
    Command,
    Monitor,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BackgroundActivityStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

pub(crate) async fn list(
    agent: &MvpAgent,
    registry: &AgentRegistry,
    owner_account_id: i64,
    agent_id: &str,
) -> Result<BackgroundActivityListResponse> {
    let record = registry.get(owner_account_id, agent_id)?;
    if record.desired_state != "running" {
        bail!("Agent is not active");
    }
    let session_id = record
        .main_session_id
        .ok_or_else(|| anyhow::anyhow!("active Agent has no Main Session"))?;
    let tasks = agent
        .list_tasks(&session_id)
        .await
        .ok_or_else(|| anyhow::anyhow!("Agent Main Session is not resident"))?;
    project(tasks)
}

fn project(mut tasks: Vec<TaskSnapshot>) -> Result<BackgroundActivityListResponse> {
    if tasks.len() > MAX_ACTIVITIES {
        bail!("Harness returned too many background activities");
    }
    tasks.sort_by(|left, right| {
        left.start_time
            .cmp(&right.start_time)
            .then_with(|| left.task_id.cmp(&right.task_id))
    });
    let mut task_ids = HashSet::with_capacity(tasks.len());
    let mut activities = Vec::with_capacity(tasks.len());
    for task in tasks {
        validate_task_id(&task.task_id)?;
        if !task_ids.insert(task.task_id.clone()) {
            bail!("Harness returned a duplicate background task id");
        }
        let status = project_status(&task);
        let kind = match task.kind {
            TaskKind::Bash => BackgroundActivityKind::Command,
            TaskKind::Monitor => BackgroundActivityKind::Monitor,
        };
        activities.push(BackgroundActivity {
            task_id: task.task_id,
            kind,
            status,
        });
    }
    Ok(BackgroundActivityListResponse { activities })
}

fn project_status(task: &TaskSnapshot) -> BackgroundActivityStatus {
    if !task.completed {
        return BackgroundActivityStatus::Running;
    }
    if task.explicitly_killed || task.signal.as_deref() == Some("session_restart") {
        return BackgroundActivityStatus::Stopped;
    }
    if task.exit_code == Some(0) || (task.exit_code.is_none() && task.signal.is_none()) {
        return BackgroundActivityStatus::Completed;
    }
    BackgroundActivityStatus::Failed
}

fn validate_task_id(task_id: &str) -> Result<()> {
    if task_id.is_empty()
        || task_id.len() > MAX_TASK_ID_BYTES
        || task_id.chars().any(char::is_control)
    {
        bail!("Harness background task id is invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    use super::*;

    fn task(task_id: &str, kind: TaskKind) -> TaskSnapshot {
        TaskSnapshot {
            task_id: task_id.into(),
            command: "private command".into(),
            display_command: Some("private display command".into()),
            cwd: "/private/cwd".into(),
            start_time: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
            end_time: None,
            output: "private output".into(),
            output_file: PathBuf::from("/private/output.log"),
            truncated: false,
            exit_code: None,
            signal: None,
            completed: false,
            kind,
            block_waited: false,
            explicitly_killed: false,
            owner_session_id: Some("private-session".into()),
        }
    }

    #[test]
    fn projects_only_private_correlation_kind_and_status() {
        let mut running = task("task-running", TaskKind::Monitor);
        let mut completed = task("task-completed", TaskKind::Bash);
        completed.completed = true;
        completed.exit_code = Some(0);
        completed.start_time = SystemTime::UNIX_EPOCH + Duration::from_secs(20);
        let response = project(vec![completed, running.clone()]).expect("safe projection");

        assert_eq!(
            response,
            BackgroundActivityListResponse {
                activities: vec![
                    BackgroundActivity {
                        task_id: "task-running".into(),
                        kind: BackgroundActivityKind::Monitor,
                        status: BackgroundActivityStatus::Running,
                    },
                    BackgroundActivity {
                        task_id: "task-completed".into(),
                        kind: BackgroundActivityKind::Command,
                        status: BackgroundActivityStatus::Completed,
                    },
                ],
            }
        );
        let serialized = serde_json::to_string(&response).expect("serialize response");
        for forbidden in [
            "private command",
            "private display command",
            "/private/cwd",
            "private output",
            "/private/output.log",
            "private-session",
        ] {
            assert!(!serialized.contains(forbidden));
        }

        running.completed = true;
        running.explicitly_killed = true;
        assert_eq!(project_status(&running), BackgroundActivityStatus::Stopped);
    }

    #[test]
    fn distinguishes_failure_and_cold_restart_from_success() {
        let mut failed = task("failed", TaskKind::Bash);
        failed.completed = true;
        failed.exit_code = Some(9);
        assert_eq!(project_status(&failed), BackgroundActivityStatus::Failed);

        let mut restarted = task("restarted", TaskKind::Bash);
        restarted.completed = true;
        restarted.signal = Some("session_restart".into());
        assert_eq!(
            project_status(&restarted),
            BackgroundActivityStatus::Stopped
        );

        let mut success_without_code = task("success", TaskKind::Bash);
        success_without_code.completed = true;
        assert_eq!(
            project_status(&success_without_code),
            BackgroundActivityStatus::Completed
        );
    }

    #[test]
    fn rejects_invalid_duplicate_and_oversized_snapshots() {
        assert!(project(vec![task("", TaskKind::Bash)]).is_err());
        assert!(project(vec![task("bad\nid", TaskKind::Bash)]).is_err());
        assert!(
            project(vec![
                task("duplicate", TaskKind::Bash),
                task("duplicate", TaskKind::Monitor),
            ])
            .is_err()
        );
        assert!(
            project(
                (0..=MAX_ACTIVITIES)
                    .map(|index| task(&format!("task-{index}"), TaskKind::Bash))
                    .collect(),
            )
            .is_err()
        );
    }
}
