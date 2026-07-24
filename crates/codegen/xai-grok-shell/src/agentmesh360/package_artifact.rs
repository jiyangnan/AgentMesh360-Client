use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::agent_packages::{AgentPackageCatalog, AgentPackageManifest};

const SIGNATURE_SCHEMA_VERSION: u32 = 1;
const FILE_MANIFEST_SCHEMA_VERSION: u32 = 1;
const PACKAGE_MANIFEST_PATH: &str = "agentmesh-agent.toml";
const FILE_MANIFEST_PATH: &str = "package-files.v1.json";
const MAX_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILE_COUNT: usize = 1024;

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
struct PackageFileManifest {
    schema_version: u32,
    files: Vec<PackageFileRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageFileRecord {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct TrustedPublisherKey {
    pub key_id: &'static str,
    pub publisher: &'static str,
    pub public_key: [u8; 32],
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TrustedPublisherStore {
    keys: HashMap<&'static str, TrustedPublisherKey>,
}

impl TrustedPublisherStore {
    pub(crate) fn embedded() -> Self {
        // Production publisher keys are intentionally not fabricated in H1a. Until an audited
        // AgentMesh360 release key is embedded, the production trust store rejects every
        // externally supplied Package.
        Self::default()
    }

    #[cfg(test)]
    fn with_key(key: TrustedPublisherKey) -> Self {
        Self {
            keys: HashMap::from([(key.key_id, key)]),
        }
    }

    fn get(&self, key_id: &str) -> Result<&TrustedPublisherKey> {
        self.keys
            .get(key_id)
            .ok_or_else(|| anyhow!("Agent Package signature key is not trusted"))
    }
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

    #[cfg(test)]
    fn with_trust_store(state_home: impl AsRef<Path>, trust_store: TrustedPublisherStore) -> Self {
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
        let envelope: PackageSignatureEnvelope =
            serde_json::from_str(envelope_document).context("parse Agent Package signature")?;
        validate_envelope(&envelope)?;
        let artifact_sha256 = digest_artifact(artifact_path)?;
        if artifact_sha256 != envelope.artifact_sha256 {
            bail!("Agent Package artifact digest does not match signed envelope");
        }
        self.verify_signature(&envelope)?;

        create_private_dir(&self.staging_root)?;
        let staging_dir = self.staging_root.join(format!("verify-{}", Uuid::now_v7()));
        create_private_new_dir(&staging_dir)?;
        match extract_and_verify(artifact_path, &staging_dir, &envelope) {
            Ok(manifest) => Ok(VerifiedStagedPackage {
                manifest,
                artifact_sha256,
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
    pub signature_key_id: String,
    staging_dir: Option<PathBuf>,
}

impl VerifiedStagedPackage {
    #[cfg(test)]
    fn path(&self) -> &Path {
        self.staging_dir.as_deref().expect("staging path")
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

fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.' | b'_')
        })
        && !value.starts_with(['-', '.', '_'])
        && !value.ends_with(['-', '.', '_'])
}

fn signature_payload(envelope: &PackageSignatureEnvelope) -> String {
    format!(
        "agentmesh360-package-signature-v1\nkeyId={}\npublisher={}\npackageId={}\nversion={}\nartifactSha256={}\n",
        envelope.key_id,
        envelope.publisher,
        envelope.package_id,
        envelope.version,
        envelope.artifact_sha256
    )
}

fn digest_artifact(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("read Agent Package artifact metadata {}", path.display()))?;
    if !metadata.is_file() {
        bail!("Agent Package artifact must be a regular file");
    }
    if metadata.len() == 0 || metadata.len() > MAX_ARTIFACT_BYTES {
        bail!("Agent Package artifact size is outside the allowed range");
    }
    let mut file = File::open(path)
        .with_context(|| format!("open Agent Package artifact {}", path.display()))?;
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest).context("hash Agent Package artifact")?;
    Ok(lower_hex(&digest.finalize()))
}

fn extract_and_verify(
    artifact_path: &Path,
    staging_dir: &Path,
    envelope: &PackageSignatureEnvelope,
) -> Result<AgentPackageManifest> {
    let artifact = File::open(artifact_path).context("open signed Agent Package artifact")?;
    let decoder =
        zstd::stream::read::Decoder::new(artifact).context("decode Agent Package zstd artifact")?;
    let mut archive = tar::Archive::new(decoder);
    let mut extracted_files = HashSet::new();
    let mut total_size = 0_u64;

    for entry in archive.entries().context("read Agent Package archive")? {
        let mut entry = entry.context("read Agent Package archive entry")?;
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
    Ok(manifest)
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

fn normalized_package_path(path: &Path) -> Result<PathBuf> {
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

fn validate_sha256(field: &str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("Agent Package {field} is not a lowercase SHA-256 digest");
    }
    Ok(())
}

fn lower_hex(bytes: &[u8]) -> String {
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
        assert_eq!(verified.manifest.version, "0.4.7");
        assert_eq!(verified.signature_key_id, TEST_KEY_ID);
        assert_eq!(verified.artifact_sha256.len(), 64);
        assert!(verified.path().join("docs/agent-onboarding.md").is_file());
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
                    key_id: TEST_KEY_ID,
                    publisher: TEST_PUBLISHER,
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
            version: "0.4.7".into(),
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
