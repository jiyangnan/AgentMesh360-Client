use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};
use url::Url;

use super::access::ClientAccess;
use super::agent_packages::{SkillHost, validate_relative_package_path};
use super::package_release::{
    AgentReleaseBuild, VerifiedAgentReleaseDescriptor, verify_agent_release_descriptor,
};
use super::package_trust::{PublisherTrustAudit, TrustedPublisherStore, TrustedRootStore};

const REGISTRY_SNAPSHOT_SCHEMA_VERSION: u32 = 2;
const MAX_REGISTRY_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_REGISTRY_PACKAGES: usize = 256;
const MAX_REMOTE_URL_BYTES: usize = 4096;

#[derive(Clone, Debug)]
pub(crate) struct PackageRegistrySnapshotVerifier {
    roots: TrustedRootStore,
}

impl PackageRegistrySnapshotVerifier {
    pub(crate) fn embedded() -> Self {
        Self {
            roots: TrustedRootStore::embedded(),
        }
    }

    pub(crate) fn verify_document(
        &self,
        document: &str,
        access: &ClientAccess,
        minimum_revision: u64,
        trusted_publishers: &TrustedPublisherStore,
    ) -> Result<VerifiedPackageRegistrySnapshot> {
        let now = access
            .trusted_server_now()
            .context("Agent Package registry requires fresh Core server time")?;
        self.verify_document_at(document, now, minimum_revision, trusted_publishers)
    }

    fn verify_document_at(
        &self,
        document: &str,
        now: DateTime<Utc>,
        minimum_revision: u64,
        trusted_publishers: &TrustedPublisherStore,
    ) -> Result<VerifiedPackageRegistrySnapshot> {
        if document.is_empty() || document.len() > MAX_REGISTRY_SNAPSHOT_BYTES {
            bail!("Agent Package registry snapshot size is invalid");
        }
        let snapshot: PackageRegistrySnapshot =
            serde_json::from_str(document).context("parse Agent Package registry snapshot")?;
        let publisher_trust = trusted_publishers.audit();
        let (generated_at, expires_at) = validate_snapshot(
            &snapshot,
            now,
            minimum_revision,
            &publisher_trust,
            trusted_publishers,
        )?;
        self.roots.verify_signed_payload(
            &snapshot.root_key_id,
            &snapshot.signature,
            registry_signature_payload(&snapshot).as_bytes(),
            "Agent Package registry snapshot",
        )?;

        Ok(VerifiedPackageRegistrySnapshot {
            revision: snapshot.revision,
            trust_bundle_sequence: snapshot.trust_bundle_sequence,
            root_key_id: snapshot.root_key_id,
            generated_at,
            expires_at,
            packages: snapshot.packages,
        })
    }

    pub(super) fn with_roots(roots: TrustedRootStore) -> Self {
        Self { roots }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedPackageRegistrySnapshot {
    pub revision: u64,
    pub trust_bundle_sequence: u64,
    pub root_key_id: String,
    pub generated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub packages: Vec<RemotePackageRecord>,
}

impl VerifiedPackageRegistrySnapshot {
    pub(crate) fn audit(&self) -> PackageRegistrySnapshotAudit {
        PackageRegistrySnapshotAudit {
            revision: self.revision,
            trust_bundle_sequence: self.trust_bundle_sequence,
            root_key_id: self.root_key_id.clone(),
            package_count: self.packages.len(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PackageRegistrySnapshotAudit {
    pub revision: u64,
    pub trust_bundle_sequence: u64,
    pub root_key_id: String,
    pub package_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageRegistrySnapshot {
    schema_version: u32,
    revision: u64,
    root_key_id: String,
    trust_bundle_sequence: u64,
    generated_at: String,
    expires_at: String,
    packages: Vec<RemotePackageRecord>,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemotePackageRecord {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub publisher: String,
    pub release_manifest_url: String,
    pub release_manifest_sha256: String,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub envelope_url: String,
    pub envelope_sha256: String,
    pub host_projection_url: String,
    pub host_projection_sha256: String,
    pub host_bundles: Vec<RemoteHostBundleRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHostBundleRecord {
    pub host: SkillHost,
    pub entrypoint: String,
    pub bundle_url: String,
    pub bundle_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReleaseChannelLocations {
    pub release_manifest_url: String,
    pub artifact_url: String,
    pub envelope_url: String,
    pub host_projection_url: String,
    pub host_bundles: Vec<HostBundleLocation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostBundleLocation {
    pub host: SkillHost,
    pub bundle_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteReleaseReference {
    pub url: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteClientReleaseProjection {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub publisher: String,
    pub release_manifest: RemoteReleaseReference,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub envelope_url: String,
    pub envelope_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHostReleaseProjection {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub publisher: String,
    pub release_manifest: RemoteReleaseReference,
    pub host_projection_url: String,
    pub host_projection_sha256: String,
    pub bundles: Vec<RemoteHostBundleRecord>,
}

impl RemotePackageRecord {
    pub(crate) fn client_projection(&self) -> RemoteClientReleaseProjection {
        RemoteClientReleaseProjection {
            package_id: self.package_id.clone(),
            agent_id: self.agent_id.clone(),
            version: self.version.clone(),
            publisher: self.publisher.clone(),
            release_manifest: self.release_reference(),
            artifact_url: self.artifact_url.clone(),
            artifact_sha256: self.artifact_sha256.clone(),
            envelope_url: self.envelope_url.clone(),
            envelope_sha256: self.envelope_sha256.clone(),
        }
    }

    pub(crate) fn host_projection(&self) -> RemoteHostReleaseProjection {
        RemoteHostReleaseProjection {
            package_id: self.package_id.clone(),
            agent_id: self.agent_id.clone(),
            version: self.version.clone(),
            publisher: self.publisher.clone(),
            release_manifest: self.release_reference(),
            host_projection_url: self.host_projection_url.clone(),
            host_projection_sha256: self.host_projection_sha256.clone(),
            bundles: self.host_bundles.clone(),
        }
    }

    fn release_reference(&self) -> RemoteReleaseReference {
        RemoteReleaseReference {
            url: self.release_manifest_url.clone(),
            sha256: self.release_manifest_sha256.clone(),
        }
    }
}

impl RemoteClientReleaseProjection {
    pub(crate) fn verify_release_document(
        &self,
        document: &[u8],
    ) -> Result<VerifiedAgentReleaseDescriptor> {
        let release = verify_projection_release_reference(
            document,
            &self.release_manifest,
            &self.package_id,
            &self.agent_id,
            &self.version,
            &self.publisher,
        )?;
        if self.artifact_sha256 != release.artifact_sha256
            || self.envelope_sha256 != release.envelope_sha256
        {
            bail!("Agent Release Client projection digest differs from the Release Manifest");
        }
        validate_release_location(
            "artifactUrl",
            &self.artifact_url,
            &release.artifact_file_name,
        )?;
        validate_release_location(
            "envelopeUrl",
            &self.envelope_url,
            &release.envelope_file_name,
        )?;
        Ok(release)
    }
}

impl RemoteHostReleaseProjection {
    pub(crate) fn verify_release_document(&self, document: &[u8]) -> Result<()> {
        let release = verify_projection_release_reference(
            document,
            &self.release_manifest,
            &self.package_id,
            &self.agent_id,
            &self.version,
            &self.publisher,
        )?;
        if self.host_projection_sha256 != release.host_projection_sha256 {
            bail!("Agent Release Host projection digest differs from the Release Manifest");
        }
        validate_release_location(
            "hostProjectionUrl",
            &self.host_projection_url,
            &release.host_projection_file_name,
        )?;
        if self.bundles.len() != release.host_bundles.len() {
            bail!(
                "Agent Release Host projection bundle coverage differs from the Release Manifest"
            );
        }
        for (bundle, expected) in self.bundles.iter().zip(&release.host_bundles) {
            if bundle.host != expected.host
                || bundle.entrypoint != expected.entrypoint
                || bundle.bundle_sha256 != expected.sha256
            {
                bail!("Agent Release Host bundle differs from the Release Manifest");
            }
            validate_release_location(
                "hostBundles.bundleUrl",
                &bundle.bundle_url,
                &expected.file_name,
            )?;
        }
        Ok(())
    }
}

fn verify_projection_release_reference(
    document: &[u8],
    reference: &RemoteReleaseReference,
    package_id: &str,
    agent_id: &str,
    version: &str,
    publisher: &str,
) -> Result<VerifiedAgentReleaseDescriptor> {
    let release =
        verify_agent_release_descriptor(document).context("verify Agent Release Manifest")?;
    if release.release_sha256 != reference.sha256 {
        bail!("Agent Release Manifest digest differs from the verified Registry");
    }
    validate_release_location(
        "releaseManifestUrl",
        &reference.url,
        &release.release_file_name,
    )?;
    if release.package_id != package_id
        || release.agent_id != agent_id
        || release.version != version
        || release.publisher != publisher
    {
        bail!("Agent Release projection identity differs from the Release Manifest");
    }
    Ok(release)
}

pub(crate) fn bind_verified_release_record(
    release_build: &AgentReleaseBuild,
    locations: ReleaseChannelLocations,
) -> Result<RemotePackageRecord> {
    let release = release_build
        .verified_descriptor()
        .context("verify H2d2 Agent Release build before Registry binding")?;
    validate_release_location(
        "releaseManifestUrl",
        &locations.release_manifest_url,
        &release.release_file_name,
    )?;
    validate_release_location(
        "artifactUrl",
        &locations.artifact_url,
        &release.artifact_file_name,
    )?;
    validate_release_location(
        "envelopeUrl",
        &locations.envelope_url,
        &release.envelope_file_name,
    )?;
    validate_release_location(
        "hostProjectionUrl",
        &locations.host_projection_url,
        &release.host_projection_file_name,
    )?;

    let mut bundle_urls = HashMap::new();
    for location in locations.host_bundles {
        if bundle_urls
            .insert(location.host, location.bundle_url)
            .is_some()
        {
            bail!("Agent Release Registry locations contain a duplicate Host");
        }
    }
    if bundle_urls.len() != release.host_bundles.len() {
        bail!("Agent Release Registry locations do not cover every Host bundle");
    }
    let mut host_bundles = Vec::with_capacity(release.host_bundles.len());
    for bundle in release.host_bundles {
        let bundle_url = bundle_urls
            .remove(&bundle.host)
            .ok_or_else(|| anyhow::anyhow!("Agent Release Registry location Host is unknown"))?;
        validate_release_location("hostBundles.bundleUrl", &bundle_url, &bundle.file_name)?;
        host_bundles.push(RemoteHostBundleRecord {
            host: bundle.host,
            entrypoint: bundle.entrypoint,
            bundle_url,
            bundle_sha256: bundle.sha256,
        });
    }
    if !bundle_urls.is_empty() {
        bail!("Agent Release Registry locations contain an unknown Host");
    }
    host_bundles.sort_by_key(|bundle| bundle.host.as_str());

    let record = RemotePackageRecord {
        package_id: release.package_id,
        agent_id: release.agent_id,
        version: release.version,
        publisher: release.publisher,
        release_manifest_url: locations.release_manifest_url,
        release_manifest_sha256: release.release_sha256,
        artifact_url: locations.artifact_url,
        artifact_sha256: release.artifact_sha256,
        envelope_url: locations.envelope_url,
        envelope_sha256: release.envelope_sha256,
        host_projection_url: locations.host_projection_url,
        host_projection_sha256: release.host_projection_sha256,
        host_bundles,
    };
    validate_remote_record_shape(&record)?;
    Ok(record)
}

fn validate_snapshot(
    snapshot: &PackageRegistrySnapshot,
    now: DateTime<Utc>,
    minimum_revision: u64,
    publisher_trust: &PublisherTrustAudit,
    trusted_publishers: &TrustedPublisherStore,
) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    if snapshot.schema_version != REGISTRY_SNAPSHOT_SCHEMA_VERSION {
        bail!(
            "unsupported Agent Package registry snapshot schema version: {}",
            snapshot.schema_version
        );
    }
    if snapshot.revision == 0 || snapshot.revision < minimum_revision {
        bail!("Agent Package registry snapshot revision is stale");
    }
    validate_identifier("rootKeyId", &snapshot.root_key_id, true, true)?;
    if snapshot.trust_bundle_sequence == 0
        || snapshot.trust_bundle_sequence != publisher_trust.trust_sequence
    {
        bail!("Agent Package registry snapshot trust sequence does not match");
    }
    if publisher_trust.root_key_id.as_deref() != Some(snapshot.root_key_id.as_str()) {
        bail!("Agent Package registry snapshot trust root does not match");
    }
    let generated_at = parse_timestamp("generatedAt", &snapshot.generated_at)?;
    let expires_at = parse_timestamp("expiresAt", &snapshot.expires_at)?;
    if generated_at >= expires_at || now < generated_at || now >= expires_at {
        bail!("Agent Package registry snapshot is outside its validity window");
    }
    if snapshot.packages.len() > MAX_REGISTRY_PACKAGES {
        bail!("Agent Package registry snapshot contains too many packages");
    }

    let mut previous_package_id: Option<&str> = None;
    let mut agent_ids = HashSet::new();
    for package in &snapshot.packages {
        validate_remote_record_shape(package)?;
        if !trusted_publishers.trusts_publisher(&package.publisher) {
            bail!("Agent Package registry publisher is not trusted");
        }
        if previous_package_id.is_some_and(|previous| previous >= package.package_id.as_str()) {
            bail!("Agent Package registry records must be uniquely sorted by packageId");
        }
        previous_package_id = Some(&package.package_id);
        if !agent_ids.insert(package.agent_id.as_str()) {
            bail!("Agent Package registry agentId must be unique");
        }
    }
    if snapshot.signature.is_empty() {
        bail!("Agent Package registry snapshot signature must not be empty");
    }
    Ok((generated_at, expires_at))
}

fn validate_remote_record_shape(package: &RemotePackageRecord) -> Result<()> {
    validate_identifier("packageId", &package.package_id, true, false)?;
    validate_identifier("agentId", &package.agent_id, false, false)?;
    validate_identifier("publisher", &package.publisher, true, false)?;
    validate_version(&package.version)?;
    validate_https_url("releaseManifestUrl", &package.release_manifest_url)?;
    validate_sha256("releaseManifestSha256", &package.release_manifest_sha256)?;
    validate_https_url("artifactUrl", &package.artifact_url)?;
    validate_sha256("artifactSha256", &package.artifact_sha256)?;
    validate_https_url("envelopeUrl", &package.envelope_url)?;
    validate_sha256("envelopeSha256", &package.envelope_sha256)?;
    validate_https_url("hostProjectionUrl", &package.host_projection_url)?;
    validate_sha256("hostProjectionSha256", &package.host_projection_sha256)?;
    let mut previous_host = None;
    let mut hosts = HashSet::new();
    for bundle in &package.host_bundles {
        if !hosts.insert(bundle.host) {
            bail!("Agent Package registry Host bundles must be unique");
        }
        if previous_host.is_some_and(|previous| previous >= bundle.host.as_str()) {
            bail!("Agent Package registry Host bundles must be sorted");
        }
        previous_host = Some(bundle.host.as_str());
        validate_relative_package_path("registry.hostBundles.entrypoint", &bundle.entrypoint)?;
        validate_https_url("hostBundles.bundleUrl", &bundle.bundle_url)?;
        validate_sha256("hostBundles.bundleSha256", &bundle.bundle_sha256)?;
    }
    Ok(())
}

fn validate_release_location(field: &str, value: &str, expected_file_name: &str) -> Result<()> {
    validate_https_url(field, value)?;
    let url = Url::parse(value).with_context(|| format!("parse Agent Release {field}"))?;
    let file_name = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Agent Release {field} has no file name"))?;
    if file_name != expected_file_name {
        bail!("Agent Release {field} file name differs from the verified Release Manifest");
    }
    Ok(())
}

fn validate_identifier(
    field: &str,
    value: &str,
    allow_period: bool,
    allow_underscore: bool,
) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || byte == b'-'
                || (allow_period && byte == b'.')
                || (allow_underscore && byte == b'_')
        })
        || value.starts_with(['-', '.', '_'])
        || value.ends_with(['-', '.', '_'])
    {
        bail!("Agent Package registry {field} is invalid");
    }
    Ok(())
}

fn validate_version(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 128 {
        bail!("Agent Package registry version size is invalid");
    }
    let version =
        Version::parse(value).with_context(|| format!("invalid Agent Package version: {value}"))?;
    if version.to_string() != value {
        bail!("Agent Package registry version must use canonical SemVer");
    }
    Ok(())
}

fn validate_https_url(field: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_REMOTE_URL_BYTES {
        bail!("Agent Package registry {field} size is invalid");
    }
    let url = Url::parse(value).with_context(|| format!("parse Agent Package registry {field}"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "Agent Package registry {field} must be an HTTPS URL without credentials, query, or fragment"
        );
    }
    if url.as_str() != value {
        bail!("Agent Package registry {field} must use canonical URL encoding");
    }
    Ok(())
}

fn validate_sha256(field: &str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("Agent Package registry {field} must be a lowercase SHA-256 digest");
    }
    Ok(())
}

fn parse_timestamp(field: &str, value: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("Agent Package registry {field} is invalid"))
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn registry_signature_payload(snapshot: &PackageRegistrySnapshot) -> String {
    let mut payload = format!(
        "agentmesh360-package-registry-v2\nschemaVersion={}\nrevision={}\nrootKeyId={}\ntrustBundleSequence={}\ngeneratedAt={}\nexpiresAt={}\n",
        snapshot.schema_version,
        snapshot.revision,
        snapshot.root_key_id,
        snapshot.trust_bundle_sequence,
        snapshot.generated_at,
        snapshot.expires_at
    );
    for package in &snapshot.packages {
        payload.push_str(&format!(
            "package={}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}\n",
            encode_text(&package.package_id),
            encode_text(&package.agent_id),
            encode_text(&package.version),
            encode_text(&package.publisher),
            encode_text(&package.release_manifest_url),
            package.release_manifest_sha256,
            encode_text(&package.artifact_url),
            package.artifact_sha256,
            encode_text(&package.envelope_url),
            package.envelope_sha256,
            encode_text(&package.host_projection_url),
            package.host_projection_sha256,
            package.host_bundles.len()
        ));
        for bundle in &package.host_bundles {
            payload.push_str(&format!(
                "host={}|{}|{}|{}|{}\n",
                encode_text(&package.package_id),
                bundle.host.as_str(),
                encode_text(&bundle.entrypoint),
                encode_text(&bundle.bundle_url),
                bundle.bundle_sha256
            ));
        }
    }
    payload
}

fn encode_text(value: &str) -> String {
    BASE64.encode(value.as_bytes())
}

#[cfg(test)]
pub(super) fn signed_registry_document_for_test(
    root: &ed25519_dalek::SigningKey,
    root_key_id: &str,
    revision: u64,
    trust_bundle_sequence: u64,
    digest_character: char,
) -> String {
    let artifact_url = "https://packages.agentmesh360.com/job-agent/1.2.0.tar.zst";
    signed_registry_record_document_for_test(
        root,
        root_key_id,
        revision,
        trust_bundle_sequence,
        "job-agent",
        "job-agent",
        "1.2.0",
        artifact_url,
        &digest_character.to_string().repeat(64),
        &format!("{artifact_url}.signature.json"),
        &"a".repeat(64),
    )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn signed_registry_record_document_for_test(
    root: &ed25519_dalek::SigningKey,
    root_key_id: &str,
    revision: u64,
    trust_bundle_sequence: u64,
    package_id: &str,
    agent_id: &str,
    version: &str,
    artifact_url: &str,
    artifact_sha256: &str,
    envelope_url: &str,
    envelope_sha256: &str,
) -> String {
    signed_registry_release_record_document_for_test(
        root,
        root_key_id,
        revision,
        trust_bundle_sequence,
        package_id,
        agent_id,
        version,
        &format!("{artifact_url}.agent-release.v1.json"),
        &"c".repeat(64),
        artifact_url,
        artifact_sha256,
        envelope_url,
        envelope_sha256,
    )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn signed_registry_release_record_document_for_test(
    root: &ed25519_dalek::SigningKey,
    root_key_id: &str,
    revision: u64,
    trust_bundle_sequence: u64,
    package_id: &str,
    agent_id: &str,
    version: &str,
    release_manifest_url: &str,
    release_manifest_sha256: &str,
    artifact_url: &str,
    artifact_sha256: &str,
    envelope_url: &str,
    envelope_sha256: &str,
) -> String {
    use ed25519_dalek::Signer as _;

    let mut snapshot = PackageRegistrySnapshot {
        schema_version: REGISTRY_SNAPSHOT_SCHEMA_VERSION,
        revision,
        root_key_id: root_key_id.into(),
        trust_bundle_sequence,
        generated_at: "2026-07-01T00:00:00Z".into(),
        expires_at: "2026-08-01T00:00:00Z".into(),
        packages: vec![RemotePackageRecord {
            package_id: package_id.into(),
            agent_id: agent_id.into(),
            version: version.into(),
            publisher: "agentmesh360".into(),
            release_manifest_url: release_manifest_url.into(),
            release_manifest_sha256: release_manifest_sha256.into(),
            artifact_url: artifact_url.into(),
            artifact_sha256: artifact_sha256.into(),
            envelope_url: envelope_url.into(),
            envelope_sha256: envelope_sha256.into(),
            host_projection_url: format!("{artifact_url}.host-skills.v1.json"),
            host_projection_sha256: "d".repeat(64),
            host_bundles: Vec::new(),
        }],
        signature: String::new(),
    };
    snapshot.signature = BASE64.encode(
        root.sign(registry_signature_payload(&snapshot).as_bytes())
            .to_bytes(),
    );
    serde_json::to_string(&snapshot).expect("serialize signed registry fixture")
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use chrono::TimeZone as _;
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::Value;

    use super::super::package_release::release_build_for_registry_test;
    use super::super::package_trust::{TrustedPublisherKey, TrustedRootKey};
    use super::*;

    const ROOT_KEY_ID: &str = "agentmesh360-root-test-2026";

    #[test]
    fn one_verified_release_builds_client_and_host_read_only_projections() {
        let package_id = "com.agentmesh360.future-agent";
        let agent_id = "future-agent";
        let version = "1.0.0";
        let release = release_build_for_registry_test(
            package_id,
            agent_id,
            version,
            &[
                (SkillHost::Openclaw, "skills/openclaw/SKILL.md"),
                (SkillHost::Codex, "skills/codex/SKILL.md"),
            ],
        );
        let record = bind_verified_release_record(
            &release,
            release_locations(
                package_id,
                version,
                &[SkillHost::Openclaw, SkillHost::Codex],
            ),
        )
        .expect("bind verified Agent Release");

        assert_eq!(record.package_id, package_id);
        assert_eq!(
            record
                .host_bundles
                .iter()
                .map(|bundle| bundle.host)
                .collect::<Vec<_>>(),
            vec![SkillHost::Codex, SkillHost::Openclaw]
        );
        let client = record.client_projection();
        let host = record.host_projection();
        client
            .verify_release_document(release.document_for_test())
            .expect("cross-check Client projection");
        host.verify_release_document(release.document_for_test())
            .expect("cross-check Host projection");
        assert_eq!(client.release_manifest, host.release_manifest);
        assert_eq!(
            client.release_manifest.sha256,
            release
                .verified_descriptor()
                .expect("verified Release descriptor")
                .release_sha256
        );
        let client_json = serde_json::to_string(&client).expect("client projection");
        assert!(!client_json.contains("hostProjection"));
        assert!(!client_json.contains("bundles"));
        let host_json = serde_json::to_string(&host).expect("Host projection");
        assert!(!host_json.contains("artifactUrl"));
        assert!(!host_json.contains("envelopeUrl"));
        assert_eq!(host.bundles.len(), 2);

        let mut artifact_drift = client.clone();
        artifact_drift.artifact_sha256 = "0".repeat(64);
        assert!(
            artifact_drift
                .verify_release_document(release.document_for_test())
                .is_err()
        );
        let mut envelope_version_drift = client;
        envelope_version_drift.envelope_url = envelope_version_drift
            .envelope_url
            .replace("1.0.0", "2.0.0");
        assert!(
            envelope_version_drift
                .verify_release_document(release.document_for_test())
                .is_err()
        );

        let mut host_drift = host.clone();
        host_drift.bundles[0].entrypoint = "skills/other/SKILL.md".into();
        assert!(
            host_drift
                .verify_release_document(release.document_for_test())
                .is_err()
        );
        let mut host_digest_drift = host.clone();
        host_digest_drift.host_projection_sha256 = "0".repeat(64);
        assert!(
            host_digest_drift
                .verify_release_document(release.document_for_test())
                .is_err()
        );
        let mut host_bundle_drift = host.clone();
        host_bundle_drift.bundles[0].bundle_sha256 = "0".repeat(64);
        assert!(
            host_bundle_drift
                .verify_release_document(release.document_for_test())
                .is_err()
        );
        let mut missing_host = host;
        missing_host.bundles.pop();
        assert!(
            missing_host
                .verify_release_document(release.document_for_test())
                .is_err()
        );
    }

    #[test]
    fn release_binding_rejects_missing_duplicate_cross_version_and_tamper() {
        let package_id = "com.agentmesh360.future-agent";
        let version = "1.0.0";
        let release = release_build_for_registry_test(
            package_id,
            "future-agent",
            version,
            &[
                (SkillHost::Codex, "skills/codex/SKILL.md"),
                (SkillHost::Openclaw, "skills/openclaw/SKILL.md"),
            ],
        );
        let mut missing = release_locations(
            package_id,
            version,
            &[SkillHost::Codex, SkillHost::Openclaw],
        );
        missing.host_bundles.pop();
        assert!(bind_verified_release_record(&release, missing).is_err());

        let mut duplicate = release_locations(
            package_id,
            version,
            &[SkillHost::Codex, SkillHost::Openclaw],
        );
        duplicate.host_bundles[1].host = SkillHost::Codex;
        assert!(bind_verified_release_record(&release, duplicate).is_err());

        let mut unknown = release_locations(
            package_id,
            version,
            &[SkillHost::Codex, SkillHost::Openclaw],
        );
        unknown.host_bundles[1].host = SkillHost::ClaudeCode;
        assert!(
            bind_verified_release_record(&release, unknown)
                .expect_err("unknown Host")
                .to_string()
                .contains("location Host is unknown")
        );

        let mut cross_version = release_locations(
            package_id,
            version,
            &[SkillHost::Codex, SkillHost::Openclaw],
        );
        cross_version.artifact_url = cross_version.artifact_url.replace("1.0.0", "2.0.0");
        assert!(bind_verified_release_record(&release, cross_version).is_err());

        let mut tampered = release.clone();
        tampered.tamper_document_for_test();
        assert!(
            bind_verified_release_record(
                &tampered,
                release_locations(
                    package_id,
                    version,
                    &[SkillHost::Codex, SkillHost::Openclaw],
                ),
            )
            .is_err()
        );
    }

    #[test]
    fn zero_adapter_release_builds_an_empty_host_channel() {
        let package_id = "com.agentmesh360.client-only-agent";
        let version = "1.0.0";
        let release =
            release_build_for_registry_test(package_id, "client-only-agent", version, &[]);
        let record =
            bind_verified_release_record(&release, release_locations(package_id, version, &[]))
                .expect("bind zero-Adapter Release");
        assert!(record.host_bundles.is_empty());
        let host = record.host_projection();
        assert!(host.bundles.is_empty());
        host.verify_release_document(release.document_for_test())
            .expect("cross-check zero-Adapter Host projection");
    }

    #[test]
    fn signed_registry_binds_remote_artifacts_and_trust_sequence() {
        let root = SigningKey::from_bytes(&[31_u8; 32]);
        let verifier = verifier(&root);
        let trust = publisher_trust(7, ROOT_KEY_ID);
        let now = timestamp(2026, 7, 24, 12, 0, 0);
        let mut snapshot = snapshot_fixture();
        sign_snapshot(&mut snapshot, &root);
        let document = serde_json::to_string(&snapshot).expect("registry snapshot");
        let access = ClientAccess::with_trusted_time_for_test(now);

        let verified = verifier
            .verify_document(&document, &access, 42, &trust)
            .expect("verified registry snapshot");

        assert_eq!(
            verified.audit(),
            PackageRegistrySnapshotAudit {
                revision: 42,
                trust_bundle_sequence: 7,
                root_key_id: ROOT_KEY_ID.into(),
                package_count: 2,
            }
        );
        assert_eq!(verified.packages[0].package_id, "deploy-agent");
        assert_eq!(verified.packages[1].agent_id, "job-agent");
        assert_eq!(verified.generated_at, timestamp(2026, 7, 1, 0, 0, 0));
        assert_eq!(verified.expires_at, timestamp(2026, 8, 1, 0, 0, 0));

        access.invalidate();
        assert!(
            verifier
                .verify_document(&document, &access, 42, &trust)
                .expect_err("invalidated access")
                .to_string()
                .contains("fresh Core server time")
        );
        let stale_access = ClientAccess::with_stale_trusted_time_for_test(now);
        assert!(
            verifier
                .verify_document(&document, &stale_access, 42, &trust)
                .expect_err("stale trusted server time")
                .to_string()
                .contains("fresh Core server time")
        );
    }

    #[test]
    fn registry_rejects_tamper_unknown_root_expiry_rollback_and_trust_mismatch() {
        let root = SigningKey::from_bytes(&[31_u8; 32]);
        let verifier = verifier(&root);
        let trust = publisher_trust(7, ROOT_KEY_ID);
        let now = timestamp(2026, 7, 24, 12, 0, 0);

        let mut tampered = snapshot_fixture();
        sign_snapshot(&mut tampered, &root);
        tampered.packages[0].artifact_url =
            "https://packages.agentmesh360.com/deploy-agent/1.0.1.tar.zst".into();
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&tampered).expect("tampered registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("tampered registry")
                .to_string()
                .contains("signature")
        );

        let mut release_tamper = snapshot_fixture();
        sign_snapshot(&mut release_tamper, &root);
        release_tamper.packages[0].release_manifest_sha256 = "0".repeat(64);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&release_tamper).expect("release digest tamper"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("release digest tamper")
                .to_string()
                .contains("signature")
        );

        let mut host_tamper = snapshot_fixture();
        host_tamper.packages[0].host_bundles = vec![remote_host_bundle(SkillHost::Codex, '8')];
        sign_snapshot(&mut host_tamper, &root);
        host_tamper.packages[0].host_bundles[0].bundle_sha256 = "9".repeat(64);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&host_tamper).expect("Host digest tamper"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("Host digest tamper")
                .to_string()
                .contains("signature")
        );

        let mut unknown_root = snapshot_fixture();
        unknown_root.root_key_id = "unknown-root".into();
        sign_snapshot(&mut unknown_root, &root);
        let unknown_trust = publisher_trust(7, "unknown-root");
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&unknown_root).expect("unknown root registry"),
                    now,
                    42,
                    &unknown_trust,
                )
                .expect_err("unknown root")
                .to_string()
                .contains("not trusted")
        );

        let mut valid = snapshot_fixture();
        sign_snapshot(&mut valid, &root);
        let document = serde_json::to_string(&valid).expect("valid registry");
        assert!(
            verifier
                .verify_document_at(&document, timestamp(2026, 8, 1, 0, 0, 0), 42, &trust)
                .expect_err("expired")
                .to_string()
                .contains("validity")
        );
        assert!(
            verifier
                .verify_document_at(&document, now, 43, &trust)
                .expect_err("stale revision")
                .to_string()
                .contains("stale")
        );
        let newer_trust = publisher_trust(8, ROOT_KEY_ID);
        assert!(
            verifier
                .verify_document_at(&document, now, 42, &newer_trust)
                .expect_err("trust mismatch")
                .to_string()
                .contains("trust sequence")
        );
        let different_root_trust = publisher_trust(7, "agentmesh360-root-test-rotated");
        assert!(
            verifier
                .verify_document_at(&document, now, 42, &different_root_trust)
                .expect_err("trust root mismatch")
                .to_string()
                .contains("trust root")
        );
    }

    #[test]
    fn registry_rejects_ambiguous_or_unsafe_package_records() {
        let root = SigningKey::from_bytes(&[31_u8; 32]);
        let verifier = verifier(&root);
        let trust = publisher_trust(7, ROOT_KEY_ID);
        let now = timestamp(2026, 7, 24, 12, 0, 0);

        let mut unsorted = snapshot_fixture();
        unsorted.packages.swap(0, 1);
        sign_snapshot(&mut unsorted, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&unsorted).expect("unsorted registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("unsorted registry")
                .to_string()
                .contains("uniquely sorted")
        );

        let mut unsorted_hosts = snapshot_fixture();
        unsorted_hosts.packages[0].host_bundles = vec![
            remote_host_bundle(SkillHost::Openclaw, '8'),
            remote_host_bundle(SkillHost::Codex, '9'),
        ];
        sign_snapshot(&mut unsorted_hosts, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&unsorted_hosts).expect("unsorted Host registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("unsorted Host bundles")
                .to_string()
                .contains("sorted")
        );

        let mut duplicate_hosts = snapshot_fixture();
        duplicate_hosts.packages[0].host_bundles = vec![
            remote_host_bundle(SkillHost::Codex, '8'),
            remote_host_bundle(SkillHost::Codex, '9'),
        ];
        sign_snapshot(&mut duplicate_hosts, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&duplicate_hosts).expect("duplicate Host registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("duplicate Host bundles")
                .to_string()
                .contains("unique")
        );

        let mut duplicate_agent = snapshot_fixture();
        duplicate_agent.packages[1].agent_id = duplicate_agent.packages[0].agent_id.clone();
        sign_snapshot(&mut duplicate_agent, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&duplicate_agent).expect("duplicate agent registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("duplicate agent")
                .to_string()
                .contains("agentId")
        );

        let mut insecure_url = snapshot_fixture();
        insecure_url.packages[0].artifact_url =
            "http://packages.agentmesh360.com/deploy-agent/1.0.0.tar.zst".into();
        sign_snapshot(&mut insecure_url, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&insecure_url).expect("insecure URL registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("insecure URL")
                .to_string()
                .contains("HTTPS")
        );

        let mut query_url = snapshot_fixture();
        query_url.packages[0].artifact_url =
            "https://packages.agentmesh360.com/deploy-agent/1.0.0.tar.zst?token=secret".into();
        sign_snapshot(&mut query_url, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&query_url).expect("query URL registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("query URL")
                .to_string()
                .contains("query")
        );

        let mut invalid_digest = snapshot_fixture();
        invalid_digest.packages[0].envelope_sha256 = "A1".repeat(32);
        sign_snapshot(&mut invalid_digest, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&invalid_digest).expect("invalid digest registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("invalid digest")
                .to_string()
                .contains("lowercase SHA-256")
        );

        let mut untrusted_publisher = snapshot_fixture();
        untrusted_publisher.packages[0].publisher = "unknown-publisher".into();
        sign_snapshot(&mut untrusted_publisher, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&untrusted_publisher)
                        .expect("untrusted publisher registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("untrusted publisher")
                .to_string()
                .contains("publisher is not trusted")
        );
    }

    #[test]
    fn registry_schema_signature_and_production_root_fail_closed() {
        let root = SigningKey::from_bytes(&[31_u8; 32]);
        let verifier = verifier(&root);
        let trust = publisher_trust(7, ROOT_KEY_ID);
        let now = timestamp(2026, 7, 24, 12, 0, 0);
        let mut snapshot = snapshot_fixture();
        sign_snapshot(&mut snapshot, &root);

        let mut unknown_field = serde_json::to_value(&snapshot).expect("registry snapshot value");
        unknown_field
            .as_object_mut()
            .expect("registry object")
            .insert("unexpected".into(), Value::Bool(true));
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&unknown_field).expect("unknown field registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("unknown field")
                .to_string()
                .contains("parse")
        );

        snapshot.signature = BASE64.encode([0_u8; 63]);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&snapshot).expect("invalid signature registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("invalid signature")
                .to_string()
                .contains("signature")
        );

        let mut signed = snapshot_fixture();
        sign_snapshot(&mut signed, &root);
        assert!(
            PackageRegistrySnapshotVerifier::embedded()
                .verify_document_at(
                    &serde_json::to_string(&signed).expect("production registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("empty production root")
                .to_string()
                .contains("not trusted")
        );

        let mut legacy = snapshot_fixture();
        legacy.schema_version = 1;
        sign_snapshot(&mut legacy, &root);
        assert!(
            verifier
                .verify_document_at(
                    &serde_json::to_string(&legacy).expect("legacy registry"),
                    now,
                    42,
                    &trust,
                )
                .expect_err("legacy Registry v1")
                .to_string()
                .contains("unsupported")
        );
    }

    fn verifier(root: &SigningKey) -> PackageRegistrySnapshotVerifier {
        PackageRegistrySnapshotVerifier::with_roots(TrustedRootStore::with_key(TrustedRootKey {
            key_id: ROOT_KEY_ID.into(),
            public_key: root.verifying_key().to_bytes(),
        }))
    }

    fn publisher_trust(sequence: u64, root_key_id: &str) -> TrustedPublisherStore {
        let publisher = SigningKey::from_bytes(&[41_u8; 32]);
        TrustedPublisherStore::with_key_and_audit(
            TrustedPublisherKey {
                key_id: "agentmesh360-release-test".into(),
                publisher: "agentmesh360".into(),
                public_key: publisher.verifying_key().to_bytes(),
            },
            sequence,
            Some(root_key_id.into()),
        )
    }

    fn snapshot_fixture() -> PackageRegistrySnapshot {
        PackageRegistrySnapshot {
            schema_version: REGISTRY_SNAPSHOT_SCHEMA_VERSION,
            revision: 42,
            root_key_id: ROOT_KEY_ID.into(),
            trust_bundle_sequence: 7,
            generated_at: "2026-07-01T00:00:00Z".into(),
            expires_at: "2026-08-01T00:00:00Z".into(),
            packages: vec![
                package(
                    "deploy-agent",
                    "deploy-agent",
                    "https://packages.agentmesh360.com/deploy-agent/1.0.0.tar.zst",
                    '1',
                ),
                package(
                    "job-agent",
                    "job-agent",
                    "https://packages.agentmesh360.com/job-agent/1.2.0.tar.zst",
                    '2',
                ),
            ],
            signature: String::new(),
        }
    }

    fn package(
        package_id: &str,
        agent_id: &str,
        artifact_url: &str,
        digest_character: char,
    ) -> RemotePackageRecord {
        RemotePackageRecord {
            package_id: package_id.into(),
            agent_id: agent_id.into(),
            version: if package_id == "job-agent" {
                "1.2.0".into()
            } else {
                "1.0.0".into()
            },
            publisher: "agentmesh360".into(),
            release_manifest_url: format!("{artifact_url}.agent-release.v1.json"),
            release_manifest_sha256: if digest_character == '1' {
                "c".repeat(64)
            } else {
                "d".repeat(64)
            },
            artifact_url: artifact_url.into(),
            artifact_sha256: digest_character.to_string().repeat(64),
            envelope_url: format!("{artifact_url}.signature.json"),
            envelope_sha256: if digest_character == '1' {
                "a".repeat(64)
            } else {
                "b".repeat(64)
            },
            host_projection_url: format!("{artifact_url}.host-skills.v1.json"),
            host_projection_sha256: if digest_character == '1' {
                "e".repeat(64)
            } else {
                "f".repeat(64)
            },
            host_bundles: Vec::new(),
        }
    }

    fn release_locations(
        package_id: &str,
        version: &str,
        hosts: &[SkillHost],
    ) -> ReleaseChannelLocations {
        let base = format!("https://packages.agentmesh360.com/{package_id}/{version}");
        ReleaseChannelLocations {
            release_manifest_url: format!("{base}/{package_id}-{version}.agent-release.v1.json"),
            artifact_url: format!("{base}/{package_id}-{version}.ampkg.tar.zst"),
            envelope_url: format!("{base}/{package_id}-{version}.signature.v1.json"),
            host_projection_url: format!("{base}/{package_id}-{version}.host-skills.v1.json"),
            host_bundles: hosts
                .iter()
                .map(|host| HostBundleLocation {
                    host: *host,
                    bundle_url: format!(
                        "{base}/{package_id}-{version}-{}.amskill.tar.zst",
                        host.as_str()
                    ),
                })
                .collect(),
        }
    }

    fn remote_host_bundle(host: SkillHost, digest_character: char) -> RemoteHostBundleRecord {
        RemoteHostBundleRecord {
            host,
            entrypoint: format!("skills/{}/SKILL.md", host.as_str()),
            bundle_url: format!(
                "https://packages.agentmesh360.com/host/{}.amskill.tar.zst",
                host.as_str()
            ),
            bundle_sha256: digest_character.to_string().repeat(64),
        }
    }

    fn sign_snapshot(snapshot: &mut PackageRegistrySnapshot, root: &SigningKey) {
        let signature = root.sign(registry_signature_payload(snapshot).as_bytes());
        snapshot.signature = BASE64.encode(signature.to_bytes());
    }

    fn timestamp(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
            .single()
            .expect("timestamp")
    }
}
