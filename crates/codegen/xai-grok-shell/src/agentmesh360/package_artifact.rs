use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

use super::agent_packages::{AgentPackageCatalog, AgentPackageManifest};
#[cfg(test)]
use super::package_trust::TrustedPublisherKey;
use super::package_trust::TrustedPublisherStore;

pub(super) const SIGNATURE_SCHEMA_VERSION: u32 = 1;
pub(super) const FILE_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub(super) const PACKAGE_MANIFEST_PATH: &str = "agentmesh-agent.toml";
pub(super) const FILE_MANIFEST_PATH: &str = "package-files.v1.json";
pub(super) const HOST_SKILL_PLAN_PATH: &str = "host-skills.v1.json";
pub(super) const MAX_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MAX_UNPACKED_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MAX_FILE_COUNT: usize = 1024;
const MAX_ARCHIVE_ENTRY_COUNT: usize = 2048;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageSignatureEnvelope {
    pub schema_version: u32,
    pub key_id: String,
    pub publisher: String,
    pub package_id: String,
    pub version: String,
    pub artifact_sha256: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageFileManifest {
    pub schema_version: u32,
    pub files: Vec<PackageFileRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackageFileRecord {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

pub(crate) struct PackageArtifactVerifier {
    staging_root: PathBuf,
    trust_store: TrustedPublisherStore,
}

impl PackageArtifactVerifier {
    pub(crate) fn in_home(state_home: impl AsRef<Path>) -> Self {
        Self {
            staging_root: state_home.as_ref().join("packages").join(".staging"),
            trust_store: TrustedPublisherStore::embedded(),
        }
    }

    pub(super) fn with_trust_store(
        state_home: impl AsRef<Path>,
        trust_store: TrustedPublisherStore,
    ) -> Self {
        Self {
            staging_root: state_home.as_ref().join("packages").join(".staging"),
            trust_store,
        }
    }

    pub(crate) fn verify_to_staging(
        &self,
        artifact_path: &Path,
        envelope_document: &str,
    ) -> Result<VerifiedStagedPackage> {
        let envelope_sha256 = lower_hex(&Sha256::digest(envelope_document.as_bytes()));
        let envelope: PackageSignatureEnvelope =
            serde_json::from_str(envelope_document).context("parse Agent Package signature")?;
        validate_envelope(&envelope)?;
        let (artifact, artifact_sha256) = open_and_digest_artifact(artifact_path)?;
        if artifact_sha256 != envelope.artifact_sha256 {
            bail!("Agent Package artifact digest does not match signed envelope");
        }
        self.verify_signature(&envelope)?;

        let package_root = self
            .staging_root
            .parent()
            .ok_or_else(|| anyhow!("Agent Package staging root has no parent"))?;
        create_private_dir(package_root)?;
        create_private_dir(&self.staging_root)?;
        let staging_dir = self.staging_root.join(format!("verify-{}", Uuid::now_v7()));
        create_private_new_dir(&staging_dir)?;
        match extract_and_verify(artifact, &staging_dir, &envelope) {
            Ok((manifest, file_manifest_sha256)) => Ok(VerifiedStagedPackage {
                manifest,
                artifact_sha256,
                envelope_sha256,
                file_manifest_sha256,
                signature_key_id: envelope.key_id,
                staging_dir: Some(staging_dir),
            }),
            Err(error) => {
                let _ = fs::remove_dir_all(&staging_dir);
                Err(error)
            }
        }
    }

    fn verify_signature(&self, envelope: &PackageSignatureEnvelope) -> Result<()> {
        let trusted = self.trust_store.get(&envelope.key_id)?;
        if trusted.publisher != envelope.publisher {
            bail!("Agent Package signature key is not trusted for this publisher");
        }
        let verifying_key = VerifyingKey::from_bytes(&trusted.public_key)
            .context("load trusted Agent Package publisher key")?;
        let signature_bytes = BASE64
            .decode(&envelope.signature)
            .context("decode Agent Package signature")?;
        let signature =
            Signature::from_slice(&signature_bytes).context("parse Agent Package signature")?;
        verifying_key
            .verify_strict(signature_payload(envelope).as_bytes(), &signature)
            .context("verify Agent Package signature")
    }
}

#[derive(Debug)]
pub(crate) struct VerifiedStagedPackage {
    pub manifest: AgentPackageManifest,
    pub artifact_sha256: String,
    pub envelope_sha256: String,
    pub file_manifest_sha256: String,
    pub signature_key_id: String,
    staging_dir: Option<PathBuf>,
}

impl VerifiedStagedPackage {
    pub(super) fn staging_path(&self) -> &Path {
        self.staging_dir.as_deref().expect("staging path")
    }

    pub(super) fn disarm_staging_cleanup(&mut self) {
        self.staging_dir = None;
    }

    #[cfg(test)]
    pub(super) fn for_test(
        manifest: AgentPackageManifest,
        artifact_sha256: impl Into<String>,
        signature_key_id: impl Into<String>,
        staging_dir: PathBuf,
    ) -> Self {
        Self {
            manifest,
            artifact_sha256: artifact_sha256.into(),
            envelope_sha256: "0".repeat(64),
            file_manifest_sha256: digest_file_manifest(&staging_dir)
                .expect("test Package file manifest digest"),
            signature_key_id: signature_key_id.into(),
            staging_dir: Some(staging_dir),
        }
    }
}

impl Drop for VerifiedStagedPackage {
    fn drop(&mut self) {
        if let Some(staging_dir) = self.staging_dir.take() {
            let _ = fs::remove_dir_all(staging_dir);
        }
    }
}

fn validate_envelope(envelope: &PackageSignatureEnvelope) -> Result<()> {
    if envelope.schema_version != SIGNATURE_SCHEMA_VERSION {
        bail!(
            "unsupported Agent Package signature schema version: {}",
            envelope.schema_version
        );
    }
    for (field, value) in [
        ("keyId", envelope.key_id.as_str()),
        ("publisher", envelope.publisher.as_str()),
        ("packageId", envelope.package_id.as_str()),
    ] {
        if !is_safe_identifier(value) {
            bail!("Agent Package signature {field} is invalid");
        }
    }
    Version::parse(&envelope.version)
        .with_context(|| format!("invalid signed Agent Package version: {}", envelope.version))?;
    validate_sha256("artifactSha256", &envelope.artifact_sha256)?;
    if envelope.signature.is_empty() {
        bail!("Agent Package signature must not be empty");
    }
    Ok(())
}

pub(super) fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.' | b'_')
        })
        && !value.starts_with(['-', '.', '_'])
        && !value.ends_with(['-', '.', '_'])
}

pub(super) fn signature_payload(envelope: &PackageSignatureEnvelope) -> String {
    format!(
        "agentmesh360-package-signature-v1\nkeyId={}\npublisher={}\npackageId={}\nversion={}\nartifactSha256={}\n",
        envelope.key_id,
        envelope.publisher,
        envelope.package_id,
        envelope.version,
        envelope.artifact_sha256
    )
}

fn open_and_digest_artifact(path: &Path) -> Result<(File, String)> {
    let mut file = File::open(path)
        .with_context(|| format!("open Agent Package artifact {}", path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("read Agent Package artifact metadata {}", path.display()))?;
    if !metadata.is_file() {
        bail!("Agent Package artifact must be a regular file");
    }
    if metadata.len() == 0 || metadata.len() > MAX_ARTIFACT_BYTES {
        bail!("Agent Package artifact size is outside the allowed range");
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest).context("hash Agent Package artifact")?;
    file.seek(SeekFrom::Start(0))
        .context("rewind verified Agent Package artifact")?;
    Ok((file, lower_hex(&digest.finalize())))
}

#[cfg(test)]
fn digest_artifact(path: &Path) -> Result<String> {
    open_and_digest_artifact(path).map(|(_, digest)| digest)
}

fn extract_and_verify(
    artifact: File,
    staging_dir: &Path,
    envelope: &PackageSignatureEnvelope,
) -> Result<(AgentPackageManifest, String)> {
    let decoder =
        zstd::stream::read::Decoder::new(artifact).context("decode Agent Package zstd artifact")?;
    let mut archive = tar::Archive::new(decoder);
    let mut extracted_files = HashSet::new();
    let mut total_size = 0_u64;
    let mut entry_count = 0_usize;

    for entry in archive.entries().context("read Agent Package archive")? {
        let mut entry = entry.context("read Agent Package archive entry")?;
        entry_count = entry_count
            .checked_add(1)
            .ok_or_else(|| anyhow!("Agent Package archive entry count overflow"))?;
        if entry_count > MAX_ARCHIVE_ENTRY_COUNT {
            bail!("Agent Package archive contains too many entries");
        }
        let entry_type = entry.header().entry_type();
        let path = entry.path().context("read Agent Package entry path")?;
        let normalized = normalized_package_path(&path)?;
        if entry_type.is_dir() {
            create_private_dir(&staging_dir.join(normalized))?;
            continue;
        }
        if !entry_type.is_file() {
            bail!("Agent Package archive contains a non-file entry");
        }
        if !extracted_files.insert(normalized.clone()) {
            bail!("Agent Package archive contains a duplicate file path");
        }
        if extracted_files.len() > MAX_FILE_COUNT {
            bail!("Agent Package archive contains too many files");
        }
        let size = entry.header().size().context("read Package entry size")?;
        if size > MAX_FILE_BYTES {
            bail!("Agent Package file exceeds the allowed size");
        }
        total_size = total_size
            .checked_add(size)
            .ok_or_else(|| anyhow!("Agent Package unpacked size overflow"))?;
        if total_size > MAX_UNPACKED_BYTES {
            bail!("Agent Package unpacked size exceeds the allowed limit");
        }
        let destination = staging_dir.join(&normalized);
        if let Some(parent) = destination.parent() {
            create_private_dir(parent)?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .with_context(|| format!("create staged Package file {}", normalized.display()))?;
        set_private_file_permissions(&destination)?;
        let copied = std::io::copy(&mut entry, &mut output)
            .with_context(|| format!("extract staged Package file {}", normalized.display()))?;
        if copied != size {
            bail!("Agent Package file size changed while extracting");
        }
        output.flush().context("flush staged Package file")?;
    }

    if !extracted_files.contains(Path::new(PACKAGE_MANIFEST_PATH))
        || !extracted_files.contains(Path::new(FILE_MANIFEST_PATH))
    {
        bail!("Agent Package is missing a required manifest");
    }
    verify_file_manifest(staging_dir, &extracted_files)?;
    let manifest_document = read_bounded_text(
        &staging_dir.join(PACKAGE_MANIFEST_PATH),
        MAX_FILE_BYTES as usize,
    )?;
    let manifest = AgentPackageCatalog::parse_document(&manifest_document)?;
    if manifest.package_id != envelope.package_id
        || manifest.version != envelope.version
        || manifest.publisher != envelope.publisher
    {
        bail!("Agent Package identity does not match its signed envelope");
    }
    verify_referenced_paths(staging_dir, &manifest)?;
    let file_manifest_sha256 = digest_file_manifest(staging_dir)?;
    Ok((manifest, file_manifest_sha256))
}

fn verify_file_manifest(staging_dir: &Path, extracted_files: &HashSet<PathBuf>) -> Result<()> {
    let document = read_bounded_text(
        &staging_dir.join(FILE_MANIFEST_PATH),
        MAX_FILE_BYTES as usize,
    )?;
    let manifest: PackageFileManifest =
        serde_json::from_str(&document).context("parse Agent Package file manifest")?;
    if manifest.schema_version != FILE_MANIFEST_SCHEMA_VERSION {
        bail!(
            "unsupported Agent Package file manifest schema version: {}",
            manifest.schema_version
        );
    }
    let expected_files = extracted_files
        .iter()
        .filter(|path| path.as_path() != Path::new(FILE_MANIFEST_PATH))
        .collect::<HashSet<_>>();
    if manifest.files.len() != expected_files.len() {
        bail!("Agent Package file manifest does not cover every file");
    }
    let mut previous_path: Option<&str> = None;
    let mut seen = HashSet::new();
    for record in &manifest.files {
        let path = normalized_package_path(Path::new(&record.path))?;
        if previous_path.is_some_and(|previous| previous >= record.path.as_str()) {
            bail!("Agent Package file manifest must be uniquely sorted by path");
        }
        previous_path = Some(&record.path);
        if !seen.insert(path.clone()) || !expected_files.contains(&path) {
            bail!("Agent Package file manifest contains an unknown or duplicate path");
        }
        if record.size > MAX_FILE_BYTES {
            bail!("Agent Package file manifest declares an oversized file");
        }
        validate_sha256("files.sha256", &record.sha256)?;
        let actual_path = staging_dir.join(&path);
        let metadata = fs::metadata(&actual_path)
            .with_context(|| format!("read staged Package file {}", path.display()))?;
        if metadata.len() != record.size {
            bail!("Agent Package file size does not match its file manifest");
        }
        let actual_digest = digest_unbounded_file(&actual_path)?;
        if actual_digest != record.sha256 {
            bail!("Agent Package file digest does not match its file manifest");
        }
    }
    Ok(())
}

pub(super) fn verify_installed_package_tree(
    directory: &Path,
    expected_file_manifest_sha256: &str,
) -> Result<AgentPackageManifest> {
    validate_sha256("fileManifestSha256", expected_file_manifest_sha256)?;
    let actual_file_manifest_sha256 = digest_file_manifest(directory)?;
    if actual_file_manifest_sha256 != expected_file_manifest_sha256 {
        bail!("installed Agent Package file manifest digest is invalid");
    }

    let mut extracted_files = HashSet::new();
    let mut entry_count = 0_usize;
    let mut total_size = 0_u64;
    for entry in WalkDir::new(directory).follow_links(false).min_depth(1) {
        let entry = entry.context("walk installed Agent Package")?;
        entry_count = entry_count
            .checked_add(1)
            .ok_or_else(|| anyhow!("installed Agent Package entry count overflow"))?;
        if entry_count > MAX_ARCHIVE_ENTRY_COUNT {
            bail!("installed Agent Package contains too many entries");
        }
        if entry.file_type().is_symlink() {
            bail!("installed Agent Package contains a symlink");
        }
        let relative = entry
            .path()
            .strip_prefix(directory)
            .context("installed Agent Package path escaped its root")?;
        let normalized = normalized_package_path(relative)?;
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() || !extracted_files.insert(normalized) {
            bail!("installed Agent Package contains an invalid or duplicate file");
        }
        if extracted_files.len() > MAX_FILE_COUNT {
            bail!("installed Agent Package contains too many files");
        }
        let size = entry
            .metadata()
            .context("read installed Agent Package file metadata")?
            .len();
        if size > MAX_FILE_BYTES {
            bail!("installed Agent Package file exceeds the allowed size");
        }
        total_size = total_size
            .checked_add(size)
            .ok_or_else(|| anyhow!("installed Agent Package size overflow"))?;
        if total_size > MAX_UNPACKED_BYTES {
            bail!("installed Agent Package size exceeds the allowed limit");
        }
    }
    if !extracted_files.contains(Path::new(PACKAGE_MANIFEST_PATH))
        || !extracted_files.contains(Path::new(FILE_MANIFEST_PATH))
    {
        bail!("installed Agent Package is missing a required manifest");
    }
    verify_file_manifest(directory, &extracted_files)?;
    let manifest_document = read_bounded_text(
        &directory.join(PACKAGE_MANIFEST_PATH),
        MAX_FILE_BYTES as usize,
    )?;
    let manifest = AgentPackageCatalog::parse_document(&manifest_document)?;
    verify_referenced_paths(directory, &manifest)?;
    Ok(manifest)
}

fn digest_file_manifest(directory: &Path) -> Result<String> {
    let path = directory.join(FILE_MANIFEST_PATH);
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("read Package file manifest metadata {}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_FILE_BYTES {
        bail!("Agent Package file manifest is invalid");
    }
    digest_unbounded_file(&path)
}

fn verify_referenced_paths(staging_dir: &Path, manifest: &AgentPackageManifest) -> Result<()> {
    let mut references = vec![manifest.skills.canonical_workflow.as_str()];
    references.extend(
        manifest
            .skills
            .adapters
            .iter()
            .map(|adapter| adapter.path.as_str()),
    );
    for reference in references {
        let path = normalized_package_path(Path::new(reference))?;
        if !staging_dir.join(&path).is_file() {
            bail!(
                "Agent Package references a missing file: {}",
                path.display()
            );
        }
    }
    Ok(())
}

pub(super) fn normalized_package_path(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .to_string_lossy()
            .bytes()
            .any(|byte| byte == b'\\' || byte == 0)
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("Agent Package path is not a normalized relative path");
    }
    Ok(path.to_path_buf())
}

fn read_bounded_text(path: &Path, max_bytes: usize) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("open Package metadata {}", path.display()))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read Package metadata {}", path.display()))?;
    if bytes.len() > max_bytes {
        bail!("Agent Package metadata exceeds the allowed size");
    }
    String::from_utf8(bytes).context("Agent Package metadata must be UTF-8")
}

fn digest_unbounded_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest)?;
    Ok(lower_hex(&digest.finalize()))
}

pub(super) fn validate_sha256(field: &str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("Agent Package {field} is not a lowercase SHA-256 digest");
    }
    Ok(())
}

pub(super) fn lower_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("write to String");
    }
    output
}

fn create_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .with_context(|| format!("create private directory {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("secure private directory {}", path.display()))?;
    }
    Ok(())
}

fn create_private_new_dir(path: &Path) -> Result<()> {
    fs::create_dir(path)
        .with_context(|| format!("create private staging directory {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("secure private staging directory {}", path.display()))?;
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("secure staged Package file {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
pub(super) struct DownloadArtifactFixture {
    pub artifact: Vec<u8>,
    pub envelope: String,
    pub artifact_sha256: String,
    pub envelope_sha256: String,
    pub file_manifest_sha256: String,
    pub signature_key_id: String,
}

#[cfg(test)]
pub(super) fn download_artifact_fixture_for_test() -> DownloadArtifactFixture {
    use ed25519_dalek::{Signer as _, SigningKey};

    const JOB_MANIFEST: &str = include_str!("packages/job-agent/agentmesh-agent.toml");
    let mut files = HashMap::from([
        (
            PACKAGE_MANIFEST_PATH.to_owned(),
            JOB_MANIFEST.as_bytes().to_vec(),
        ),
        (
            "docs/agent-onboarding.md".into(),
            b"# Job Agent workflow\n".to_vec(),
        ),
        (
            "skills/claude-code/SKILL.md".into(),
            b"# Claude Code adapter\n".to_vec(),
        ),
        (
            "skills/openclaw-job-agent/SKILL.md".into(),
            b"# OpenClaw adapter\n".to_vec(),
        ),
    ]);
    let mut records = files
        .iter()
        .map(|(path, contents)| PackageFileRecord {
            path: path.clone(),
            size: contents.len() as u64,
            sha256: lower_hex(&Sha256::digest(contents)),
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.path.cmp(&right.path));
    files.insert(
        FILE_MANIFEST_PATH.into(),
        serde_json::to_vec(&PackageFileManifest {
            schema_version: FILE_MANIFEST_SCHEMA_VERSION,
            files: records,
        })
        .expect("serialize Package download fixture inventory"),
    );
    let file_manifest_sha256 = lower_hex(&Sha256::digest(&files[FILE_MANIFEST_PATH]));

    let mut artifact = Vec::new();
    {
        let encoder = zstd::stream::write::Encoder::new(&mut artifact, 3).expect("zstd");
        let mut archive = tar::Builder::new(encoder);
        let mut paths = files.keys().cloned().collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let contents = &files[&path];
            let mut header = tar::Header::new_gnu();
            header.set_path(&path).expect("fixture path");
            header.set_size(contents.len() as u64);
            header.set_mode(0o600);
            header.set_cksum();
            archive
                .append(&header, contents.as_slice())
                .expect("append fixture file");
        }
        let encoder = archive.into_inner().expect("finish fixture tar");
        encoder.finish().expect("finish fixture zstd");
    }
    let artifact_sha256 = lower_hex(&Sha256::digest(&artifact));
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let mut envelope = PackageSignatureEnvelope {
        schema_version: SIGNATURE_SCHEMA_VERSION,
        key_id: "agentmesh360-release-test".into(),
        publisher: "agentmesh360".into(),
        package_id: "com.agentmesh360.job-agent".into(),
        version: "0.4.8".into(),
        artifact_sha256: artifact_sha256.clone(),
        signature: String::new(),
    };
    envelope.signature = BASE64.encode(
        signing_key
            .sign(signature_payload(&envelope).as_bytes())
            .to_bytes(),
    );
    let envelope = serde_json::to_string(&envelope).expect("serialize Package download envelope");
    let envelope_sha256 = lower_hex(&Sha256::digest(envelope.as_bytes()));
    DownloadArtifactFixture {
        artifact,
        envelope,
        artifact_sha256,
        envelope_sha256,
        file_manifest_sha256,
        signature_key_id: "agentmesh360-release-test".into(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;

    const JOB_MANIFEST: &str = include_str!("packages/job-agent/agentmesh-agent.toml");
    const TEST_KEY_ID: &str = "agentmesh360-test-2026";
    const TEST_PUBLISHER: &str = "agentmesh360";

    #[test]
    fn verifies_signature_inventory_identity_and_referenced_files_before_staging() {
        let fixture = fixture();
        let verified = fixture
            .verifier()
            .verify_to_staging(&fixture.artifact_path, &fixture.envelope)
            .expect("verify package");

        assert_eq!(verified.manifest.package_id, "com.agentmesh360.job-agent");
        assert_eq!(verified.manifest.version, "0.4.8");
        assert_eq!(verified.signature_key_id, TEST_KEY_ID);
        assert_eq!(verified.artifact_sha256.len(), 64);
        assert_eq!(verified.file_manifest_sha256.len(), 64);
        assert!(
            verified
                .staging_path()
                .join("docs/agent-onboarding.md")
                .is_file()
        );
    }

    #[test]
    fn rejects_tampered_artifact_before_creating_staging_content() {
        let fixture = fixture();
        OpenOptions::new()
            .append(true)
            .open(&fixture.artifact_path)
            .expect("open artifact")
            .write_all(b"tamper")
            .expect("tamper artifact");

        let error = fixture
            .verifier()
            .verify_to_staging(&fixture.artifact_path, &fixture.envelope)
            .expect_err("tampered artifact");

        assert!(error.to_string().contains("digest"));
        assert!(!fixture.staging_root().exists());
    }

    #[test]
    fn rejects_unknown_signing_key() {
        let fixture = fixture();
        let verifier = PackageArtifactVerifier::in_home(fixture.temp.path());

        let error = verifier
            .verify_to_staging(&fixture.artifact_path, &fixture.envelope)
            .expect_err("unknown key");

        assert!(error.to_string().contains("not trusted"));
    }

    #[test]
    fn rejects_signed_archive_with_unlisted_or_modified_files() {
        let mut files = fixture_files();
        let records = file_records(&files);
        files.insert(
            FILE_MANIFEST_PATH.into(),
            serde_json::to_vec(&PackageFileManifest {
                schema_version: 1,
                files: records,
            })
            .expect("file manifest"),
        );
        files.insert("unlisted.txt".into(), b"not covered".to_vec());
        let fixture = signed_fixture(files, None);

        let error = fixture
            .verifier()
            .verify_to_staging(&fixture.artifact_path, &fixture.envelope)
            .expect_err("unlisted file");

        assert!(error.to_string().contains("does not cover"));
    }

    #[test]
    fn rejects_signed_archive_path_traversal_without_writing_outside_staging() {
        let fixture = signed_fixture(fixture_files_with_inventory(), Some("../outside.txt"));

        let error = fixture
            .verifier()
            .verify_to_staging(&fixture.artifact_path, &fixture.envelope)
            .expect_err("path traversal");

        assert!(error.to_string().contains("normalized relative path"));
        assert!(!fixture.temp.path().join("outside.txt").exists());
    }

    #[test]
    fn rejects_manifest_identity_that_differs_from_signed_envelope() {
        let fixture = fixture();
        let mut envelope: PackageSignatureEnvelope =
            serde_json::from_str(&fixture.envelope).expect("envelope");
        envelope.package_id = "com.agentmesh360.other-agent".into();
        resign_envelope(&mut envelope, &fixture.signing_key);
        let envelope = serde_json::to_string(&envelope).expect("envelope json");

        let error = fixture
            .verifier()
            .verify_to_staging(&fixture.artifact_path, &envelope)
            .expect_err("identity mismatch");

        assert!(error.to_string().contains("identity"));
    }

    #[cfg(unix)]
    #[test]
    fn extraction_reuses_the_file_handle_that_was_digested() {
        let fixture = fixture();
        let envelope: PackageSignatureEnvelope =
            serde_json::from_str(&fixture.envelope).expect("envelope");
        let (artifact, digest) =
            open_and_digest_artifact(&fixture.artifact_path).expect("open verified artifact");
        assert_eq!(digest, envelope.artifact_sha256);

        fs::remove_file(&fixture.artifact_path).expect("unlink original artifact");
        let mut replacement = fixture_files_with_inventory();
        replacement.insert(
            "docs/agent-onboarding.md".into(),
            b"# attacker-controlled replacement\n".to_vec(),
        );
        write_archive(&fixture.artifact_path, &replacement, None);
        let staging_dir = fixture.temp.path().join("same-file-handle");
        create_private_new_dir(&staging_dir).expect("staging");

        extract_and_verify(artifact, &staging_dir, &envelope)
            .expect("extract originally verified file handle");
        assert_eq!(
            fs::read_to_string(staging_dir.join("docs/agent-onboarding.md"))
                .expect("read extracted workflow"),
            "# Job Agent workflow\n"
        );
    }

    #[test]
    fn rejects_archive_with_too_many_directory_entries() {
        let fixture = fixture();
        write_archive_with_directories(
            &fixture.artifact_path,
            &fixture_files_with_inventory(),
            MAX_ARCHIVE_ENTRY_COUNT,
        );
        let mut envelope: PackageSignatureEnvelope =
            serde_json::from_str(&fixture.envelope).expect("envelope");
        envelope.artifact_sha256 =
            digest_artifact(&fixture.artifact_path).expect("artifact digest");
        resign_envelope(&mut envelope, &fixture.signing_key);
        let envelope = serde_json::to_string(&envelope).expect("envelope json");

        let error = fixture
            .verifier()
            .verify_to_staging(&fixture.artifact_path, &envelope)
            .expect_err("directory entry limit");

        assert!(error.to_string().contains("too many entries"));
        assert!(
            fixture
                .staging_root()
                .read_dir()
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true)
        );
    }

    struct Fixture {
        temp: tempfile::TempDir,
        artifact_path: PathBuf,
        envelope: String,
        signing_key: SigningKey,
    }

    impl Fixture {
        fn verifier(&self) -> PackageArtifactVerifier {
            PackageArtifactVerifier::with_trust_store(
                self.temp.path(),
                TrustedPublisherStore::with_key(TrustedPublisherKey {
                    key_id: TEST_KEY_ID.into(),
                    publisher: TEST_PUBLISHER.into(),
                    public_key: self.signing_key.verifying_key().to_bytes(),
                }),
            )
        }

        fn staging_root(&self) -> PathBuf {
            self.temp.path().join("packages").join(".staging")
        }
    }

    fn fixture() -> Fixture {
        signed_fixture(fixture_files_with_inventory(), None)
    }

    fn fixture_files() -> HashMap<String, Vec<u8>> {
        HashMap::from([
            (
                PACKAGE_MANIFEST_PATH.into(),
                JOB_MANIFEST.as_bytes().to_vec(),
            ),
            (
                "docs/agent-onboarding.md".into(),
                b"# Job Agent workflow\n".to_vec(),
            ),
            (
                "skills/claude-code/SKILL.md".into(),
                b"# Claude Code adapter\n".to_vec(),
            ),
            (
                "skills/openclaw-job-agent/SKILL.md".into(),
                b"# OpenClaw adapter\n".to_vec(),
            ),
        ])
    }

    fn fixture_files_with_inventory() -> HashMap<String, Vec<u8>> {
        let mut files = fixture_files();
        let file_manifest = PackageFileManifest {
            schema_version: 1,
            files: file_records(&files),
        };
        files.insert(
            FILE_MANIFEST_PATH.into(),
            serde_json::to_vec(&file_manifest).expect("file manifest"),
        );
        files
    }

    fn file_records(files: &HashMap<String, Vec<u8>>) -> Vec<PackageFileRecord> {
        let mut records = files
            .iter()
            .filter(|(path, _)| path.as_str() != FILE_MANIFEST_PATH)
            .map(|(path, contents)| PackageFileRecord {
                path: path.clone(),
                size: contents.len() as u64,
                sha256: lower_hex(&Sha256::digest(contents)),
            })
            .collect::<Vec<_>>();
        records.sort_by(|left, right| left.path.cmp(&right.path));
        records
    }

    fn signed_fixture(files: HashMap<String, Vec<u8>>, malicious_path: Option<&str>) -> Fixture {
        let temp = tempfile::tempdir().expect("tempdir");
        let artifact_path = temp.path().join("job-agent.ampkg.tar.zst");
        write_archive(&artifact_path, &files, malicious_path);
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut envelope = PackageSignatureEnvelope {
            schema_version: 1,
            key_id: TEST_KEY_ID.into(),
            publisher: TEST_PUBLISHER.into(),
            package_id: "com.agentmesh360.job-agent".into(),
            version: "0.4.8".into(),
            artifact_sha256: digest_artifact(&artifact_path).expect("artifact digest"),
            signature: String::new(),
        };
        resign_envelope(&mut envelope, &signing_key);
        Fixture {
            temp,
            artifact_path,
            envelope: serde_json::to_string(&envelope).expect("envelope json"),
            signing_key,
        }
    }

    fn resign_envelope(envelope: &mut PackageSignatureEnvelope, signing_key: &SigningKey) {
        let signature = signing_key.sign(signature_payload(envelope).as_bytes());
        envelope.signature = BASE64.encode(signature.to_bytes());
    }

    fn write_archive(
        destination: &Path,
        files: &HashMap<String, Vec<u8>>,
        malicious_path: Option<&str>,
    ) {
        let output = File::create(destination).expect("artifact");
        let encoder = zstd::stream::write::Encoder::new(output, 3).expect("zstd");
        let mut archive = tar::Builder::new(encoder);
        let mut paths = files.keys().cloned().collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let contents = &files[&path];
            append_file(&mut archive, &path, contents);
        }
        if let Some(path) = malicious_path {
            append_raw_path(&mut archive, path, b"escape");
        }
        let encoder = archive.into_inner().expect("finish tar");
        encoder.finish().expect("finish zstd");
    }

    fn write_archive_with_directories(
        destination: &Path,
        files: &HashMap<String, Vec<u8>>,
        directory_count: usize,
    ) {
        let output = File::create(destination).expect("artifact");
        let encoder = zstd::stream::write::Encoder::new(output, 3).expect("zstd");
        let mut archive = tar::Builder::new(encoder);
        let mut paths = files.keys().cloned().collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            append_file(&mut archive, &path, &files[&path]);
        }
        for index in 0..directory_count {
            let mut header = tar::Header::new_gnu();
            header
                .set_path(format!("empty/{index:04}"))
                .expect("directory path");
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_mode(0o700);
            header.set_mtime(0);
            header.set_cksum();
            archive
                .append(&header, Cursor::new(Vec::<u8>::new()))
                .expect("append directory");
        }
        let encoder = archive.into_inner().expect("finish tar");
        encoder.finish().expect("finish zstd");
    }

    fn append_file(
        archive: &mut tar::Builder<zstd::Encoder<'_, File>>,
        path: &str,
        contents: &[u8],
    ) {
        let mut header = tar::Header::new_gnu();
        header.set_path(path).expect("tar path");
        header.set_size(contents.len() as u64);
        header.set_mode(0o600);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append(&header, Cursor::new(contents))
            .expect("append file");
    }

    fn append_raw_path(
        archive: &mut tar::Builder<zstd::Encoder<'_, File>>,
        path: &str,
        contents: &[u8],
    ) {
        let mut header = tar::Header::new_gnu();
        header.as_mut_bytes()[..100].fill(0);
        header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
        header.set_size(contents.len() as u64);
        header.set_mode(0o600);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append(&header, Cursor::new(contents))
            .expect("append raw path");
    }
}
