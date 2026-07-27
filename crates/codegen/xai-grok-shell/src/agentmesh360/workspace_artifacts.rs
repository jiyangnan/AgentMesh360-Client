use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use super::registry::AgentRegistry;

const SCHEMA_VERSION: u8 = 1;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_ARTIFACTS: usize = 100;
const MAX_ARTIFACT_ID_BYTES: usize = 64;
const MAX_TITLE_CHARS: usize = 120;
const MAX_RELATIVE_PATH_BYTES: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CONTROL_DIRECTORY: &str = ".agentmesh360";
const MANIFEST_FILE: &str = "artifacts-v1.json";
const ARTIFACTS_DIRECTORY: &str = "artifacts";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceArtifactListRequest {
    pub(crate) agent_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceArtifactList {
    schema_version: u8,
    revision: u64,
    artifacts: Vec<WorkspaceArtifact>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceArtifact {
    artifact_id: String,
    title: String,
    kind: String,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceArtifactManifest {
    schema_version: u8,
    revision: u64,
    artifacts: Vec<ManifestArtifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestArtifact {
    artifact_id: String,
    title: String,
    kind: String,
    relative_path: String,
}

#[derive(Debug, Hash, PartialEq, Eq)]
#[cfg(unix)]
struct ArtifactFileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Debug, Hash, PartialEq, Eq)]
#[cfg(not(unix))]
struct ArtifactFileIdentity(PathBuf);

struct ValidatedArtifactFile {
    size_bytes: u64,
    identity: ArtifactFileIdentity,
}

pub(crate) fn list(
    registry: &AgentRegistry,
    owner_account_id: i64,
    agent_id: &str,
) -> Result<WorkspaceArtifactList> {
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
                bail!("Workspace Artifact control directory is invalid");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_list());
        }
        Err(error) => {
            return Err(error).context("inspect Workspace Artifact control directory");
        }
    }

    let manifest_path = control_directory.join(MANIFEST_FILE);
    let manifest_metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_list());
        }
        Err(error) => return Err(error).context("inspect Workspace Artifact Manifest"),
    };
    if manifest_metadata.file_type().is_symlink() || !manifest_metadata.is_file() {
        bail!("Workspace Artifact Manifest is not a regular file");
    }
    if manifest_metadata.len() > MAX_MANIFEST_BYTES {
        bail!("Workspace Artifact Manifest exceeds the size limit");
    }

    let manifest = read_manifest(&manifest_path)?;
    validate_manifest(&workspace, manifest)
}

fn empty_list() -> WorkspaceArtifactList {
    WorkspaceArtifactList {
        schema_version: SCHEMA_VERSION,
        revision: 0,
        artifacts: Vec::new(),
    }
}

fn read_manifest(path: &Path) -> Result<WorkspaceArtifactManifest> {
    let mut bytes = Vec::new();
    File::open(path)
        .context("open Workspace Artifact Manifest")?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("read Workspace Artifact Manifest")?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        bail!("Workspace Artifact Manifest exceeds the size limit");
    }
    serde_json::from_slice(&bytes).context("parse Workspace Artifact Manifest")
}

fn validate_manifest(
    workspace: &Path,
    manifest: WorkspaceArtifactManifest,
) -> Result<WorkspaceArtifactList> {
    if manifest.schema_version != SCHEMA_VERSION {
        bail!("unsupported Workspace Artifact Manifest schema");
    }
    if manifest.revision == 0 || manifest.revision > MAX_SAFE_INTEGER {
        bail!("Workspace Artifact Manifest revision is invalid");
    }
    if manifest.artifacts.len() > MAX_ARTIFACTS {
        bail!("Workspace Artifact Manifest contains too many artifacts");
    }

    let mut artifact_ids = HashSet::new();
    let mut relative_paths = HashSet::new();
    let mut file_identities = HashSet::new();
    let mut artifacts = Vec::with_capacity(manifest.artifacts.len());
    for artifact in manifest.artifacts {
        validate_artifact_id(&artifact.artifact_id)?;
        if !artifact_ids.insert(artifact.artifact_id.clone()) {
            bail!("Workspace Artifact id is duplicated");
        }
        let title = artifact.title.trim().to_owned();
        if title.is_empty()
            || title.chars().count() > MAX_TITLE_CHARS
            || title.chars().any(char::is_control)
        {
            bail!("Workspace Artifact title is invalid");
        }
        validate_kind(&artifact.kind)?;
        let components = validate_relative_path(&artifact.relative_path)?;
        let normalized_path = components.join("/");
        if !relative_paths.insert(normalized_path) {
            bail!("Workspace Artifact path is duplicated");
        }
        let file = validate_artifact_file(workspace, &components)?;
        if !file_identities.insert(file.identity) {
            bail!("Workspace Artifact target is duplicated");
        }
        artifacts.push(WorkspaceArtifact {
            artifact_id: artifact.artifact_id,
            title,
            kind: artifact.kind,
            size_bytes: file.size_bytes,
        });
    }

    Ok(WorkspaceArtifactList {
        schema_version: SCHEMA_VERSION,
        revision: manifest.revision,
        artifacts,
    })
}

fn validate_artifact_id(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_ARTIFACT_ID_BYTES
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        bail!("Workspace Artifact id is invalid");
    }
    Ok(())
}

fn validate_kind(value: &str) -> Result<()> {
    if !matches!(
        value,
        "document" | "image" | "audio" | "video" | "archive" | "code" | "data" | "other"
    ) {
        bail!("Workspace Artifact kind is invalid");
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<Vec<String>> {
    if value.is_empty() || value.len() > MAX_RELATIVE_PATH_BYTES {
        bail!("Workspace Artifact path is invalid");
    }
    let path = Path::new(value);
    if path.is_absolute() {
        bail!("Workspace Artifact path must be relative");
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| anyhow!("Workspace Artifact path is not UTF-8"))?;
                components.push(value.to_owned());
            }
            _ => bail!("Workspace Artifact path contains an invalid component"),
        }
    }
    if components.len() < 2 || components.first().map(String::as_str) != Some(ARTIFACTS_DIRECTORY) {
        bail!("Workspace Artifact path must start with artifacts/");
    }
    Ok(components)
}

fn validate_artifact_file(
    workspace: &Path,
    components: &[String],
) -> Result<ValidatedArtifactFile> {
    let artifacts_directory = workspace.join(ARTIFACTS_DIRECTORY);
    require_real_directory(&artifacts_directory, "Workspace Artifact directory")?;

    let mut current = workspace.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .with_context(|| format!("inspect Workspace Artifact component {index}"))?;
        if metadata.file_type().is_symlink() {
            bail!("Workspace Artifact path contains a symbolic link");
        }
        if index + 1 == components.len() {
            if !metadata.is_file() {
                bail!("Workspace Artifact target is not a regular file");
            }
            if metadata.len() > MAX_SAFE_INTEGER {
                bail!("Workspace Artifact file size is invalid");
            }
            return Ok(ValidatedArtifactFile {
                size_bytes: metadata.len(),
                identity: artifact_file_identity(&current, &metadata)?,
            });
        }
        if !metadata.is_dir() {
            bail!("Workspace Artifact intermediate component is not a directory");
        }
    }
    bail!("Workspace Artifact path is incomplete")
}

#[cfg(unix)]
fn artifact_file_identity(_path: &Path, metadata: &fs::Metadata) -> Result<ArtifactFileIdentity> {
    use std::os::unix::fs::MetadataExt as _;

    Ok(ArtifactFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(unix))]
fn artifact_file_identity(path: &Path, _metadata: &fs::Metadata) -> Result<ArtifactFileIdentity> {
    fs::canonicalize(path)
        .map(ArtifactFileIdentity)
        .context("resolve Workspace Artifact target")
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
    fn missing_manifest_returns_an_empty_revision_without_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, _workspace) = active_workspace(&temp);

        let result = list(&registry, 41, "job-agent").expect("empty artifact list");
        let json = serde_json::to_value(&result).expect("serialize artifact list");

        assert_eq!(result, empty_list());
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["revision"], 0);
        assert_eq!(json["artifacts"], serde_json::json!([]));
        assert!(json.get("workspaceDir").is_none());
    }

    #[test]
    fn valid_manifest_projects_only_safe_metadata_and_real_file_size() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, workspace) = active_workspace(&temp);
        fs::create_dir_all(workspace.join("artifacts/reports")).expect("create artifacts");
        fs::write(workspace.join("artifacts/reports/role-fit.pdf"), b"report")
            .expect("write artifact");
        write_manifest(
            &workspace,
            r#"{
              "schemaVersion": 1,
              "revision": 3,
              "artifacts": [{
                "artifactId": "role-fit-report",
                "title": "  岗位匹配报告  ",
                "kind": "document",
                "relativePath": "artifacts/reports/role-fit.pdf"
              }]
            }"#,
        );

        let result = list(&registry, 41, "job-agent").expect("artifact list");
        let json = serde_json::to_string(&result).expect("serialize artifact list");

        assert_eq!(result.revision, 3);
        assert_eq!(result.artifacts[0].title, "岗位匹配报告");
        assert_eq!(result.artifacts[0].size_bytes, 6);
        for forbidden in [
            "relativePath",
            "role-fit.pdf",
            "workspaceDir",
            "mainSessionId",
            "ownerAccountId",
        ] {
            assert!(!json.contains(forbidden));
        }
    }

    #[test]
    fn invalid_manifest_or_path_fails_the_whole_projection() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, workspace) = active_workspace(&temp);
        fs::create_dir_all(workspace.join("artifacts")).expect("create artifacts");
        fs::write(workspace.join("artifacts/valid.txt"), b"valid").expect("write artifact");

        for manifest in [
            r#"{"schemaVersion":1,"revision":1,"unknown":true,"artifacts":[]}"#,
            r#"{"schemaVersion":1,"revision":0,"artifacts":[]}"#,
            r#"{"schemaVersion":1,"revision":1,"artifacts":[
              {"artifactId":"same","title":"A","kind":"document","relativePath":"artifacts/valid.txt"},
              {"artifactId":"same","title":"B","kind":"document","relativePath":"artifacts/valid.txt"}
            ]}"#,
            r#"{"schemaVersion":1,"revision":1,"artifacts":[
              {"artifactId":"escape","title":"Escape","kind":"document","relativePath":"artifacts/../outside.txt"}
            ]}"#,
            r#"{"schemaVersion":1,"revision":1,"artifacts":[
              {"artifactId":"bad-kind","title":"Bad","kind":"future","relativePath":"artifacts/valid.txt"}
            ]}"#,
        ] {
            write_manifest(&workspace, manifest);
            assert!(list(&registry, 41, "job-agent").is_err(), "{manifest}");
        }
    }

    #[test]
    fn multiple_paths_to_the_same_file_are_rejected_as_duplicate_targets() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, workspace) = active_workspace(&temp);
        fs::create_dir_all(workspace.join("artifacts")).expect("create artifacts");
        fs::write(workspace.join("artifacts/report.txt"), b"report").expect("write artifact");
        fs::hard_link(
            workspace.join("artifacts/report.txt"),
            workspace.join("artifacts/report-alias.txt"),
        )
        .expect("create alias");
        write_manifest(
            &workspace,
            r#"{"schemaVersion":1,"revision":1,"artifacts":[
              {"artifactId":"report","title":"Report","kind":"document","relativePath":"artifacts/report.txt"},
              {"artifactId":"report-alias","title":"Report alias","kind":"document","relativePath":"artifacts/report-alias.txt"}
            ]}"#,
        );

        assert!(list(&registry, 41, "job-agent").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_rejected_at_the_manifest_and_artifact_boundaries() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, workspace) = active_workspace(&temp);
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"secret").expect("outside file");
        fs::create_dir_all(workspace.join("artifacts")).expect("create artifacts");
        symlink(&outside, workspace.join("artifacts/linked.txt")).expect("artifact symlink");
        write_manifest(
            &workspace,
            r#"{"schemaVersion":1,"revision":1,"artifacts":[{
              "artifactId":"linked","title":"Linked","kind":"document",
              "relativePath":"artifacts/linked.txt"
            }]}"#,
        );
        assert!(list(&registry, 41, "job-agent").is_err());

        fs::remove_file(workspace.join(CONTROL_DIRECTORY).join(MANIFEST_FILE))
            .expect("remove manifest");
        let outside_manifest = temp.path().join("manifest.json");
        fs::write(
            &outside_manifest,
            r#"{"schemaVersion":1,"revision":1,"artifacts":[]}"#,
        )
        .expect("outside manifest");
        symlink(
            &outside_manifest,
            workspace.join(CONTROL_DIRECTORY).join(MANIFEST_FILE),
        )
        .expect("manifest symlink");
        assert!(list(&registry, 41, "job-agent").is_err());
    }

    #[test]
    fn inactive_or_other_account_agents_cannot_be_used_as_workspace_authority() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (registry, _workspace) = active_workspace(&temp);

        assert!(list(&registry, 41, "lecturecast-agent").is_err());
        assert!(list(&registry, 42, "job-agent").is_err());
    }
}
