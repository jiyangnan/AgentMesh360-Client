use std::collections::HashSet;
use std::fs::{self, Metadata, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use super::registry::AgentRegistry;

const SCHEMA_VERSION: u8 = 1;
const MAX_MANIFEST_BYTES: u64 = 32 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_TITLE_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 500;
const MAX_STEPS: usize = 20;
const MAX_STEP_ID_BYTES: usize = 64;
const MAX_STEP_LABEL_CHARS: usize = 160;
const CONTROL_DIRECTORY: &str = ".agentmesh360";
const MANIFEST_FILE: &str = "project-state-v1.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceProjectStateRequest {
    pub(crate) agent_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceProjectStateResponse {
    schema_version: u8,
    revision: u64,
    project: Option<WorkspaceProjectState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceProjectStateManifest {
    schema_version: u8,
    revision: u64,
    project: ManifestProjectState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestProjectState {
    title: String,
    status: ProjectStatus,
    summary: String,
    steps: Vec<ManifestProjectStep>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProjectState {
    title: String,
    status: ProjectStatus,
    summary: String,
    steps: Vec<WorkspaceProjectStep>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProjectStatus {
    Active,
    WaitingForUser,
    Blocked,
    Completed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestProjectStep {
    step_id: String,
    label: String,
    status: ProjectStepStatus,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProjectStep {
    step_id: String,
    label: String,
    status: ProjectStepStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProjectStepStatus {
    Pending,
    InProgress,
    Blocked,
    Completed,
}

pub(crate) fn get(
    registry: &AgentRegistry,
    owner_account_id: i64,
    agent_id: &str,
) -> Result<WorkspaceProjectStateResponse> {
    let record = registry.get(owner_account_id, agent_id)?;
    if record.desired_state != "running"
        || record.main_session_id.is_none()
        || record.workspace_dir.is_none()
    {
        bail!("Agent Workspace is not active");
    }
    let workspace = PathBuf::from(record.workspace_dir.expect("checked Workspace"));
    require_real_directory(&workspace, "Agent Workspace")?;

    let control_directory = workspace.join(CONTROL_DIRECTORY);
    match fs::symlink_metadata(&control_directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("Workspace Project State control directory is invalid");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_response());
        }
        Err(error) => {
            return Err(error).context("inspect Workspace Project State control directory");
        }
    }

    let manifest_path = control_directory.join(MANIFEST_FILE);
    let metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_response());
        }
        Err(error) => return Err(error).context("inspect Workspace Project State Manifest"),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("Workspace Project State Manifest is not a regular file");
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        bail!("Workspace Project State Manifest exceeds the size limit");
    }

    validate_manifest(read_manifest(&manifest_path, &metadata)?)
}

fn empty_response() -> WorkspaceProjectStateResponse {
    WorkspaceProjectStateResponse {
        schema_version: SCHEMA_VERSION,
        revision: 0,
        project: None,
    }
}

fn read_manifest(path: &Path, inspected: &Metadata) -> Result<WorkspaceProjectStateManifest> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .context("open Workspace Project State Manifest")?;
    let opened = file
        .metadata()
        .context("inspect opened Workspace Project State Manifest")?;
    if !opened.is_file() || opened.len() > MAX_MANIFEST_BYTES {
        bail!("opened Workspace Project State Manifest is not allowed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;

        if inspected.dev() != opened.dev() || inspected.ino() != opened.ino() {
            bail!("Workspace Project State Manifest changed while it was opened");
        }
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("read Workspace Project State Manifest")?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        bail!("Workspace Project State Manifest exceeds the size limit");
    }
    serde_json::from_slice(&bytes).context("parse Workspace Project State Manifest")
}

fn validate_manifest(
    manifest: WorkspaceProjectStateManifest,
) -> Result<WorkspaceProjectStateResponse> {
    if manifest.schema_version != SCHEMA_VERSION {
        bail!("unsupported Workspace Project State Manifest schema");
    }
    if manifest.revision == 0 || manifest.revision > MAX_SAFE_INTEGER {
        bail!("Workspace Project State Manifest revision is invalid");
    }
    if manifest.project.steps.len() > MAX_STEPS {
        bail!("Workspace Project State Manifest contains too many steps");
    }

    let title = validate_text(
        manifest.project.title,
        MAX_TITLE_CHARS,
        "Workspace Project title",
    )?;
    let summary = validate_text(
        manifest.project.summary,
        MAX_SUMMARY_CHARS,
        "Workspace Project summary",
    )?;
    let mut step_ids = HashSet::new();
    let mut steps = Vec::with_capacity(manifest.project.steps.len());
    for step in manifest.project.steps {
        validate_step_id(&step.step_id)?;
        if !step_ids.insert(step.step_id.clone()) {
            bail!("Workspace Project step id is duplicated");
        }
        steps.push(WorkspaceProjectStep {
            step_id: step.step_id,
            label: validate_text(
                step.label,
                MAX_STEP_LABEL_CHARS,
                "Workspace Project step label",
            )?,
            status: step.status,
        });
    }

    Ok(WorkspaceProjectStateResponse {
        schema_version: SCHEMA_VERSION,
        revision: manifest.revision,
        project: Some(WorkspaceProjectState {
            title,
            status: manifest.project.status,
            summary,
            steps,
        }),
    })
}

fn validate_text(value: String, max_chars: usize, label: &str) -> Result<String> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.chars().count() > max_chars || value.chars().any(char::is_control)
    {
        bail!("{label} is invalid");
    }
    Ok(value)
}

fn validate_step_id(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_STEP_ID_BYTES
        || (!bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit())
        || (!bytes[bytes.len() - 1].is_ascii_lowercase()
            && !bytes[bytes.len() - 1].is_ascii_digit())
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        bail!("Workspace Project step id is invalid");
    }
    Ok(())
}

fn require_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).with_context(|| format!("inspect {label}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("{label} is not a real directory");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_workspace(temp: &tempfile::TempDir) -> (AgentRegistry, PathBuf) {
        let state_home = temp.path().canonicalize().expect("canonical tempdir");
        let registry = AgentRegistry::in_home(state_home);
        let record = registry
            .prepare_activation(41, "job-agent")
            .expect("activate Job Agent");
        let workspace = PathBuf::from(record.workspace_dir.expect("Workspace"));
        (registry, workspace)
    }

    fn write_manifest(workspace: &Path, manifest: &str) {
        fs::create_dir_all(workspace.join(CONTROL_DIRECTORY)).expect("create control directory");
        fs::write(
            workspace.join(CONTROL_DIRECTORY).join(MANIFEST_FILE),
            manifest,
        )
        .expect("write manifest");
    }

    #[test]
    fn missing_manifest_returns_an_empty_projection_without_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, _workspace) = active_workspace(&temp);

        let result = get(&registry, 41, "job-agent").expect("empty project state");
        let json = serde_json::to_value(&result).expect("serialize project state");

        assert_eq!(result, empty_response());
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["revision"], 0);
        assert!(json["project"].is_null());
        assert!(json.get("workspaceDir").is_none());
    }

    #[test]
    fn valid_manifest_projects_only_trimmed_safe_fields() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, workspace) = active_workspace(&temp);
        write_manifest(
            &workspace,
            r#"{
              "schemaVersion": 1,
              "revision": 8,
              "project": {
                "title": "  产品岗位第 3 轮  ",
                "status": "waiting_for_user",
                "summary": "  请确认下一批重点岗位。  ",
                "steps": [{
                  "stepId": "confirm-target",
                  "label": "  确认目标岗位  ",
                  "status": "completed"
                }]
              }
            }"#,
        );

        let result = get(&registry, 41, "job-agent").expect("project state");
        let project = result.project.expect("project");
        let json = serde_json::to_string(&project).expect("serialize project");

        assert_eq!(result.revision, 8);
        assert_eq!(project.title, "产品岗位第 3 轮");
        assert_eq!(project.summary, "请确认下一批重点岗位。");
        assert_eq!(project.steps[0].label, "确认目标岗位");
        for forbidden in [
            "workspaceDir",
            "mainSessionId",
            "ownerAccountId",
            "relativePath",
            "nextCommand",
        ] {
            assert!(!json.contains(forbidden));
        }
    }

    #[test]
    fn malformed_manifests_fail_the_whole_projection() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, workspace) = active_workspace(&temp);
        for manifest in [
            r#"{"schemaVersion":1,"revision":1,"unknown":true,"project":{"title":"A","status":"active","summary":"B","steps":[]}}"#,
            r#"{"schemaVersion":1,"revision":0,"project":{"title":"A","status":"active","summary":"B","steps":[]}}"#,
            r#"{"schemaVersion":1,"revision":1,"project":{"title":"A","status":"future","summary":"B","steps":[]}}"#,
            r#"{"schemaVersion":1,"revision":1,"project":{"title":"A","status":"active","summary":"B","steps":[{"stepId":"same","label":"A","status":"pending"},{"stepId":"same","label":"B","status":"completed"}]}}"#,
            r#"{"schemaVersion":1,"revision":1,"project":{"title":"A","status":"active","summary":"B","steps":[{"stepId":"../escape","label":"A","status":"pending"}]}}"#,
            "{\"schemaVersion\":1,\"revision\":1,\"project\":{\"title\":\"A\\u0085B\",\"status\":\"active\",\"summary\":\"B\",\"steps\":[]}}",
        ] {
            write_manifest(&workspace, manifest);
            assert!(get(&registry, 41, "job-agent").is_err(), "{manifest}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_manifest_is_rejected() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, workspace) = active_workspace(&temp);
        fs::create_dir_all(workspace.join(CONTROL_DIRECTORY)).expect("control directory");
        let outside = temp.path().join("outside.json");
        fs::write(
            &outside,
            r#"{"schemaVersion":1,"revision":1,"project":{"title":"A","status":"active","summary":"B","steps":[]}}"#,
        )
        .expect("outside manifest");
        symlink(
            &outside,
            workspace.join(CONTROL_DIRECTORY).join(MANIFEST_FILE),
        )
        .expect("manifest symlink");

        assert!(get(&registry, 41, "job-agent").is_err());
    }

    #[test]
    fn inactive_or_other_account_agents_cannot_be_used_as_workspace_authority() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, _workspace) = active_workspace(&temp);

        assert!(get(&registry, 41, "lecturecast-agent").is_err());
        assert!(get(&registry, 42, "job-agent").is_err());
    }
}
