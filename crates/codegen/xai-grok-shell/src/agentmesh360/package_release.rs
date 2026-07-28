//! Deterministic cross-channel Agent Release manifests.
//!
//! H2d2 binds one H1-verified client Artifact and its exact signature Envelope
//! to the unforgeable in-memory receipt returned by H2d1 Host Skill export.
//! It performs no upload, Registry mutation, or user Host installation.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use semver::Version;
use serde::{Deserialize, Serialize};

use super::agent_packages::{
    MAX_PACKAGE_IDENTIFIER_BYTES, MAX_PACKAGE_PATH_BYTES, SkillHost, validate_identifier,
    validate_relative_package_path,
};
use super::package_artifact::{
    MAX_ARTIFACT_BYTES, PackageSignatureEnvelope, SIGNATURE_SCHEMA_VERSION, VerifiedStagedPackage,
    is_safe_identifier, normalized_package_path, validate_sha256, verify_installed_package_tree,
};
use super::package_authoring::{
    create_new_private_directory, sha256_hex, validate_output_file_name, write_new_private_file,
};
use super::package_skill_export::{HostSkillExportReceipt, read_bounded_regular_file};

const AGENT_RELEASE_SCHEMA_VERSION: u32 = 1;
pub(super) const MAX_RELEASE_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_RELEASE_INPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentReleaseManifest {
    schema_version: u32,
    package_id: String,
    agent_id: String,
    version: String,
    publisher: String,
    client_artifact: ClientArtifactRelease,
    host_skill_plan: HostSkillPlanRelease,
    host_bundles: Vec<HostBundleRelease>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientArtifactRelease {
    file_name: String,
    sha256: String,
    file_manifest_sha256: String,
    signature_envelope_file_name: String,
    signature_envelope_sha256: String,
    signature_key_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSkillPlanRelease {
    projection_file_name: String,
    projection_sha256: String,
    signed_plan_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostBundleRelease {
    host: SkillHost,
    entrypoint: String,
    file_name: String,
    sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct VerifiedAgentReleaseDescriptor {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub publisher: String,
    pub release_file_name: String,
    pub release_sha256: String,
    pub artifact_file_name: String,
    pub artifact_sha256: String,
    pub artifact_file_manifest_sha256: String,
    pub envelope_file_name: String,
    pub envelope_sha256: String,
    pub envelope_signature_key_id: String,
    pub host_projection_file_name: String,
    pub host_projection_sha256: String,
    pub host_bundles: Vec<VerifiedHostBundleDescriptor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct VerifiedHostBundleDescriptor {
    pub host: SkillHost,
    pub entrypoint: String,
    pub file_name: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentReleaseReceipt {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub manifest_path: PathBuf,
    pub manifest_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AgentReleaseBuild {
    package_id: String,
    agent_id: String,
    version: String,
    file_name: String,
    document: Vec<u8>,
    sha256: String,
}

impl AgentReleaseBuild {
    pub(super) fn document(&self) -> &[u8] {
        &self.document
    }

    pub(super) fn verified_descriptor(&self) -> Result<VerifiedAgentReleaseDescriptor> {
        let descriptor = verify_agent_release_descriptor(&self.document)?;
        if descriptor.package_id != self.package_id
            || descriptor.agent_id != self.agent_id
            || descriptor.version != self.version
            || descriptor.release_file_name != self.file_name
            || descriptor.release_sha256 != self.sha256
        {
            bail!("Agent Release build metadata differs from its verified document");
        }
        Ok(descriptor)
    }

    pub(crate) fn write_to_new_directory(self, output_dir: &Path) -> Result<AgentReleaseReceipt> {
        create_new_private_directory(output_dir)?;
        let result = (|| {
            let manifest_path = output_dir.join(&self.file_name);
            write_new_private_file(&manifest_path, &self.document)?;
            Ok(AgentReleaseReceipt {
                package_id: self.package_id,
                agent_id: self.agent_id,
                version: self.version,
                manifest_path,
                manifest_sha256: self.sha256,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(output_dir);
        }
        result
    }

    #[cfg(test)]
    pub(super) fn tamper_document_for_test(&mut self) {
        self.document.push(b' ');
    }

    #[cfg(test)]
    pub(super) fn document_for_test(&self) -> &[u8] {
        self.document()
    }
}

pub(crate) fn assemble_agent_release(
    verified: &VerifiedStagedPackage,
    envelope_document: &[u8],
    projection_document: &[u8],
    host_exports: &HostSkillExportReceipt,
) -> Result<AgentReleaseBuild> {
    if envelope_document.is_empty()
        || envelope_document.len() > MAX_RELEASE_INPUT_BYTES
        || projection_document.is_empty()
        || projection_document.len() > MAX_RELEASE_INPUT_BYTES
    {
        bail!("Agent Release input size is invalid");
    }
    for (field, digest) in [
        ("artifactSha256", verified.artifact_sha256.as_str()),
        ("envelopeSha256", verified.envelope_sha256.as_str()),
        ("fileManifestSha256", verified.file_manifest_sha256.as_str()),
        ("projectionSha256", host_exports.source_projection_sha256()),
        ("planSha256", host_exports.source_plan_sha256()),
    ] {
        validate_sha256(field, digest)?;
    }

    let current_manifest =
        verify_installed_package_tree(verified.staging_path(), &verified.file_manifest_sha256)
            .context("reverify staged Package before Agent Release assembly")?;
    if current_manifest != verified.manifest {
        bail!("staged Package Manifest changed before Agent Release assembly");
    }

    if sha256_hex(envelope_document) != verified.envelope_sha256 {
        bail!("Agent Release signature Envelope differs from the H1-verified bytes");
    }
    let envelope: PackageSignatureEnvelope = serde_json::from_slice(envelope_document)
        .context("parse Agent Release signature Envelope")?;
    if envelope.schema_version != SIGNATURE_SCHEMA_VERSION
        || envelope.package_id != verified.manifest.package_id
        || envelope.version != verified.manifest.version
        || envelope.publisher != verified.manifest.publisher
        || envelope.artifact_sha256 != verified.artifact_sha256
        || envelope.key_id != verified.signature_key_id
    {
        bail!("Agent Release signature Envelope identity differs from H1 verification");
    }

    if sha256_hex(projection_document) != host_exports.source_projection_sha256() {
        bail!("Agent Release Host projection differs from the H2d1 export input");
    }
    if host_exports.package_id() != verified.manifest.package_id
        || host_exports.agent_id() != verified.manifest.agent.agent_id
        || host_exports.version() != verified.manifest.version
        || host_exports.source_artifact_sha256() != verified.artifact_sha256
        || host_exports.signature_key_id() != verified.signature_key_id
    {
        bail!("Agent Release Host export receipt identity differs from H1 verification");
    }

    let adapters = verified
        .manifest
        .skills
        .adapters
        .iter()
        .map(|adapter| (adapter.host, adapter.path.as_str()))
        .collect::<HashMap<_, _>>();
    if adapters.len() != host_exports.bundles().len() {
        bail!("Agent Release Host bundle coverage differs from the Package Manifest");
    }
    let mut seen_hosts = HashSet::new();
    let mut host_bundles = Vec::with_capacity(host_exports.bundles().len());
    for bundle in host_exports.bundles() {
        if !seen_hosts.insert(bundle.host()) {
            bail!("Agent Release contains a duplicate Host bundle");
        }
        let expected_entrypoint = adapters
            .get(&bundle.host())
            .ok_or_else(|| anyhow!("Agent Release contains an unknown Host bundle"))?;
        if bundle.entrypoint() != *expected_entrypoint {
            bail!("Agent Release Host bundle entrypoint differs from its Manifest");
        }
        validate_sha256("bundleSha256", bundle.bundle_sha256())?;
        let expected_file_name = host_bundle_file_name(
            &verified.manifest.package_id,
            &verified.manifest.version,
            bundle.host(),
        )?;
        let actual_file_name = bundle
            .bundle_path()
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow!("Agent Release Host bundle file name is invalid"))?;
        if actual_file_name != expected_file_name {
            bail!("Agent Release Host bundle file name differs from its identity");
        }
        let contents = read_bounded_regular_file(bundle.bundle_path(), MAX_ARTIFACT_BYTES)
            .context("read H2d1 Host bundle for Agent Release")?;
        if contents.is_empty() || sha256_hex(&contents) != bundle.bundle_sha256() {
            bail!("Agent Release Host bundle bytes differ from the H2d1 receipt");
        }
        host_bundles.push(HostBundleRelease {
            host: bundle.host(),
            entrypoint: bundle.entrypoint().to_owned(),
            file_name: expected_file_name,
            sha256: bundle.bundle_sha256().to_owned(),
        });
    }
    host_bundles.sort_by_key(|bundle| bundle.host.as_str());

    let artifact_file_name = format!(
        "{}-{}.ampkg.tar.zst",
        verified.manifest.package_id, verified.manifest.version
    );
    let envelope_file_name = format!(
        "{}-{}.signature.v1.json",
        verified.manifest.package_id, verified.manifest.version
    );
    let projection_file_name = format!(
        "{}-{}.host-skills.v1.json",
        verified.manifest.package_id, verified.manifest.version
    );
    let release_file_name = format!(
        "{}-{}.agent-release.v1.json",
        verified.manifest.package_id, verified.manifest.version
    );
    for file_name in [
        artifact_file_name.as_str(),
        envelope_file_name.as_str(),
        projection_file_name.as_str(),
        release_file_name.as_str(),
    ] {
        validate_output_file_name(file_name)?;
    }

    let manifest = AgentReleaseManifest {
        schema_version: AGENT_RELEASE_SCHEMA_VERSION,
        package_id: verified.manifest.package_id.clone(),
        agent_id: verified.manifest.agent.agent_id.clone(),
        version: verified.manifest.version.clone(),
        publisher: verified.manifest.publisher.clone(),
        client_artifact: ClientArtifactRelease {
            file_name: artifact_file_name,
            sha256: verified.artifact_sha256.clone(),
            file_manifest_sha256: verified.file_manifest_sha256.clone(),
            signature_envelope_file_name: envelope_file_name,
            signature_envelope_sha256: verified.envelope_sha256.clone(),
            signature_key_id: verified.signature_key_id.clone(),
        },
        host_skill_plan: HostSkillPlanRelease {
            projection_file_name,
            projection_sha256: host_exports.source_projection_sha256().to_owned(),
            signed_plan_sha256: host_exports.source_plan_sha256().to_owned(),
        },
        host_bundles,
    };
    let document =
        serde_json::to_vec(&manifest).context("serialize deterministic Agent Release Manifest")?;
    verify_agent_release_document(&document)?;

    Ok(AgentReleaseBuild {
        package_id: manifest.package_id,
        agent_id: manifest.agent_id,
        version: manifest.version,
        file_name: release_file_name,
        sha256: sha256_hex(&document),
        document,
    })
}

fn verify_agent_release_document(document: &[u8]) -> Result<AgentReleaseManifest> {
    if document.is_empty() || document.len() > MAX_RELEASE_MANIFEST_BYTES {
        bail!("Agent Release Manifest size is invalid");
    }
    let manifest: AgentReleaseManifest =
        serde_json::from_slice(document).context("parse Agent Release Manifest")?;
    if manifest.schema_version != AGENT_RELEASE_SCHEMA_VERSION {
        bail!("Agent Release Manifest identity or schema is invalid");
    }
    validate_identifier("release.packageId", &manifest.package_id, true)?;
    validate_identifier("release.agentId", &manifest.agent_id, false)?;
    validate_identifier("release.publisher", &manifest.publisher, true)?;
    if !is_safe_identifier(&manifest.client_artifact.signature_key_id)
        || manifest.client_artifact.signature_key_id.len() > MAX_PACKAGE_IDENTIFIER_BYTES
        || manifest.version.len() > MAX_PACKAGE_IDENTIFIER_BYTES
    {
        bail!("Agent Release Manifest identity or schema is invalid");
    }
    let version =
        Version::parse(&manifest.version).context("parse Agent Release Manifest version")?;
    if version.to_string() != manifest.version {
        bail!("Agent Release Manifest version must use canonical SemVer");
    }
    for (field, digest) in [
        (
            "clientArtifact.sha256",
            manifest.client_artifact.sha256.as_str(),
        ),
        (
            "clientArtifact.fileManifestSha256",
            manifest.client_artifact.file_manifest_sha256.as_str(),
        ),
        (
            "clientArtifact.signatureEnvelopeSha256",
            manifest.client_artifact.signature_envelope_sha256.as_str(),
        ),
        (
            "hostSkillPlan.projectionSha256",
            manifest.host_skill_plan.projection_sha256.as_str(),
        ),
        (
            "hostSkillPlan.signedPlanSha256",
            manifest.host_skill_plan.signed_plan_sha256.as_str(),
        ),
    ] {
        validate_sha256(field, digest)?;
    }
    if manifest.client_artifact.file_name
        != format!("{}-{}.ampkg.tar.zst", manifest.package_id, manifest.version)
        || manifest.client_artifact.signature_envelope_file_name
            != format!(
                "{}-{}.signature.v1.json",
                manifest.package_id, manifest.version
            )
        || manifest.host_skill_plan.projection_file_name
            != format!(
                "{}-{}.host-skills.v1.json",
                manifest.package_id, manifest.version
            )
    {
        bail!("Agent Release Manifest file names differ from its identity");
    }

    let mut previous_host = None;
    let mut hosts = HashSet::new();
    for bundle in &manifest.host_bundles {
        validate_sha256("hostBundles.sha256", &bundle.sha256)?;
        validate_relative_package_path("release.hostBundles.entrypoint", &bundle.entrypoint)?;
        normalized_package_path(Path::new(&bundle.entrypoint))?;
        if !hosts.insert(bundle.host) {
            bail!("Agent Release Manifest contains a duplicate Host bundle");
        }
        if previous_host.is_some_and(|previous| previous >= bundle.host.as_str()) {
            bail!("Agent Release Manifest Host bundles must be uniquely sorted");
        }
        previous_host = Some(bundle.host.as_str());
        let expected_file =
            host_bundle_file_name(&manifest.package_id, &manifest.version, bundle.host)?;
        if bundle.file_name != expected_file {
            bail!("Agent Release Manifest Host bundle file name differs from its identity");
        }
    }
    let canonical =
        serde_json::to_vec(&manifest).context("serialize canonical Agent Release Manifest")?;
    if canonical != document {
        bail!("Agent Release Manifest must use canonical deterministic JSON");
    }
    Ok(manifest)
}

pub(super) fn verify_agent_release_descriptor(
    document: &[u8],
) -> Result<VerifiedAgentReleaseDescriptor> {
    let manifest = verify_agent_release_document(document)?;
    Ok(VerifiedAgentReleaseDescriptor {
        release_file_name: format!(
            "{}-{}.agent-release.v1.json",
            manifest.package_id, manifest.version
        ),
        release_sha256: sha256_hex(document),
        package_id: manifest.package_id,
        agent_id: manifest.agent_id,
        version: manifest.version,
        publisher: manifest.publisher,
        artifact_file_name: manifest.client_artifact.file_name,
        artifact_sha256: manifest.client_artifact.sha256,
        artifact_file_manifest_sha256: manifest.client_artifact.file_manifest_sha256,
        envelope_file_name: manifest.client_artifact.signature_envelope_file_name,
        envelope_sha256: manifest.client_artifact.signature_envelope_sha256,
        envelope_signature_key_id: manifest.client_artifact.signature_key_id,
        host_projection_file_name: manifest.host_skill_plan.projection_file_name,
        host_projection_sha256: manifest.host_skill_plan.projection_sha256,
        host_bundles: manifest
            .host_bundles
            .into_iter()
            .map(|bundle| VerifiedHostBundleDescriptor {
                host: bundle.host,
                entrypoint: bundle.entrypoint,
                file_name: bundle.file_name,
                sha256: bundle.sha256,
            })
            .collect(),
    })
}

#[cfg(test)]
pub(super) fn release_document_for_download_test(
    package_id: &str,
    agent_id: &str,
    version: &str,
    artifact_sha256: &str,
    envelope_sha256: &str,
    file_manifest_sha256: &str,
    signature_key_id: &str,
) -> Vec<u8> {
    let manifest = AgentReleaseManifest {
        schema_version: AGENT_RELEASE_SCHEMA_VERSION,
        package_id: package_id.into(),
        agent_id: agent_id.into(),
        version: version.into(),
        publisher: "agentmesh360".into(),
        client_artifact: ClientArtifactRelease {
            file_name: format!("{package_id}-{version}.ampkg.tar.zst"),
            sha256: artifact_sha256.into(),
            file_manifest_sha256: file_manifest_sha256.into(),
            signature_envelope_file_name: format!("{package_id}-{version}.signature.v1.json"),
            signature_envelope_sha256: envelope_sha256.into(),
            signature_key_id: signature_key_id.into(),
        },
        host_skill_plan: HostSkillPlanRelease {
            projection_file_name: format!("{package_id}-{version}.host-skills.v1.json"),
            projection_sha256: "d".repeat(64),
            signed_plan_sha256: "f".repeat(64),
        },
        host_bundles: Vec::new(),
    };
    let document = serde_json::to_vec(&manifest).expect("serialize download Release fixture");
    verify_agent_release_document(&document).expect("verify download Release fixture");
    document
}

fn host_bundle_file_name(package_id: &str, version: &str, host: SkillHost) -> Result<String> {
    let file_name = format!("{package_id}-{version}-{}.amskill.tar.zst", host.as_str());
    validate_output_file_name(&file_name)?;
    Ok(file_name)
}

#[cfg(test)]
pub(super) fn release_build_for_registry_test(
    package_id: &str,
    agent_id: &str,
    version: &str,
    hosts: &[(SkillHost, &str)],
) -> AgentReleaseBuild {
    let mut host_bundles = hosts
        .iter()
        .enumerate()
        .map(|(index, (host, entrypoint))| HostBundleRelease {
            host: *host,
            entrypoint: (*entrypoint).into(),
            file_name: host_bundle_file_name(package_id, version, *host)
                .expect("test Host bundle file name"),
            sha256: ((b'a' + index as u8) as char).to_string().repeat(64),
        })
        .collect::<Vec<_>>();
    host_bundles.sort_by_key(|bundle| bundle.host.as_str());
    let manifest = AgentReleaseManifest {
        schema_version: AGENT_RELEASE_SCHEMA_VERSION,
        package_id: package_id.into(),
        agent_id: agent_id.into(),
        version: version.into(),
        publisher: "agentmesh360".into(),
        client_artifact: ClientArtifactRelease {
            file_name: format!("{package_id}-{version}.ampkg.tar.zst"),
            sha256: "1".repeat(64),
            file_manifest_sha256: "2".repeat(64),
            signature_envelope_file_name: format!("{package_id}-{version}.signature.v1.json"),
            signature_envelope_sha256: "3".repeat(64),
            signature_key_id: "agentmesh360-release-test".into(),
        },
        host_skill_plan: HostSkillPlanRelease {
            projection_file_name: format!("{package_id}-{version}.host-skills.v1.json"),
            projection_sha256: "4".repeat(64),
            signed_plan_sha256: "5".repeat(64),
        },
        host_bundles,
    };
    let document = serde_json::to_vec(&manifest).expect("serialize registry Release fixture");
    verify_agent_release_document(&document).expect("verify registry Release fixture");
    AgentReleaseBuild {
        package_id: package_id.into(),
        agent_id: agent_id.into(),
        version: version.into(),
        file_name: format!("{package_id}-{version}.agent-release.v1.json"),
        sha256: sha256_hex(&document),
        document,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::super::package_artifact::{
        PACKAGE_MANIFEST_PATH, PackageArtifactVerifier, signature_payload,
    };
    use super::super::package_authoring::build_package;
    use super::super::package_skill_export::export_verified_host_skills;
    use super::super::package_trust::{TrustedPublisherKey, TrustedPublisherStore};
    use super::*;

    const TEST_KEY_ID: &str = "agentmesh360-release-test";
    const MANIFEST: &str = r#"
schemaVersion = 1
packageId = "com.agentmesh360.release-agent"
version = "1.2.3"
publisher = "agentmesh360"
sourceRepository = "https://github.com/agentmesh360/release-agent"
requestedPermissions = ["local_files"]

[agent]
agentId = "release-agent"
displayName = "Release Agent"
description = "Cross-channel release assembly fixture."
sortOrder = 92

[persistence]
mainSessionStrategy = "account_agent_stable_v5"
workspaceStrategy = "account_agent_directory"

[runtime]
promptMode = "extend"
discoverSkills = true
inheritSkills = true
agentsMd = true
promptBody = "You are the persistent Release Agent."

[modelPolicy]
tools = "preferred"
streaming = "preferred"

[skills]
canonicalWorkflow = "docs/agent-onboarding.md"

[[skills.adapters]]
host = "codex"
path = "skills/codex/SKILL.md"

[[skills.adapters]]
host = "openclaw"
path = "skills/openclaw/SKILL.md"
"#;
    const AUTHORING: &str = r#"
schemaVersion = 1
packageFiles = []

[[skillBundles]]
host = "codex"
files = ["skills/codex/SKILL.md"]

[[skillBundles]]
host = "openclaw"
files = ["skills/openclaw/SKILL.md"]
"#;

    #[test]
    fn assembles_a_deterministic_strict_cross_channel_release_manifest() {
        let fixture = release_fixture();
        let first = fixture.assemble().expect("first release assembly");
        let second = fixture.assemble().expect("second release assembly");
        assert_eq!(first.document, second.document);
        assert_eq!(first.sha256, second.sha256);

        let manifest = verify_agent_release_document(&first.document).expect("release document");
        assert_eq!(manifest.agent_id, "release-agent");
        assert_eq!(
            manifest
                .host_bundles
                .iter()
                .map(|bundle| bundle.host)
                .collect::<Vec<_>>(),
            vec![SkillHost::Codex, SkillHost::Openclaw]
        );
        assert_eq!(
            manifest.client_artifact.signature_envelope_sha256,
            fixture.verified.envelope_sha256
        );

        let output = fixture.root.path().join("release-output");
        let receipt = first
            .write_to_new_directory(&output)
            .expect("write release manifest");
        assert_eq!(receipt.agent_id, "release-agent");
        assert_eq!(
            fs::read(&receipt.manifest_path).expect("written release manifest"),
            second.document
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;

            assert_eq!(
                fs::metadata(&output)
                    .expect("release output metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&receipt.manifest_path)
                    .expect("release manifest metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert!(
            fixture
                .assemble()
                .expect("third release assembly")
                .write_to_new_directory(&output)
                .is_err()
        );
    }

    #[test]
    fn assembly_rejects_envelope_projection_bundle_and_staging_tamper() {
        let fixture = release_fixture();
        let mut envelope = fixture.envelope.clone();
        envelope.push(b' ');
        assert!(
            assemble_agent_release(
                &fixture.verified,
                &envelope,
                &fixture.projection,
                &fixture.exports,
            )
            .is_err()
        );

        let mut projection = fixture.projection.clone();
        projection.push(b' ');
        assert!(
            assemble_agent_release(
                &fixture.verified,
                &fixture.envelope,
                &projection,
                &fixture.exports,
            )
            .is_err()
        );

        let bundle = fixture
            .exports
            .bundles()
            .first()
            .expect("first Host bundle");
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(bundle.bundle_path())
            .expect("open Host bundle for tamper");
        file.write_all(b"tamper").expect("tamper Host bundle");
        assert!(fixture.assemble().is_err());

        let fixture = release_fixture();
        fs::write(fixture.verified.staging_path().join("extra"), b"extra")
            .expect("write staged extra file");
        assert!(fixture.assemble().is_err());
    }

    #[test]
    fn missing_duplicate_and_cross_version_receipts_fail_closed() {
        let fixture = release_fixture();

        let mut missing = fixture.exports.clone();
        missing.remove_last_bundle_for_test();
        assert!(
            assemble_agent_release(
                &fixture.verified,
                &fixture.envelope,
                &fixture.projection,
                &missing,
            )
            .is_err()
        );

        let mut duplicate = fixture.exports.clone();
        duplicate.duplicate_first_bundle_for_test();
        assert!(
            assemble_agent_release(
                &fixture.verified,
                &fixture.envelope,
                &fixture.projection,
                &duplicate,
            )
            .is_err()
        );

        let mut cross_version = fixture.exports.clone();
        cross_version.replace_version_for_test("2.0.0");
        assert!(
            assemble_agent_release(
                &fixture.verified,
                &fixture.envelope,
                &fixture.projection,
                &cross_version,
            )
            .is_err()
        );

        let mut unknown_host = fixture.exports.clone();
        unknown_host.replace_first_bundle_host_for_test(SkillHost::ClaudeCode);
        assert!(
            assemble_agent_release(
                &fixture.verified,
                &fixture.envelope,
                &fixture.projection,
                &unknown_host,
            )
            .is_err()
        );
    }

    #[test]
    fn strict_release_document_rejects_unknown_schema_fields_order_and_version_drift() {
        let fixture = release_fixture();
        let release = fixture.assemble().expect("release");
        let original: serde_json::Value =
            serde_json::from_slice(&release.document).expect("release JSON");

        let mut schema = original.clone();
        schema["schemaVersion"] = serde_json::Value::from(2);
        assert!(
            verify_agent_release_document(
                &serde_json::to_vec(&schema).expect("future schema document")
            )
            .is_err()
        );

        let mut unknown = original.clone();
        unknown["authority"] = serde_json::Value::String("forged".into());
        assert!(
            verify_agent_release_document(
                &serde_json::to_vec(&unknown).expect("unknown field document")
            )
            .is_err()
        );

        let mut version = original.clone();
        version["version"] = serde_json::Value::String("2.0.0".into());
        assert!(
            verify_agent_release_document(
                &serde_json::to_vec(&version).expect("cross-version document")
            )
            .is_err()
        );

        let mut reversed = original;
        reversed["hostBundles"]
            .as_array_mut()
            .expect("Host bundle array")
            .reverse();
        assert!(
            verify_agent_release_document(
                &serde_json::to_vec(&reversed).expect("reordered Host bundle document")
            )
            .is_err()
        );

        let mut invalid_identity: AgentReleaseManifest =
            serde_json::from_slice(&release.document).expect("typed release manifest");
        invalid_identity.agent_id = "release_agent".into();
        assert!(
            verify_agent_release_document(
                &serde_json::to_vec(&invalid_identity).expect("invalid identity document")
            )
            .is_err()
        );
    }

    #[test]
    fn zero_adapter_release_is_valid_and_contains_no_host_bundles() {
        let manifest = MANIFEST
            .replace(
                "com.agentmesh360.release-agent",
                "com.agentmesh360.client-only-agent",
            )
            .replace("release-agent", "client-only-agent")
            .replace(
                "\n[[skills.adapters]]\nhost = \"codex\"\npath = \"skills/codex/SKILL.md\"\n\n[[skills.adapters]]\nhost = \"openclaw\"\npath = \"skills/openclaw/SKILL.md\"\n",
                "\n",
            );
        let fixture = ReleaseFixture::new(
            &manifest,
            "schemaVersion = 1\npackageFiles = []\nskillBundles = []\n",
            &[("docs/agent-onboarding.md", "# Client-only workflow\n")],
        );
        let release = fixture.assemble().expect("zero-adapter release");
        let manifest = verify_agent_release_document(&release.document).expect("release document");
        assert!(manifest.host_bundles.is_empty());
    }

    fn release_fixture() -> ReleaseFixture {
        ReleaseFixture::new(
            MANIFEST,
            AUTHORING,
            &[
                ("docs/agent-onboarding.md", "# Release workflow\n"),
                ("skills/codex/SKILL.md", "# Codex Release Agent\n"),
                ("skills/openclaw/SKILL.md", "# OpenClaw Release Agent\n"),
            ],
        )
    }

    struct ReleaseFixture {
        root: tempfile::TempDir,
        verified: VerifiedStagedPackage,
        envelope: Vec<u8>,
        projection: Vec<u8>,
        exports: HostSkillExportReceipt,
    }

    impl ReleaseFixture {
        fn new(manifest: &str, authoring: &str, files: &[(&str, &str)]) -> Self {
            let root = tempfile::tempdir().expect("release fixture root");
            fs::write(root.path().join(PACKAGE_MANIFEST_PATH), manifest).expect("write Manifest");
            fs::write(root.path().join("agentmesh-authoring.toml"), authoring)
                .expect("write Authoring");
            for (path, contents) in files {
                let destination = root.path().join(path);
                fs::create_dir_all(destination.parent().expect("source parent"))
                    .expect("create source parent");
                fs::write(destination, contents).expect("write source");
            }
            let authoring_output = root.path().join("authoring-output");
            let receipt = build_package(root.path(), root.path(), TEST_KEY_ID)
                .expect("build Package")
                .write_to_new_directory(&authoring_output)
                .expect("write Package");
            let projection = fs::read(&receipt.host_projection_path).expect("read Host projection");
            let signing_key = SigningKey::from_bytes(&[47_u8; 32]);
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
            let envelope =
                serde_json::to_vec(&envelope).expect("serialize exact signature Envelope");
            let envelope_text =
                std::str::from_utf8(&envelope).expect("signature Envelope must be UTF-8");
            let verified = PackageArtifactVerifier::with_trust_store(
                root.path().join("verification-state"),
                TrustedPublisherStore::with_key(TrustedPublisherKey {
                    key_id: TEST_KEY_ID.into(),
                    publisher: "agentmesh360".into(),
                    public_key: signing_key.verifying_key().to_bytes(),
                }),
            )
            .verify_to_staging(&receipt.artifact_path, envelope_text)
            .expect("H1 verifies Package");
            let export_set =
                export_verified_host_skills(&verified, &projection).expect("H2d1 exports");
            let exports = export_set
                .write_to_new_directory(&root.path().join("host-exports"))
                .expect("write H2d1 exports");
            Self {
                root,
                verified,
                envelope,
                projection,
                exports,
            }
        }

        fn assemble(&self) -> Result<AgentReleaseBuild> {
            assemble_agent_release(
                &self.verified,
                &self.envelope,
                &self.projection,
                &self.exports,
            )
        }
    }
}
