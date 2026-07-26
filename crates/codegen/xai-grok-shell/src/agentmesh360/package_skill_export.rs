//! Deterministic Host Skill exports derived only from an H1-verified Package.
//!
//! The loose authoring projection is never allowed to select Package files by
//! itself. The exact Host bundle plan is inventory-covered inside the signed
//! Artifact, and this module requires the projection to match that signed plan
//! before it emits any host-facing bytes. This crate-internal primitive is
//! intentionally not exposed through a self-trusting CLI; H2d2 release
//! assembly is its first planned non-test caller.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use super::agent_packages::{AgentPackageManifest, SkillHost};
use super::package_artifact::{
    FILE_MANIFEST_PATH, FILE_MANIFEST_SCHEMA_VERSION, HOST_SKILL_PLAN_PATH, MAX_ARTIFACT_BYTES,
    MAX_FILE_BYTES, PACKAGE_MANIFEST_PATH, PackageFileManifest, PackageFileRecord,
    VerifiedStagedPackage, normalized_package_path, validate_sha256, verify_installed_package_tree,
};
use super::package_authoring::{
    HOST_PROJECTION_SCHEMA_VERSION, HOST_SKILL_PLAN_SCHEMA_VERSION, HostSkillPlan,
    HostSkillProjection, MAX_HOST_PROJECTION_BYTES, create_new_private_directory,
    deterministic_archive, sha256_hex, validate_output_file_name, write_new_private_file,
};

const HOST_SKILL_EXPORT_SCHEMA_VERSION: u32 = 1;
const HOST_SKILL_EXPORT_MANIFEST_PATH: &str = "agentmesh-host-skill.v1.json";
const HOST_SKILL_PAYLOAD_PREFIX: &str = "payload";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSkillExportManifest {
    schema_version: u32,
    package_id: String,
    agent_id: String,
    version: String,
    publisher: String,
    source_artifact_sha256: String,
    source_plan_sha256: String,
    signature_key_id: String,
    host: SkillHost,
    entrypoint: HostSkillExportPath,
    files: Vec<HostSkillExportPath>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSkillExportPath {
    package_path: String,
    bundle_path: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSkillExportReceipt {
    package_id: String,
    agent_id: String,
    version: String,
    source_artifact_sha256: String,
    source_projection_sha256: String,
    source_plan_sha256: String,
    signature_key_id: String,
    bundles: Vec<HostSkillBundleReceipt>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSkillBundleReceipt {
    host: SkillHost,
    entrypoint: String,
    bundle_path: PathBuf,
    bundle_sha256: String,
}

#[derive(Debug)]
pub(crate) struct HostSkillExportSet {
    package_id: String,
    agent_id: String,
    version: String,
    source_artifact_sha256: String,
    source_projection_sha256: String,
    source_plan_sha256: String,
    signature_key_id: String,
    bundles: Vec<HostSkillBundle>,
}

impl HostSkillExportReceipt {
    pub(super) fn package_id(&self) -> &str {
        &self.package_id
    }

    pub(super) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(super) fn version(&self) -> &str {
        &self.version
    }

    pub(super) fn source_artifact_sha256(&self) -> &str {
        &self.source_artifact_sha256
    }

    pub(super) fn source_plan_sha256(&self) -> &str {
        &self.source_plan_sha256
    }

    pub(super) fn source_projection_sha256(&self) -> &str {
        &self.source_projection_sha256
    }

    pub(super) fn signature_key_id(&self) -> &str {
        &self.signature_key_id
    }

    pub(super) fn bundles(&self) -> &[HostSkillBundleReceipt] {
        &self.bundles
    }

    #[cfg(test)]
    pub(super) fn remove_last_bundle_for_test(&mut self) {
        self.bundles.pop();
    }

    #[cfg(test)]
    pub(super) fn duplicate_first_bundle_for_test(&mut self) {
        if let Some(bundle) = self.bundles.first().cloned() {
            self.bundles.push(bundle);
        }
    }

    #[cfg(test)]
    pub(super) fn replace_version_for_test(&mut self, version: &str) {
        self.version = version.to_owned();
    }

    #[cfg(test)]
    pub(super) fn replace_first_bundle_host_for_test(&mut self, host: SkillHost) {
        if let Some(bundle) = self.bundles.first_mut() {
            bundle.host = host;
        }
    }
}

impl HostSkillBundleReceipt {
    pub(super) fn host(&self) -> SkillHost {
        self.host
    }

    pub(super) fn entrypoint(&self) -> &str {
        &self.entrypoint
    }

    pub(super) fn bundle_path(&self) -> &Path {
        &self.bundle_path
    }

    pub(super) fn bundle_sha256(&self) -> &str {
        &self.bundle_sha256
    }
}

#[derive(Debug)]
struct HostSkillBundle {
    host: SkillHost,
    entrypoint: String,
    file_name: String,
    archive: Vec<u8>,
    sha256: String,
}

impl HostSkillExportSet {
    pub(crate) fn write_to_new_directory(
        self,
        output_dir: &Path,
    ) -> Result<HostSkillExportReceipt> {
        create_new_private_directory(output_dir)?;
        let result = (|| {
            let mut receipts = Vec::with_capacity(self.bundles.len());
            for bundle in self.bundles {
                let bundle_path = output_dir.join(&bundle.file_name);
                write_new_private_file(&bundle_path, &bundle.archive)?;
                receipts.push(HostSkillBundleReceipt {
                    host: bundle.host,
                    entrypoint: bundle.entrypoint,
                    bundle_path,
                    bundle_sha256: bundle.sha256,
                });
            }
            Ok(HostSkillExportReceipt {
                package_id: self.package_id,
                agent_id: self.agent_id,
                version: self.version,
                source_artifact_sha256: self.source_artifact_sha256,
                source_projection_sha256: self.source_projection_sha256,
                source_plan_sha256: self.source_plan_sha256,
                signature_key_id: self.signature_key_id,
                bundles: receipts,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(output_dir);
        }
        result
    }
}

pub(crate) fn export_verified_host_skills(
    verified: &VerifiedStagedPackage,
    projection_document: &[u8],
) -> Result<HostSkillExportSet> {
    if projection_document.is_empty() || projection_document.len() > MAX_HOST_PROJECTION_BYTES {
        bail!("Host Skill projection size is invalid");
    }
    let projection_sha256 = sha256_hex(projection_document);
    let projection: HostSkillProjection = serde_json::from_slice(projection_document)
        .context("parse Host Skill authoring projection")?;
    if projection.schema_version != HOST_PROJECTION_SCHEMA_VERSION {
        bail!(
            "unsupported Host Skill projection schema version: {}",
            projection.schema_version
        );
    }
    validate_sha256("artifactSha256", &projection.artifact_sha256)?;
    validate_sha256("planSha256", &projection.plan_sha256)?;
    if projection.artifact_sha256 != verified.artifact_sha256 {
        bail!("Host Skill projection belongs to a different Package Artifact");
    }

    let verified_manifest =
        verify_installed_package_tree(verified.staging_path(), &verified.file_manifest_sha256)
            .context("reverify staged Package before Host Skill export")?;
    if verified_manifest != verified.manifest {
        bail!("staged Package Manifest changed after Artifact verification");
    }

    let plan_document = read_bounded_regular_file(
        &verified.staging_path().join(HOST_SKILL_PLAN_PATH),
        MAX_HOST_PROJECTION_BYTES as u64,
    )
    .context("read signed Host Skill plan")?;
    if sha256_hex(&plan_document) != projection.plan_sha256 {
        bail!("Host Skill projection plan digest does not match the signed Package");
    }
    let signed_plan: HostSkillPlan =
        serde_json::from_slice(&plan_document).context("parse signed Host Skill plan")?;
    if signed_plan != projection.plan {
        bail!("Host Skill projection does not equal the signed Package plan");
    }

    let inventory = load_signed_inventory(verified.staging_path())?;
    validate_signed_plan(&signed_plan, &verified.manifest, &inventory)?;

    let mut bundles = signed_plan.skill_bundles.clone();
    bundles.sort_by_key(|bundle| bundle.host.as_str());
    let mut exports = Vec::with_capacity(bundles.len());
    for bundle in bundles {
        let mut records = bundle.files;
        records.sort_by(|left, right| left.path.cmp(&right.path));
        let mut archive_files = BTreeMap::new();
        let mut exported_files = Vec::with_capacity(records.len());
        for record in &records {
            let contents = read_verified_package_file(verified.staging_path(), record)?;
            let bundle_path = payload_path(&record.path)?;
            archive_files.insert(bundle_path.clone(), contents);
            exported_files.push(HostSkillExportPath {
                package_path: record.path.clone(),
                bundle_path,
                size: record.size,
                sha256: record.sha256.clone(),
            });
        }
        let entrypoint = exported_files
            .iter()
            .find(|file| file.package_path == bundle.entrypoint)
            .cloned()
            .ok_or_else(|| anyhow!("signed Host Skill plan omits its adapter entrypoint"))?;
        let export_manifest = HostSkillExportManifest {
            schema_version: HOST_SKILL_EXPORT_SCHEMA_VERSION,
            package_id: signed_plan.package_id.clone(),
            agent_id: signed_plan.agent_id.clone(),
            version: signed_plan.version.clone(),
            publisher: signed_plan.publisher.clone(),
            source_artifact_sha256: verified.artifact_sha256.clone(),
            source_plan_sha256: projection.plan_sha256.clone(),
            signature_key_id: verified.signature_key_id.clone(),
            host: bundle.host,
            entrypoint,
            files: exported_files,
        };
        archive_files.insert(
            HOST_SKILL_EXPORT_MANIFEST_PATH.to_owned(),
            serde_json::to_vec(&export_manifest).context("serialize Host Skill export manifest")?,
        );
        let archive = deterministic_archive(&archive_files)?;
        if archive.is_empty() || archive.len() as u64 > MAX_ARTIFACT_BYTES {
            bail!("Host Skill export archive size is outside the allowed range");
        }
        let file_name = format!(
            "{}-{}-{}.amskill.tar.zst",
            signed_plan.package_id,
            signed_plan.version,
            bundle.host.as_str()
        );
        validate_output_file_name(&file_name)?;
        exports.push(HostSkillBundle {
            host: bundle.host,
            entrypoint: bundle.entrypoint,
            file_name,
            sha256: sha256_hex(&archive),
            archive,
        });
    }

    Ok(HostSkillExportSet {
        package_id: signed_plan.package_id,
        agent_id: signed_plan.agent_id,
        version: signed_plan.version,
        source_artifact_sha256: verified.artifact_sha256.clone(),
        source_projection_sha256: projection_sha256,
        source_plan_sha256: projection.plan_sha256,
        signature_key_id: verified.signature_key_id.clone(),
        bundles: exports,
    })
}

fn validate_signed_plan(
    plan: &HostSkillPlan,
    manifest: &AgentPackageManifest,
    inventory: &HashMap<String, PackageFileRecord>,
) -> Result<()> {
    if plan.schema_version != HOST_SKILL_PLAN_SCHEMA_VERSION
        || plan.package_id != manifest.package_id
        || plan.agent_id != manifest.agent.agent_id
        || plan.version != manifest.version
        || plan.publisher != manifest.publisher
        || plan.requested_permissions != manifest.requested_permissions
    {
        bail!("signed Host Skill plan identity does not match its Package Manifest");
    }
    if plan.canonical_workflow.path != manifest.skills.canonical_workflow {
        bail!("signed Host Skill plan canonical workflow does not match its Manifest");
    }
    validate_inventory_record(&plan.canonical_workflow, inventory)?;

    if plan.skill_bundles.len() != manifest.skills.adapters.len() {
        bail!("signed Host Skill plan does not cover every Manifest adapter");
    }
    let adapters = manifest
        .skills
        .adapters
        .iter()
        .map(|adapter| (adapter.host, adapter.path.as_str()))
        .collect::<HashMap<_, _>>();
    let mut hosts = HashSet::new();
    for bundle in &plan.skill_bundles {
        if !hosts.insert(bundle.host) || bundle.files.is_empty() {
            bail!("signed Host Skill plan contains a duplicate or empty host bundle");
        }
        let expected_entrypoint = adapters
            .get(&bundle.host)
            .ok_or_else(|| anyhow!("signed Host Skill plan contains an unknown host"))?;
        if bundle.entrypoint != *expected_entrypoint {
            bail!("signed Host Skill plan entrypoint does not match its Manifest adapter");
        }
        let mut files = HashSet::new();
        for record in &bundle.files {
            if !files.insert(record.path.as_str()) {
                bail!("signed Host Skill plan contains a duplicate bundle file");
            }
            if matches!(
                record.path.as_str(),
                PACKAGE_MANIFEST_PATH | FILE_MANIFEST_PATH | HOST_SKILL_PLAN_PATH
            ) {
                bail!("signed Host Skill plan contains a reserved Package file");
            }
            validate_inventory_record(record, inventory)?;
        }
        if !files.contains(bundle.entrypoint.as_str()) {
            bail!("signed Host Skill plan omits its Manifest adapter entrypoint");
        }
    }
    Ok(())
}

fn validate_inventory_record(
    record: &PackageFileRecord,
    inventory: &HashMap<String, PackageFileRecord>,
) -> Result<()> {
    normalized_package_path(Path::new(&record.path))?;
    validate_sha256("Host Skill files.sha256", &record.sha256)?;
    let signed = inventory
        .get(&record.path)
        .ok_or_else(|| anyhow!("Host Skill plan references a file outside signed inventory"))?;
    if signed != record {
        bail!("Host Skill plan file record differs from signed inventory");
    }
    Ok(())
}

fn load_signed_inventory(staging_root: &Path) -> Result<HashMap<String, PackageFileRecord>> {
    let document =
        read_bounded_regular_file(&staging_root.join(FILE_MANIFEST_PATH), MAX_FILE_BYTES)
            .context("read signed Package file inventory for Host Skill export")?;
    let manifest: PackageFileManifest =
        serde_json::from_slice(&document).context("parse signed Package file inventory")?;
    if manifest.schema_version != FILE_MANIFEST_SCHEMA_VERSION {
        bail!("signed Package file inventory schema is unsupported");
    }
    Ok(manifest
        .files
        .into_iter()
        .map(|record| (record.path.clone(), record))
        .collect())
}

fn read_verified_package_file(staging_root: &Path, record: &PackageFileRecord) -> Result<Vec<u8>> {
    let relative = normalized_package_path(Path::new(&record.path))?;
    let contents = read_bounded_regular_file(&staging_root.join(relative), MAX_FILE_BYTES)
        .with_context(|| format!("read verified Host Skill file {}", record.path))?;
    if contents.len() as u64 != record.size || sha256_hex(&contents) != record.sha256 {
        bail!("Host Skill source changed after Package verification");
    }
    Ok(contents)
}

pub(super) fn read_bounded_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>> {
    let inspected = fs::symlink_metadata(path)
        .with_context(|| format!("inspect Host Skill export input {}", path.display()))?;
    if inspected.file_type().is_symlink() || !inspected.is_file() || inspected.len() > max_bytes {
        bail!("Host Skill export input is not an allowed regular file");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open Host Skill export input {}", path.display()))?;
    let opened = file
        .metadata()
        .with_context(|| format!("inspect opened Host Skill export input {}", path.display()))?;
    if !opened.is_file() || opened.len() > max_bytes {
        bail!("opened Host Skill export input is not an allowed regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;

        if inspected.dev() != opened.dev() || inspected.ino() != opened.ino() {
            bail!("Host Skill export input changed while it was opened");
        }
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read Host Skill export input {}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        bail!("Host Skill export input exceeds the allowed size");
    }
    Ok(bytes)
}

fn payload_path(package_path: &str) -> Result<String> {
    let value = format!("{HOST_SKILL_PAYLOAD_PREFIX}/{package_path}");
    normalized_package_path(Path::new(&value))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::super::agent_packages::{AgentPackageCatalog, PackagePermission};
    use super::super::package_artifact::{
        PackageArtifactVerifier, PackageSignatureEnvelope, SIGNATURE_SCHEMA_VERSION,
        signature_payload,
    };
    use super::super::package_authoring::build_package;
    use super::super::package_registry_snapshot::{
        HostBundleLocation, ReleaseChannelLocations, bind_verified_release_record,
    };
    use super::super::package_release::assemble_agent_release;
    use super::super::package_trust::{TrustedPublisherKey, TrustedPublisherStore};
    use super::*;

    const TEST_KEY_ID: &str = "agentmesh360-host-export-test";
    const FUTURE_MANIFEST: &str = r#"
schemaVersion = 1
packageId = "com.agentmesh360.future-agent"
version = "1.0.0"
publisher = "agentmesh360"
sourceRepository = "https://github.com/agentmesh360/future-agent"
requestedPermissions = ["local_files"]

[agent]
agentId = "future-agent"
displayName = "Future Agent"
description = "Same-repository onboarding smoke without a built-in Client Catalog entry."
sortOrder = 90

[persistence]
mainSessionStrategy = "account_agent_stable_v5"
workspaceStrategy = "account_agent_directory"

[runtime]
promptMode = "extend"
discoverSkills = true
inheritSkills = true
agentsMd = true
promptBody = "You are the persistent Future Agent."

[modelPolicy]
tools = "preferred"
streaming = "preferred"

[skills]
canonicalWorkflow = "docs/agent-onboarding.md"

[[skills.adapters]]
host = "claude-code"
path = "skills/claude-code/SKILL.md"

[[skills.adapters]]
host = "openclaw"
path = "skills/openclaw-future-agent/SKILL.md"
"#;
    const FUTURE_AUTHORING: &str = r#"
schemaVersion = 1
packageFiles = []

[[skillBundles]]
host = "claude-code"
files = [
  "skills/claude-code/README.md",
  "skills/claude-code/SKILL.md",
]

[[skillBundles]]
host = "openclaw"
files = ["skills/openclaw-future-agent/SKILL.md"]
"#;
    const ZERO_ADAPTER_MANIFEST: &str = r#"
schemaVersion = 1
packageId = "com.agentmesh360.zero-adapter-agent"
version = "1.0.0"
publisher = "agentmesh360"
sourceRepository = "https://github.com/agentmesh360/zero-adapter-agent"
requestedPermissions = ["local_files"]

[agent]
agentId = "zero-adapter-agent"
displayName = "Zero Adapter Agent"
description = "Persistent client Agent without a fabricated Host Skill adapter."
sortOrder = 91

[persistence]
mainSessionStrategy = "account_agent_stable_v5"
workspaceStrategy = "account_agent_directory"

[runtime]
promptMode = "extend"
discoverSkills = true
inheritSkills = true
agentsMd = true
promptBody = "You are the persistent Zero Adapter Agent."

[modelPolicy]
tools = "preferred"
streaming = "preferred"

[skills]
canonicalWorkflow = "AGENTS.md"
"#;
    const ZERO_ADAPTER_AUTHORING: &str = r#"
schemaVersion = 1
packageFiles = []
skillBundles = []
"#;

    #[test]
    fn same_repository_onboarding_exports_deterministic_verified_host_bundles() {
        let fixture = ExportFixture::new();
        assert!(
            AgentPackageCatalog::builtin()
                .expect("built-in Catalog")
                .package_for_agent("future-agent")
                .is_err()
        );
        assert_eq!(fixture.verified.manifest.agent.agent_id, "future-agent");
        let first =
            export_verified_host_skills(&fixture.verified, &fixture.projection).expect("export");
        let second =
            export_verified_host_skills(&fixture.verified, &fixture.projection).expect("export");
        assert_eq!(first.bundles.len(), 2);
        assert_eq!(first.bundles[0].host, SkillHost::ClaudeCode);
        assert_eq!(first.bundles[0].archive, second.bundles[0].archive);
        assert_eq!(first.bundles[1].archive, second.bundles[1].archive);

        let files = archive_files(&first.bundles[0].archive);
        assert_eq!(
            files.keys().cloned().collect::<Vec<_>>(),
            vec![
                HOST_SKILL_EXPORT_MANIFEST_PATH.to_owned(),
                "payload/skills/claude-code/README.md".to_owned(),
                "payload/skills/claude-code/SKILL.md".to_owned(),
            ]
        );
        let manifest: HostSkillExportManifest = serde_json::from_slice(
            files
                .get(HOST_SKILL_EXPORT_MANIFEST_PATH)
                .expect("export manifest"),
        )
        .expect("parse export manifest");
        assert_eq!(manifest.host, SkillHost::ClaudeCode);
        assert_eq!(
            manifest.entrypoint.bundle_path,
            "payload/skills/claude-code/SKILL.md"
        );
        assert_eq!(
            manifest.source_artifact_sha256,
            fixture.verified.artifact_sha256
        );
    }

    #[test]
    fn zero_adapter_package_exports_an_empty_receipt_without_fabricating_a_host_bundle() {
        let fixture = ExportFixture::zero_adapter();
        let export =
            export_verified_host_skills(&fixture.verified, &fixture.projection).expect("export");
        assert!(export.bundles.is_empty());

        let output = fixture.root.path().join("zero-adapter-host-exports");
        let receipt = export
            .write_to_new_directory(&output)
            .expect("write empty Host export set");
        assert_eq!(receipt.agent_id, "zero-adapter-agent");
        assert!(receipt.bundles.is_empty());
        assert_eq!(
            fs::read_dir(&output)
                .expect("empty Host export directory")
                .count(),
            0
        );
    }

    #[test]
    fn projection_tamper_unknown_fields_wrong_host_and_cross_artifact_fail_closed() {
        let fixture = ExportFixture::new();
        let original: serde_json::Value =
            serde_json::from_slice(&fixture.projection).expect("projection");

        let mut artifact = original.clone();
        artifact["artifactSha256"] = serde_json::Value::String("0".repeat(64));
        assert!(
            export_verified_host_skills(
                &fixture.verified,
                &serde_json::to_vec(&artifact).expect("artifact tamper"),
            )
            .is_err()
        );

        let mut plan_digest = original.clone();
        plan_digest["planSha256"] = serde_json::Value::String("1".repeat(64));
        assert!(
            export_verified_host_skills(
                &fixture.verified,
                &serde_json::to_vec(&plan_digest).expect("plan digest tamper"),
            )
            .is_err()
        );

        let mut host = original.clone();
        host["plan"]["skillBundles"][0]["host"] = serde_json::Value::String("codex".into());
        assert!(
            export_verified_host_skills(
                &fixture.verified,
                &serde_json::to_vec(&host).expect("host tamper"),
            )
            .is_err()
        );

        let mut unknown = original;
        unknown["unexpectedAuthority"] = serde_json::Value::String("no".into());
        assert!(
            export_verified_host_skills(
                &fixture.verified,
                &serde_json::to_vec(&unknown).expect("unknown field"),
            )
            .is_err()
        );

        let mut missing = serde_json::from_slice::<serde_json::Value>(&fixture.projection)
            .expect("projection for missing field");
        missing
            .as_object_mut()
            .expect("projection object")
            .remove("planSha256");
        assert!(
            export_verified_host_skills(
                &fixture.verified,
                &serde_json::to_vec(&missing).expect("missing field"),
            )
            .is_err()
        );
    }

    #[test]
    fn signed_plan_permissions_version_hosts_and_files_must_match_manifest_and_inventory() {
        let fixture = ExportFixture::new();
        let projection: HostSkillProjection =
            serde_json::from_slice(&fixture.projection).expect("projection");
        let inventory =
            load_signed_inventory(fixture.verified.staging_path()).expect("signed inventory");
        validate_signed_plan(&projection.plan, &fixture.verified.manifest, &inventory)
            .expect("valid signed plan");

        let mut wrong_permissions = projection.plan.clone();
        wrong_permissions
            .requested_permissions
            .push(PackagePermission::NetworkAccess);
        assert!(
            validate_signed_plan(&wrong_permissions, &fixture.verified.manifest, &inventory,)
                .is_err()
        );

        let mut cross_version = projection.plan.clone();
        cross_version.version = "2.0.0".into();
        assert!(
            validate_signed_plan(&cross_version, &fixture.verified.manifest, &inventory).is_err()
        );

        let mut missing_host = projection.plan.clone();
        missing_host.skill_bundles.pop();
        assert!(
            validate_signed_plan(&missing_host, &fixture.verified.manifest, &inventory).is_err()
        );

        let mut wrong_host = projection.plan.clone();
        wrong_host.skill_bundles[0].host = SkillHost::Codex;
        assert!(validate_signed_plan(&wrong_host, &fixture.verified.manifest, &inventory).is_err());

        let mut outside_inventory = projection.plan;
        outside_inventory.skill_bundles[0]
            .files
            .push(PackageFileRecord {
                path: "skills/claude-code/unlisted-secret.md".into(),
                size: 6,
                sha256: "0".repeat(64),
            });
        assert!(
            validate_signed_plan(&outside_inventory, &fixture.verified.manifest, &inventory,)
                .is_err()
        );
    }

    #[test]
    fn staging_tamper_symlink_or_extra_file_is_rejected_before_export() {
        let fixture = ExportFixture::new();
        let entrypoint = fixture
            .verified
            .staging_path()
            .join("skills/claude-code/SKILL.md");
        fs::write(&entrypoint, b"tampered").expect("tamper entrypoint");
        assert!(
            export_verified_host_skills(&fixture.verified, &fixture.projection)
                .expect_err("tampered staging")
                .to_string()
                .contains("reverify")
        );

        let fixture = ExportFixture::new();
        fs::write(
            fixture.verified.staging_path().join("unlisted-extra.txt"),
            b"extra",
        )
        .expect("extra file");
        assert!(export_verified_host_skills(&fixture.verified, &fixture.projection).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let fixture = ExportFixture::new();
            let entrypoint = fixture
                .verified
                .staging_path()
                .join("skills/openclaw-future-agent/SKILL.md");
            fs::remove_file(&entrypoint).expect("remove entrypoint");
            symlink("/etc/hosts", &entrypoint).expect("symlink entrypoint");
            assert!(export_verified_host_skills(&fixture.verified, &fixture.projection).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_exports_and_never_overwrites_an_existing_directory() {
        use std::os::unix::fs::PermissionsExt as _;

        let fixture = ExportFixture::new();
        let export =
            export_verified_host_skills(&fixture.verified, &fixture.projection).expect("export");
        let output = fixture.root.path().join("host-exports");
        let receipt = export
            .write_to_new_directory(&output)
            .expect("write exports");
        assert_eq!(receipt.bundles.len(), 2);
        assert_eq!(
            fs::metadata(&output)
                .expect("output metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for bundle in &receipt.bundles {
            assert_eq!(
                fs::metadata(&bundle.bundle_path)
                    .expect("bundle metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let second =
            export_verified_host_skills(&fixture.verified, &fixture.projection).expect("export");
        assert!(
            second
                .write_to_new_directory(&output)
                .expect_err("existing output")
                .to_string()
                .contains("create")
        );
    }

    #[test]
    fn partial_output_failure_removes_the_whole_new_export_directory() {
        let root = tempfile::tempdir().expect("export root");
        let output = root.path().join("partial");
        let export = HostSkillExportSet {
            package_id: "com.agentmesh360.future-agent".into(),
            agent_id: "future-agent".into(),
            version: "1.0.0".into(),
            source_artifact_sha256: "0".repeat(64),
            source_projection_sha256: "1".repeat(64),
            source_plan_sha256: "2".repeat(64),
            signature_key_id: TEST_KEY_ID.into(),
            bundles: vec![
                HostSkillBundle {
                    host: SkillHost::ClaudeCode,
                    entrypoint: "skills/claude-code/SKILL.md".into(),
                    file_name: "collision.amskill.tar.zst".into(),
                    archive: b"first".to_vec(),
                    sha256: sha256_hex(b"first"),
                },
                HostSkillBundle {
                    host: SkillHost::Openclaw,
                    entrypoint: "skills/openclaw-future-agent/SKILL.md".into(),
                    file_name: "collision.amskill.tar.zst".into(),
                    archive: b"second".to_vec(),
                    sha256: sha256_hex(b"second"),
                },
            ],
        };
        assert!(
            export
                .write_to_new_directory(&output)
                .expect_err("second create-new file collides")
                .to_string()
                .contains("create")
        );
        assert!(!output.exists());
    }

    #[test]
    #[ignore = "requires explicit first-party source checkout paths"]
    fn real_first_party_sources_export_only_after_h1_verification() {
        let definitions_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("agentmesh360")
            .join("packages");
        let signing_key = SigningKey::from_bytes(&[43_u8; 32]);

        for (agent, source_env, expected_bundles) in [
            ("job-agent", "AGENTMESH360_JOB_SOURCE", 2_usize),
            ("lecturecast-agent", "AGENTMESH360_LECTURECAST_SOURCE", 3),
            ("deploy-agent", "AGENTMESH360_DEPLOY_SOURCE", 0),
        ] {
            let source = PathBuf::from(
                std::env::var(source_env)
                    .unwrap_or_else(|_| panic!("{source_env} must name a real source checkout")),
            );
            let root = tempfile::tempdir().expect("first-party export root");
            let authoring_output = root.path().join("authoring-first");
            let receipt = build_package(&definitions_root.join(agent), &source, TEST_KEY_ID)
                .expect("build real first-party Package")
                .write_to_new_directory(&authoring_output)
                .expect("write real first-party Package");
            let second_receipt = build_package(&definitions_root.join(agent), &source, TEST_KEY_ID)
                .expect("rebuild real first-party Package")
                .write_to_new_directory(&root.path().join("authoring-second"))
                .expect("write rebuilt real first-party Package");
            assert_eq!(receipt.artifact_sha256, second_receipt.artifact_sha256);
            assert_eq!(
                fs::read(&receipt.artifact_path).expect("first real artifact"),
                fs::read(&second_receipt.artifact_path).expect("second real artifact")
            );
            assert_eq!(
                fs::read(&receipt.signing_request_path).expect("first real signing request"),
                fs::read(&second_receipt.signing_request_path)
                    .expect("second real signing request")
            );
            assert_eq!(
                fs::read(&receipt.host_projection_path).expect("first real projection"),
                fs::read(&second_receipt.host_projection_path).expect("second real projection")
            );
            let projection = fs::read(&receipt.host_projection_path).expect("read real projection");
            let mut envelope = PackageSignatureEnvelope {
                schema_version: SIGNATURE_SCHEMA_VERSION,
                key_id: TEST_KEY_ID.into(),
                publisher: "agentmesh360".into(),
                package_id: receipt.package_id.clone(),
                version: receipt.version.clone(),
                artifact_sha256: receipt.artifact_sha256.clone(),
                signature: String::new(),
            };
            envelope.signature = BASE64.encode(
                signing_key
                    .sign(signature_payload(&envelope).as_bytes())
                    .to_bytes(),
            );
            let envelope_document =
                serde_json::to_string(&envelope).expect("real envelope document");
            let verified = PackageArtifactVerifier::with_trust_store(
                root.path().join("verification-state"),
                TrustedPublisherStore::with_key(TrustedPublisherKey {
                    key_id: TEST_KEY_ID.into(),
                    publisher: "agentmesh360".into(),
                    public_key: signing_key.verifying_key().to_bytes(),
                }),
            )
            .verify_to_staging(&receipt.artifact_path, &envelope_document)
            .expect("H1 verifies real first-party Package");
            let export = export_verified_host_skills(&verified, &projection)
                .expect("export real Host Skills");
            assert_eq!(export.bundles.len(), expected_bundles);
            let exported = export
                .write_to_new_directory(&root.path().join("host-exports"))
                .expect("write real Host Skills");
            assert_eq!(exported.bundles.len(), expected_bundles);
            let release_build = assemble_agent_release(
                &verified,
                envelope_document.as_bytes(),
                &projection,
                &exported,
            )
            .expect("assemble real Agent Release");
            let release_base = format!(
                "https://packages.agentmesh360.com/{}/{}",
                receipt.package_id, receipt.version
            );
            let registry_record = bind_verified_release_record(
                &release_build,
                ReleaseChannelLocations {
                    release_manifest_url: format!(
                        "{release_base}/{}-{}.agent-release.v1.json",
                        receipt.package_id, receipt.version
                    ),
                    artifact_url: format!(
                        "{release_base}/{}-{}.ampkg.tar.zst",
                        receipt.package_id, receipt.version
                    ),
                    envelope_url: format!(
                        "{release_base}/{}-{}.signature.v1.json",
                        receipt.package_id, receipt.version
                    ),
                    host_projection_url: format!(
                        "{release_base}/{}-{}.host-skills.v1.json",
                        receipt.package_id, receipt.version
                    ),
                    host_bundles: exported
                        .bundles
                        .iter()
                        .map(|bundle| HostBundleLocation {
                            host: bundle.host,
                            bundle_url: format!(
                                "{release_base}/{}-{}-{}.amskill.tar.zst",
                                receipt.package_id,
                                receipt.version,
                                bundle.host.as_str()
                            ),
                        })
                        .collect(),
                },
            )
            .expect("bind real Agent Release to Registry projections");
            assert_eq!(
                registry_record.client_projection().release_manifest,
                registry_record.host_projection().release_manifest
            );
            assert_eq!(registry_record.host_bundles.len(), expected_bundles);
            let release = release_build
                .write_to_new_directory(&root.path().join("release-output"))
                .expect("write real Agent Release");
            println!(
                "{} artifact={} release={} registryRelease={} bundles={}",
                agent,
                receipt.artifact_sha256,
                release.manifest_sha256,
                registry_record.release_manifest_sha256,
                exported
                    .bundles
                    .iter()
                    .map(|bundle| { format!("{}:{}", bundle.host.as_str(), bundle.bundle_sha256) })
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
    }

    struct ExportFixture {
        root: tempfile::TempDir,
        verified: VerifiedStagedPackage,
        projection: Vec<u8>,
    }

    impl ExportFixture {
        fn new() -> Self {
            Self::from_documents(
                FUTURE_MANIFEST,
                FUTURE_AUTHORING,
                &[
                    ("docs/agent-onboarding.md", "# Canonical workflow\n"),
                    ("skills/claude-code/README.md", "# Claude adapter README\n"),
                    ("skills/claude-code/SKILL.md", "# Claude Code Job Agent\n"),
                    (
                        "skills/openclaw-future-agent/SKILL.md",
                        "# OpenClaw Future Agent\n",
                    ),
                ],
            )
        }

        fn zero_adapter() -> Self {
            Self::from_documents(
                ZERO_ADAPTER_MANIFEST,
                ZERO_ADAPTER_AUTHORING,
                &[("AGENTS.md", "# Zero Adapter canonical workflow\n")],
            )
        }

        fn from_documents(manifest: &str, authoring: &str, source_files: &[(&str, &str)]) -> Self {
            let root = tempfile::tempdir().expect("same-repository source");
            fs::write(root.path().join(PACKAGE_MANIFEST_PATH), manifest).expect("write Manifest");
            fs::write(root.path().join("agentmesh-authoring.toml"), authoring)
                .expect("write authoring");
            for (path, contents) in source_files {
                let destination = root.path().join(path);
                fs::create_dir_all(destination.parent().expect("source parent"))
                    .expect("create source parent");
                fs::write(destination, contents).expect("write source");
            }

            let output = root.path().join("authoring-output");
            let receipt = build_package(root.path(), root.path(), TEST_KEY_ID)
                .expect("same-repository build")
                .write_to_new_directory(&output)
                .expect("write authoring outputs");
            let projection = fs::read(&receipt.host_projection_path).expect("read projection");
            let signing_key = SigningKey::from_bytes(&[41_u8; 32]);
            let mut envelope = PackageSignatureEnvelope {
                schema_version: SIGNATURE_SCHEMA_VERSION,
                key_id: TEST_KEY_ID.into(),
                publisher: "agentmesh360".into(),
                package_id: receipt.package_id,
                version: receipt.version,
                artifact_sha256: receipt.artifact_sha256,
                signature: String::new(),
            };
            envelope.signature = BASE64.encode(
                signing_key
                    .sign(signature_payload(&envelope).as_bytes())
                    .to_bytes(),
            );
            let trust = TrustedPublisherStore::with_key(TrustedPublisherKey {
                key_id: TEST_KEY_ID.into(),
                publisher: "agentmesh360".into(),
                public_key: signing_key.verifying_key().to_bytes(),
            });
            let verified = PackageArtifactVerifier::with_trust_store(
                root.path().join("verification-state"),
                trust,
            )
            .verify_to_staging(
                &receipt.artifact_path,
                &serde_json::to_string(&envelope).expect("envelope"),
            )
            .expect("H1 verifies authored Package");
            Self {
                root,
                verified,
                projection,
            }
        }
    }

    fn archive_files(archive: &[u8]) -> BTreeMap<String, Vec<u8>> {
        let decoder = zstd::stream::read::Decoder::new(Cursor::new(archive)).expect("zstd decoder");
        let mut archive = tar::Archive::new(decoder);
        let mut files = BTreeMap::new();
        for entry in archive.entries().expect("archive entries") {
            let mut entry = entry.expect("archive entry");
            let path = entry
                .path()
                .expect("archive path")
                .to_string_lossy()
                .into_owned();
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents).expect("archive contents");
            files.insert(path, contents);
        }
        files
    }
}
