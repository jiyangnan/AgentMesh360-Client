//! Offline, deterministic AgentMesh360 Package authoring.
//!
//! This module intentionally has no network client and no private-key input.
//! It turns one reviewed Package Manifest plus an explicit allowlist of Skill
//! source files into:
//! - a deterministic `.ampkg.tar.zst` artifact for the persistent client Agent;
//! - a non-secret signing request for an external Ed25519 signer; and
//! - a Host Skill projection proving which exact source bytes back each adapter.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::agent_packages::{
    AgentPackageCatalog, AgentPackageManifest, PackagePermission, SkillHost,
};
use super::package_artifact::{
    FILE_MANIFEST_PATH, FILE_MANIFEST_SCHEMA_VERSION, HOST_SKILL_PLAN_PATH, MAX_ARTIFACT_BYTES,
    MAX_FILE_BYTES, MAX_FILE_COUNT, MAX_UNPACKED_BYTES, PACKAGE_MANIFEST_PATH, PackageFileManifest,
    PackageFileRecord, PackageSignatureEnvelope, SIGNATURE_SCHEMA_VERSION, is_safe_identifier,
    lower_hex, normalized_package_path, signature_payload, validate_sha256,
};

const AUTHORING_DEFINITION_PATH: &str = "agentmesh-authoring.toml";
const AUTHORING_SCHEMA_VERSION: u32 = 1;
const SIGNING_REQUEST_SCHEMA_VERSION: u32 = 1;
const SIGNATURE_RESULT_SCHEMA_VERSION: u32 = 1;
const PUBLIC_KEY_SCHEMA_VERSION: u32 = 1;
pub(super) const HOST_SKILL_PLAN_SCHEMA_VERSION: u32 = 1;
pub(super) const HOST_PROJECTION_SCHEMA_VERSION: u32 = 1;
const MAX_AUTHORING_PATH_BYTES: usize = 512;
pub(super) const MAX_HOST_PROJECTION_BYTES: usize = 1024 * 1024;
const ZSTD_LEVEL: i32 = 3;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageAuthoringDefinition {
    schema_version: u32,
    #[serde(default)]
    package_files: Vec<String>,
    #[serde(default)]
    skill_bundles: Vec<SkillBundleDefinition>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillBundleDefinition {
    host: SkillHost,
    files: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SigningAlgorithm {
    Ed25519,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageSigningRequest {
    schema_version: u32,
    algorithm: SigningAlgorithm,
    key_id: String,
    publisher: String,
    package_id: String,
    version: String,
    artifact_file: String,
    artifact_sha256: String,
    payload_base64: String,
    payload_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageSignatureResult {
    schema_version: u32,
    algorithm: SigningAlgorithm,
    key_id: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublisherPublicKeyDocument {
    schema_version: u32,
    algorithm: SigningAlgorithm,
    key_id: String,
    public_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostSkillPlan {
    pub schema_version: u32,
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub publisher: String,
    pub requested_permissions: Vec<PackagePermission>,
    pub canonical_workflow: PackageFileRecord,
    pub skill_bundles: Vec<HostSkillBundleProjection>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostSkillProjection {
    pub schema_version: u32,
    pub artifact_sha256: String,
    pub plan_sha256: String,
    pub plan: HostSkillPlan,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostSkillBundleProjection {
    pub host: SkillHost,
    pub entrypoint: String,
    pub files: Vec<PackageFileRecord>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildReceipt {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub artifact_path: PathBuf,
    pub artifact_sha256: String,
    pub signing_request_path: PathBuf,
    pub signing_request_sha256: String,
    pub host_projection_path: PathBuf,
    pub host_projection_sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeReceipt {
    pub package_id: String,
    pub version: String,
    pub key_id: String,
    pub envelope_path: PathBuf,
    pub envelope_sha256: String,
}

#[derive(Debug)]
pub struct PackageAuthoringBuild {
    package_id: String,
    agent_id: String,
    version: String,
    artifact_file_name: String,
    artifact: Vec<u8>,
    artifact_sha256: String,
    signing_request_file_name: String,
    signing_request: Vec<u8>,
    host_projection_file_name: String,
    host_projection: Vec<u8>,
}

impl PackageAuthoringBuild {
    pub fn write_to_new_directory(self, output_dir: &Path) -> Result<BuildReceipt> {
        create_new_private_directory(output_dir)?;
        let result = (|| {
            let artifact_path = output_dir.join(&self.artifact_file_name);
            let signing_request_path = output_dir.join(&self.signing_request_file_name);
            let host_projection_path = output_dir.join(&self.host_projection_file_name);
            write_new_private_file(&artifact_path, &self.artifact)?;
            write_new_private_file(&signing_request_path, &self.signing_request)?;
            write_new_private_file(&host_projection_path, &self.host_projection)?;
            Ok(BuildReceipt {
                package_id: self.package_id,
                agent_id: self.agent_id,
                version: self.version,
                artifact_path,
                artifact_sha256: self.artifact_sha256,
                signing_request_path,
                signing_request_sha256: sha256_hex(&self.signing_request),
                host_projection_path,
                host_projection_sha256: sha256_hex(&self.host_projection),
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(output_dir);
        }
        result
    }
}

pub fn build_package(
    definition_dir: &Path,
    source_root: &Path,
    key_id: &str,
) -> Result<PackageAuthoringBuild> {
    if !is_safe_identifier(key_id) || key_id.len() > 128 {
        bail!("Agent Package authoring keyId is invalid");
    }
    let definition_dir = canonical_directory(definition_dir, "Package definition")?;
    let source_root = canonical_directory(source_root, "Package source")?;
    let manifest_document =
        read_definition_file(&definition_dir, PACKAGE_MANIFEST_PATH, MAX_FILE_BYTES)?;
    let manifest_document =
        String::from_utf8(manifest_document).context("Agent Package Manifest must be UTF-8")?;
    let manifest = AgentPackageCatalog::parse_document(&manifest_document)
        .context("validate Agent Package authoring Manifest")?;
    validate_canonical_version(
        &manifest.version,
        "Agent Package authoring Manifest version",
    )?;
    let definition_document =
        read_definition_file(&definition_dir, AUTHORING_DEFINITION_PATH, MAX_FILE_BYTES)?;
    let definition_document = String::from_utf8(definition_document)
        .context("Agent Package authoring definition must be UTF-8")?;
    let definition: PackageAuthoringDefinition =
        toml::from_str(&definition_document).context("parse Agent Package authoring definition")?;
    validate_definition(&definition, &manifest)?;

    let mut package_files = BTreeMap::new();
    package_files.insert(
        PACKAGE_MANIFEST_PATH.to_owned(),
        manifest_document.into_bytes(),
    );
    add_source_file(
        &source_root,
        &manifest.skills.canonical_workflow,
        &mut package_files,
    )?;
    for path in &definition.package_files {
        add_source_file(&source_root, path, &mut package_files)?;
    }
    for bundle in &definition.skill_bundles {
        for path in &bundle.files {
            add_source_file(&source_root, path, &mut package_files)?;
        }
    }
    enforce_package_limits(&package_files)?;

    let source_file_records = file_records(&package_files)?;
    let host_skill_plan = host_skill_plan(&manifest, &definition, &source_file_records)?;
    let host_skill_plan =
        serde_json::to_vec(&host_skill_plan).context("serialize signed Host Skill plan")?;
    if host_skill_plan.len() > MAX_HOST_PROJECTION_BYTES {
        bail!("signed Host Skill plan exceeds the allowed size");
    }
    let host_skill_plan_sha256 = sha256_hex(&host_skill_plan);
    package_files.insert(HOST_SKILL_PLAN_PATH.to_owned(), host_skill_plan);
    enforce_package_limits(&package_files)?;

    let file_records = file_records(&package_files)?;
    let file_manifest = serde_json::to_vec(&PackageFileManifest {
        schema_version: FILE_MANIFEST_SCHEMA_VERSION,
        files: file_records,
    })
    .context("serialize Agent Package file manifest")?;
    package_files.insert(FILE_MANIFEST_PATH.to_owned(), file_manifest);
    let artifact = deterministic_archive(&package_files)?;
    if artifact.is_empty() || artifact.len() as u64 > MAX_ARTIFACT_BYTES {
        bail!("authored Agent Package artifact size is outside the allowed range");
    }
    let artifact_sha256 = sha256_hex(&artifact);
    let artifact_file_name = format!("{}-{}.ampkg.tar.zst", manifest.package_id, manifest.version);
    validate_output_file_name(&artifact_file_name)?;

    let signing_request =
        signing_request(&manifest, key_id, &artifact_file_name, &artifact_sha256)?;
    let signing_request =
        serde_json::to_vec(&signing_request).context("serialize Agent Package signing request")?;
    let signed_plan_document = package_files
        .get(HOST_SKILL_PLAN_PATH)
        .ok_or_else(|| anyhow!("signed Host Skill plan is absent from authored Package"))?;
    let signed_plan: HostSkillPlan =
        serde_json::from_slice(signed_plan_document).context("reparse signed Host Skill plan")?;
    let host_projection = serde_json::to_vec(&HostSkillProjection {
        schema_version: HOST_PROJECTION_SCHEMA_VERSION,
        artifact_sha256: artifact_sha256.clone(),
        plan_sha256: host_skill_plan_sha256,
        plan: signed_plan,
    })
    .context("serialize Host Skill projection")?;
    if host_projection.len() > MAX_HOST_PROJECTION_BYTES {
        bail!("Host Skill projection exceeds the allowed size");
    }

    Ok(PackageAuthoringBuild {
        package_id: manifest.package_id.clone(),
        agent_id: manifest.agent.agent_id.clone(),
        version: manifest.version.clone(),
        artifact_file_name,
        artifact,
        artifact_sha256,
        signing_request_file_name: format!(
            "{}-{}.signing-request.v1.json",
            manifest.package_id, manifest.version
        ),
        signing_request,
        host_projection_file_name: format!(
            "{}-{}.host-skills.v1.json",
            manifest.package_id, manifest.version
        ),
        host_projection,
    })
}

pub fn finalize_external_signature(
    request_path: &Path,
    artifact_path: &Path,
    signature_result_path: &Path,
    public_key_path: &Path,
    envelope_path: &Path,
) -> Result<FinalizeReceipt> {
    let request_document = read_regular_file(request_path, MAX_FILE_BYTES)
        .context("read Agent Package signing request")?;
    let request: PackageSigningRequest =
        serde_json::from_slice(&request_document).context("parse Agent Package signing request")?;
    validate_signing_request(&request)?;
    let artifact_file_name = artifact_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("Agent Package artifact file name is invalid"))?;
    if artifact_file_name != request.artifact_file {
        bail!("Agent Package artifact file name does not match its signing request");
    }
    let artifact = read_regular_file(artifact_path, MAX_ARTIFACT_BYTES)
        .context("read Agent Package artifact for external signature finalization")?;
    if artifact.is_empty() || sha256_hex(&artifact) != request.artifact_sha256 {
        bail!("Agent Package artifact digest does not match its signing request");
    }
    let signature_document = read_regular_file(signature_result_path, MAX_FILE_BYTES)
        .context("read Agent Package signature result")?;
    let signature_result: PackageSignatureResult = serde_json::from_slice(&signature_document)
        .context("parse Agent Package signature result")?;
    let public_key_document = read_regular_file(public_key_path, MAX_FILE_BYTES)
        .context("read Agent Package publisher public key")?;
    let public_key: PublisherPublicKeyDocument = serde_json::from_slice(&public_key_document)
        .context("parse Agent Package publisher public key")?;

    if signature_result.schema_version != SIGNATURE_RESULT_SCHEMA_VERSION
        || signature_result.algorithm != SigningAlgorithm::Ed25519
        || signature_result.key_id != request.key_id
        || public_key.schema_version != PUBLIC_KEY_SCHEMA_VERSION
        || public_key.algorithm != SigningAlgorithm::Ed25519
        || public_key.key_id != request.key_id
    {
        bail!("Agent Package external signature identity does not match its request");
    }
    let signature_bytes = decode_canonical_base64("signature", &signature_result.signature, 64)?;
    let public_key_bytes = decode_canonical_base64("publicKey", &public_key.public_key, 32)?;
    let public_key_bytes: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| anyhow!("Agent Package publisher public key length is invalid"))?;
    let verifying_key =
        VerifyingKey::from_bytes(&public_key_bytes).context("load Agent Package publisher key")?;
    let signature =
        Signature::from_slice(&signature_bytes).context("parse Agent Package signature")?;
    let payload = decode_signing_payload(&request)?;
    verifying_key
        .verify_strict(&payload, &signature)
        .context("verify external Agent Package signature")?;

    let envelope = PackageSignatureEnvelope {
        schema_version: SIGNATURE_SCHEMA_VERSION,
        key_id: request.key_id.clone(),
        publisher: request.publisher,
        package_id: request.package_id.clone(),
        version: request.version.clone(),
        artifact_sha256: request.artifact_sha256,
        signature: signature_result.signature,
    };
    let envelope_document =
        serde_json::to_vec(&envelope).context("serialize Agent Package signature envelope")?;
    write_new_private_file(envelope_path, &envelope_document)?;
    Ok(FinalizeReceipt {
        package_id: request.package_id,
        version: request.version,
        key_id: request.key_id,
        envelope_path: envelope_path.to_path_buf(),
        envelope_sha256: sha256_hex(&envelope_document),
    })
}

fn validate_definition(
    definition: &PackageAuthoringDefinition,
    manifest: &AgentPackageManifest,
) -> Result<()> {
    if definition.schema_version != AUTHORING_SCHEMA_VERSION {
        bail!(
            "unsupported Agent Package authoring schema version: {}",
            definition.schema_version
        );
    }
    let adapters = manifest
        .skills
        .adapters
        .iter()
        .map(|adapter| (adapter.host, adapter.path.as_str()))
        .collect::<HashMap<_, _>>();
    if adapters.len() != definition.skill_bundles.len() {
        bail!("Agent Package authoring must define exactly one bundle per Skill adapter");
    }
    let canonical = normalize_authoring_path(&manifest.skills.canonical_workflow)?;
    let mut declared_package_files = HashSet::new();
    for path in &definition.package_files {
        let path = normalize_authoring_path(path)?;
        reject_reserved_source_path(&path)?;
        if path == canonical || !declared_package_files.insert(path) {
            bail!("Agent Package authoring packageFiles contains a duplicate or implied path");
        }
    }
    let mut hosts = HashSet::new();
    for bundle in &definition.skill_bundles {
        if !hosts.insert(bundle.host) || bundle.files.is_empty() {
            bail!("Agent Package authoring Skill bundle host is duplicate or empty");
        }
        let expected_entrypoint = adapters
            .get(&bundle.host)
            .ok_or_else(|| anyhow!("Agent Package authoring has a bundle for an unknown host"))?;
        let expected_entrypoint = normalize_authoring_path(expected_entrypoint)?;
        let mut files = HashSet::new();
        for path in &bundle.files {
            let path = normalize_authoring_path(path)?;
            reject_reserved_source_path(&path)?;
            if !files.insert(path) {
                bail!("Agent Package authoring Skill bundle contains duplicate files");
            }
        }
        if !files.contains(&expected_entrypoint) {
            bail!("Agent Package authoring Skill bundle omits its Manifest adapter entrypoint");
        }
    }
    Ok(())
}

fn signing_request(
    manifest: &AgentPackageManifest,
    key_id: &str,
    artifact_file: &str,
    artifact_sha256: &str,
) -> Result<PackageSigningRequest> {
    validate_sha256("artifactSha256", artifact_sha256)?;
    let envelope = PackageSignatureEnvelope {
        schema_version: SIGNATURE_SCHEMA_VERSION,
        key_id: key_id.to_owned(),
        publisher: manifest.publisher.clone(),
        package_id: manifest.package_id.clone(),
        version: manifest.version.clone(),
        artifact_sha256: artifact_sha256.to_owned(),
        signature: String::new(),
    };
    let payload = signature_payload(&envelope).into_bytes();
    Ok(PackageSigningRequest {
        schema_version: SIGNING_REQUEST_SCHEMA_VERSION,
        algorithm: SigningAlgorithm::Ed25519,
        key_id: key_id.to_owned(),
        publisher: manifest.publisher.clone(),
        package_id: manifest.package_id.clone(),
        version: manifest.version.clone(),
        artifact_file: artifact_file.to_owned(),
        artifact_sha256: artifact_sha256.to_owned(),
        payload_base64: BASE64.encode(&payload),
        payload_sha256: sha256_hex(&payload),
    })
}

fn validate_signing_request(request: &PackageSigningRequest) -> Result<()> {
    if request.schema_version != SIGNING_REQUEST_SCHEMA_VERSION
        || request.algorithm != SigningAlgorithm::Ed25519
        || !is_safe_identifier(&request.key_id)
        || !is_safe_identifier(&request.publisher)
        || !is_safe_identifier(&request.package_id)
        || request.key_id.len() > 128
        || request.publisher.len() > 128
        || request.package_id.len() > 128
    {
        bail!("Agent Package signing request identity is invalid");
    }
    validate_canonical_version(&request.version, "Agent Package signing request version")?;
    validate_sha256("artifactSha256", &request.artifact_sha256)?;
    validate_sha256("payloadSha256", &request.payload_sha256)?;
    validate_output_file_name(&request.artifact_file)?;
    if request.artifact_file != format!("{}-{}.ampkg.tar.zst", request.package_id, request.version)
    {
        bail!("Agent Package signing request artifact file does not match its identity");
    }
    let payload = decode_signing_payload(request)?;
    let envelope = PackageSignatureEnvelope {
        schema_version: SIGNATURE_SCHEMA_VERSION,
        key_id: request.key_id.clone(),
        publisher: request.publisher.clone(),
        package_id: request.package_id.clone(),
        version: request.version.clone(),
        artifact_sha256: request.artifact_sha256.clone(),
        signature: String::new(),
    };
    if payload != signature_payload(&envelope).into_bytes()
        || sha256_hex(&payload) != request.payload_sha256
    {
        bail!("Agent Package signing request payload does not match its identity");
    }
    Ok(())
}

fn host_skill_plan(
    manifest: &AgentPackageManifest,
    definition: &PackageAuthoringDefinition,
    records: &[PackageFileRecord],
) -> Result<HostSkillPlan> {
    let records = records
        .iter()
        .cloned()
        .map(|record| (record.path.clone(), record))
        .collect::<HashMap<_, _>>();
    let canonical_workflow = records
        .get(&manifest.skills.canonical_workflow)
        .cloned()
        .ok_or_else(|| anyhow!("canonical workflow is absent from authored Package"))?;
    let bundles = definition
        .skill_bundles
        .iter()
        .map(|bundle| {
            let adapter = manifest
                .skills
                .adapters
                .iter()
                .find(|adapter| adapter.host == bundle.host)
                .ok_or_else(|| anyhow!("Host Skill bundle has no Manifest adapter"))?;
            let files = bundle
                .files
                .iter()
                .map(|path| {
                    records
                        .get(path)
                        .cloned()
                        .ok_or_else(|| anyhow!("Host Skill bundle file is absent from Package"))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(HostSkillBundleProjection {
                host: bundle.host,
                entrypoint: adapter.path.clone(),
                files,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(HostSkillPlan {
        schema_version: HOST_SKILL_PLAN_SCHEMA_VERSION,
        package_id: manifest.package_id.clone(),
        agent_id: manifest.agent.agent_id.clone(),
        version: manifest.version.clone(),
        publisher: manifest.publisher.clone(),
        requested_permissions: manifest.requested_permissions.clone(),
        canonical_workflow,
        skill_bundles: bundles,
    })
}

fn file_records(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<PackageFileRecord>> {
    files
        .iter()
        .map(|(path, contents)| {
            Ok(PackageFileRecord {
                path: path.clone(),
                size: u64::try_from(contents.len()).context("Package file size overflow")?,
                sha256: sha256_hex(contents),
            })
        })
        .collect()
}

pub(super) fn deterministic_archive(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let encoder = zstd::stream::write::Encoder::new(Vec::new(), ZSTD_LEVEL)
        .context("create deterministic Agent Package zstd encoder")?;
    let mut archive = tar::Builder::new(encoder);
    for (path, contents) in files {
        let mut header = tar::Header::new_gnu();
        header
            .set_path(path)
            .with_context(|| format!("set Agent Package archive path {path}"))?;
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(
            u64::try_from(contents.len()).context("Agent Package archive file size overflow")?,
        );
        header.set_mode(0o600);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append(&header, contents.as_slice())
            .with_context(|| format!("append Agent Package archive file {path}"))?;
    }
    let encoder = archive
        .into_inner()
        .context("finish Agent Package tar archive")?;
    encoder.finish().context("finish Agent Package zstd frame")
}

fn add_source_file(
    source_root: &Path,
    relative: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    let relative = normalize_authoring_path(relative)?;
    reject_reserved_source_path(&relative)?;
    if files.contains_key(&relative) {
        return Ok(());
    }
    let contents = read_source_file(source_root, &relative)?;
    files.insert(relative, contents);
    Ok(())
}

fn enforce_package_limits(files: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    if files.len() >= MAX_FILE_COUNT {
        bail!("authored Agent Package contains too many source files");
    }
    let total = files.values().try_fold(0_u64, |total, contents| {
        let size = u64::try_from(contents.len()).context("Package source file size overflow")?;
        if size > MAX_FILE_BYTES {
            bail!("authored Agent Package source file exceeds the allowed size");
        }
        total
            .checked_add(size)
            .ok_or_else(|| anyhow!("authored Agent Package size overflow"))
    })?;
    if total > MAX_UNPACKED_BYTES {
        bail!("authored Agent Package source exceeds the unpacked size limit");
    }
    Ok(())
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("inspect {label} directory {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("{label} must be a real directory, not a symlink");
    }
    dunce::canonicalize(path).with_context(|| format!("canonicalize {label} directory"))
}

fn read_definition_file(directory: &Path, name: &str, max_bytes: u64) -> Result<Vec<u8>> {
    let path = directory.join(name);
    read_regular_file(&path, max_bytes)
        .with_context(|| format!("read Agent Package definition file {name}"))
}

fn read_source_file(source_root: &Path, relative: &str) -> Result<Vec<u8>> {
    let relative_path = Path::new(relative);
    let mut current = source_root.to_path_buf();
    let components = relative_path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(component) = component else {
            bail!("Agent Package source path is not normalized");
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .with_context(|| format!("inspect declared Package source {relative}"))?;
        if metadata.file_type().is_symlink() {
            bail!("Agent Package authoring rejects symlinked source paths");
        }
        if index + 1 == components.len() {
            if !metadata.is_file() {
                bail!("declared Agent Package source is not a regular file");
            }
        } else if !metadata.is_dir() {
            bail!("declared Agent Package source parent is not a directory");
        }
    }
    read_regular_file(&current, MAX_FILE_BYTES)
        .with_context(|| format!("read declared Agent Package source {relative}"))
}

fn read_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("inspect file {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("Agent Package authoring input must be a regular file");
    }
    if metadata.len() > max_bytes {
        bail!("Agent Package authoring input exceeds the allowed size");
    }
    let mut file = File::open(path).with_context(|| format!("open file {}", path.display()))?;
    let mut contents = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut contents)
        .with_context(|| format!("read file {}", path.display()))?;
    if contents.len() as u64 > max_bytes {
        bail!("Agent Package authoring input exceeds the allowed size");
    }
    Ok(contents)
}

fn normalize_authoring_path(value: &str) -> Result<String> {
    if value.is_empty() || value.len() > MAX_AUTHORING_PATH_BYTES {
        bail!("Agent Package authoring path size is invalid");
    }
    let normalized = normalized_package_path(Path::new(value))?;
    let normalized = normalized
        .to_str()
        .ok_or_else(|| anyhow!("Agent Package authoring path must be UTF-8"))?;
    if normalized != value {
        bail!("Agent Package authoring path must use normalized separators");
    }
    Ok(normalized.to_owned())
}

fn reject_reserved_source_path(path: &str) -> Result<()> {
    if matches!(
        path,
        PACKAGE_MANIFEST_PATH
            | FILE_MANIFEST_PATH
            | HOST_SKILL_PLAN_PATH
            | AUTHORING_DEFINITION_PATH
    ) {
        bail!("Agent Package authoring source path is reserved");
    }
    Ok(())
}

pub(super) fn validate_output_file_name(value: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > MAX_AUTHORING_PATH_BYTES
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        bail!("Agent Package authoring output file name is invalid");
    }
    Ok(())
}

fn validate_canonical_version(value: &str, label: &str) -> Result<()> {
    let version = Version::parse(value).with_context(|| format!("{label} is invalid"))?;
    if version.to_string() != value {
        bail!("{label} must use canonical SemVer");
    }
    Ok(())
}

fn decode_signing_payload(request: &PackageSigningRequest) -> Result<Vec<u8>> {
    let payload = BASE64
        .decode(&request.payload_base64)
        .context("decode Agent Package signing payload")?;
    if BASE64.encode(&payload) != request.payload_base64 || payload.len() > 4096 {
        bail!("Agent Package signing payload encoding is invalid");
    }
    Ok(payload)
}

fn decode_canonical_base64(field: &str, value: &str, expected_bytes: usize) -> Result<Vec<u8>> {
    let decoded = BASE64
        .decode(value)
        .with_context(|| format!("decode Agent Package {field}"))?;
    if decoded.len() != expected_bytes || BASE64.encode(&decoded) != value {
        bail!("Agent Package {field} encoding or length is invalid");
    }
    Ok(decoded)
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    lower_hex(&Sha256::digest(bytes))
}

pub(super) fn create_new_private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(path)
            .with_context(|| format!("create Agent Package output directory {}", path.display()))?;
        if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("secure Agent Package output directory {}", path.display()))
        {
            let _ = fs::remove_dir(path);
            return Err(error);
        }
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
            .with_context(|| format!("create Agent Package output directory {}", path.display()))?;
    }
    Ok(())
}

pub(super) fn write_new_private_file(path: &Path, contents: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("create Agent Package output {}", path.display()))?;
    let result = (|| {
        file.write_all(contents)
            .with_context(|| format!("write Agent Package output {}", path.display()))?;
        file.sync_all()
            .with_context(|| format!("sync Agent Package output {}", path.display()))
    })();
    if result.is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return result;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("secure Agent Package output {}", path.display()))
        {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::super::package_artifact::PackageArtifactVerifier;
    use super::super::package_trust::{TrustedPublisherKey, TrustedPublisherStore};
    use super::*;

    const JOB_MANIFEST: &str = include_str!("packages/job-agent/agentmesh-agent.toml");
    const TEST_KEY_ID: &str = "agentmesh360-authoring-test";

    #[test]
    fn reproducibly_builds_client_artifact_and_host_skill_projection() {
        let fixture = AuthoringFixture::new();
        let first = build_package(
            fixture.definition.path(),
            fixture.source.path(),
            TEST_KEY_ID,
        )
        .expect("first deterministic build");
        let second = build_package(
            fixture.definition.path(),
            fixture.source.path(),
            TEST_KEY_ID,
        )
        .expect("second deterministic build");
        assert_eq!(first.artifact, second.artifact);
        assert_eq!(first.artifact_sha256, second.artifact_sha256);
        assert_eq!(first.signing_request, second.signing_request);
        assert_eq!(first.host_projection, second.host_projection);

        let projection: serde_json::Value =
            serde_json::from_slice(&first.host_projection).expect("projection");
        let typed_projection: HostSkillProjection =
            serde_json::from_slice(&first.host_projection).expect("typed projection");
        assert_eq!(
            projection["plan"]["packageId"],
            "com.agentmesh360.job-agent"
        );
        assert_eq!(projection["plan"]["agentId"], "job-agent");
        assert_eq!(projection["artifactSha256"], first.artifact_sha256.as_str());
        assert_eq!(
            projection["plan"]["canonicalWorkflow"]["path"],
            "docs/agent-onboarding.md"
        );
        assert_eq!(
            projection["plan"]["skillBundles"].as_array().map(Vec::len),
            Some(2)
        );
        assert_eq!(
            projection["plan"]["skillBundles"][0]["entrypoint"],
            "skills/claude-code/SKILL.md"
        );
        assert_eq!(
            projection["plan"]["skillBundles"][1]["entrypoint"],
            "skills/openclaw-job-agent/SKILL.md"
        );
        let signed_plan =
            serde_json::to_vec(&typed_projection.plan).expect("serialize projection plan");
        assert_eq!(projection["planSha256"], sha256_hex(&signed_plan).as_str());
        let projection_json = String::from_utf8(first.host_projection.clone()).expect("UTF-8");
        for forbidden in [
            "privateKey",
            "accessToken",
            "refreshToken",
            "apiKey",
            fixture.source.path().to_string_lossy().as_ref(),
        ] {
            assert!(!projection_json.contains(forbidden));
        }

        let request: PackageSigningRequest =
            serde_json::from_slice(&first.signing_request).expect("signing request");
        assert_eq!(request.artifact_sha256, first.artifact_sha256);
        assert_eq!(
            BASE64
                .decode(&request.payload_base64)
                .expect("signing payload"),
            signature_payload(&PackageSignatureEnvelope {
                schema_version: SIGNATURE_SCHEMA_VERSION,
                key_id: TEST_KEY_ID.into(),
                publisher: "agentmesh360".into(),
                package_id: "com.agentmesh360.job-agent".into(),
                version: "0.5.6".into(),
                artifact_sha256: first.artifact_sha256.clone(),
                signature: String::new(),
            })
            .into_bytes()
        );
    }

    #[test]
    fn finalized_external_signature_verifies_with_the_runtime_artifact_gate() {
        let fixture = AuthoringFixture::new();
        let build = build_package(
            fixture.definition.path(),
            fixture.source.path(),
            TEST_KEY_ID,
        )
        .expect("build");
        let output = fixture.definition.path().join("output");
        let receipt = build
            .write_to_new_directory(&output)
            .expect("write build outputs");
        let signing_key = SigningKey::from_bytes(&[29_u8; 32]);
        let (signature_path, public_key_path) =
            external_signature_documents(&receipt.signing_request_path, &signing_key);
        let envelope_path = fixture.definition.path().join("job-agent.signature.json");
        let finalized = finalize_external_signature(
            &receipt.signing_request_path,
            &receipt.artifact_path,
            &signature_path,
            &public_key_path,
            &envelope_path,
        )
        .expect("finalize external signature");
        assert_eq!(finalized.package_id, "com.agentmesh360.job-agent");
        assert_eq!(finalized.key_id, TEST_KEY_ID);

        let envelope = fs::read_to_string(&envelope_path).expect("read envelope");
        let trust = TrustedPublisherStore::with_key(TrustedPublisherKey {
            key_id: TEST_KEY_ID.into(),
            publisher: "agentmesh360".into(),
            public_key: signing_key.verifying_key().to_bytes(),
        });
        let verified = PackageArtifactVerifier::with_trust_store(fixture.definition.path(), trust)
            .verify_to_staging(&receipt.artifact_path, &envelope)
            .expect("runtime verifies authored Package");
        assert_eq!(verified.manifest.package_id, receipt.package_id);
        assert_eq!(verified.manifest.version, receipt.version);
    }

    #[test]
    fn strict_definition_and_source_boundary_fail_closed() {
        let fixture = AuthoringFixture::new();
        let definition_path = fixture.definition.path().join(AUTHORING_DEFINITION_PATH);

        fs::write(
            &definition_path,
            fixture.definition_document().replace(
                "files = [\"skills/claude-code/README.md\", \"skills/claude-code/SKILL.md\"]",
                "files = [\"skills/claude-code/README.md\"]",
            ),
        )
        .expect("omit entrypoint");
        assert!(
            build_package(
                fixture.definition.path(),
                fixture.source.path(),
                TEST_KEY_ID
            )
            .expect_err("missing adapter entrypoint")
            .to_string()
            .contains("omits")
        );

        fs::write(
            &definition_path,
            fixture
                .definition_document()
                .replace("schemaVersion = 1", "schemaVersion = 2"),
        )
        .expect("future schema");
        assert!(
            build_package(
                fixture.definition.path(),
                fixture.source.path(),
                TEST_KEY_ID
            )
            .expect_err("future schema")
            .to_string()
            .contains("unsupported")
        );

        fs::write(
            &definition_path,
            fixture
                .definition_document()
                .replace("packageFiles = []", "packageFiles = [\"../outside\"]"),
        )
        .expect("path traversal");
        assert!(
            build_package(
                fixture.definition.path(),
                fixture.source.path(),
                TEST_KEY_ID
            )
            .is_err()
        );

        fs::write(&definition_path, fixture.definition_document()).expect("restore definition");
        let manifest_path = fixture.definition.path().join(PACKAGE_MANIFEST_PATH);
        fs::write(
            &manifest_path,
            JOB_MANIFEST.replace("\"network_access\"", "\"undeclared_root_shell\""),
        )
        .expect("unknown permission");
        assert!(
            build_package(
                fixture.definition.path(),
                fixture.source.path(),
                TEST_KEY_ID
            )
            .is_err()
        );
        fs::write(&manifest_path, JOB_MANIFEST).expect("restore Manifest");

        fs::write(
            fixture.source.path().join("unlisted-secret.txt"),
            b"do not package",
        )
        .expect("unlisted source");
        let with_unlisted = build_package(
            fixture.definition.path(),
            fixture.source.path(),
            TEST_KEY_ID,
        )
        .expect("build ignores unlisted source");
        fs::remove_file(fixture.source.path().join("unlisted-secret.txt"))
            .expect("remove unlisted source");
        let without_unlisted = build_package(
            fixture.definition.path(),
            fixture.source.path(),
            TEST_KEY_ID,
        )
        .expect("build without unlisted source");
        assert_eq!(with_unlisted.artifact, without_unlisted.artifact);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_or_oversized_declared_source_is_rejected() {
        use std::os::unix::fs::symlink;

        let fixture = AuthoringFixture::new();
        let entrypoint = fixture
            .source
            .path()
            .join("skills/openclaw-job-agent/SKILL.md");
        fs::remove_file(&entrypoint).expect("remove entrypoint");
        symlink("/etc/hosts", &entrypoint).expect("create source symlink");
        assert!(
            build_package(
                fixture.definition.path(),
                fixture.source.path(),
                TEST_KEY_ID
            )
            .expect_err("source symlink")
            .to_string()
            .contains("symlink")
        );

        fs::remove_file(&entrypoint).expect("remove source symlink");
        let oversized = File::create(&entrypoint).expect("create oversized source");
        oversized
            .set_len(MAX_FILE_BYTES + 1)
            .expect("set sparse source length");
        let error = build_package(
            fixture.definition.path(),
            fixture.source.path(),
            TEST_KEY_ID,
        )
        .expect_err("oversized source");
        assert!(format!("{error:#}").contains("exceeds"));
    }

    #[test]
    fn finalize_rejects_tampered_request_wrong_key_and_invalid_signature() {
        let fixture = AuthoringFixture::new();
        let build = build_package(
            fixture.definition.path(),
            fixture.source.path(),
            TEST_KEY_ID,
        )
        .expect("build");
        let output = fixture.definition.path().join("output");
        let receipt = build.write_to_new_directory(&output).expect("write build");
        let signing_key = SigningKey::from_bytes(&[29_u8; 32]);
        let (signature_path, public_key_path) =
            external_signature_documents(&receipt.signing_request_path, &signing_key);

        let tampered_artifact_dir = fixture.definition.path().join("tampered-artifact");
        fs::create_dir(&tampered_artifact_dir).expect("tampered artifact directory");
        let tampered_artifact = tampered_artifact_dir.join(
            receipt
                .artifact_path
                .file_name()
                .expect("artifact file name"),
        );
        let mut tampered_artifact_bytes =
            fs::read(&receipt.artifact_path).expect("read artifact for tampering");
        tampered_artifact_bytes[0] ^= 0xff;
        fs::write(&tampered_artifact, tampered_artifact_bytes).expect("write tampered artifact");
        assert!(
            finalize_external_signature(
                &receipt.signing_request_path,
                &tampered_artifact,
                &signature_path,
                &public_key_path,
                &fixture
                    .definition
                    .path()
                    .join("tampered-artifact-envelope.json"),
            )
            .expect_err("tampered artifact")
            .to_string()
            .contains("digest")
        );

        let mut tampered: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt.signing_request_path).expect("request"))
                .expect("request json");
        tampered["artifactSha256"] = serde_json::Value::String("0".repeat(64));
        let tampered_request = fixture.definition.path().join("tampered-request.json");
        fs::write(
            &tampered_request,
            serde_json::to_vec(&tampered).expect("tampered request"),
        )
        .expect("write tampered request");
        assert!(
            finalize_external_signature(
                &tampered_request,
                &receipt.artifact_path,
                &signature_path,
                &public_key_path,
                &fixture.definition.path().join("tampered-envelope.json"),
            )
            .is_err()
        );

        let wrong_key = SigningKey::from_bytes(&[30_u8; 32]);
        let wrong_key_path = fixture.definition.path().join("wrong-public-key.json");
        fs::write(
            &wrong_key_path,
            serde_json::to_vec(&PublisherPublicKeyDocument {
                schema_version: PUBLIC_KEY_SCHEMA_VERSION,
                algorithm: SigningAlgorithm::Ed25519,
                key_id: TEST_KEY_ID.into(),
                public_key: BASE64.encode(wrong_key.verifying_key().to_bytes()),
            })
            .expect("wrong public key"),
        )
        .expect("write wrong public key");
        assert!(
            finalize_external_signature(
                &receipt.signing_request_path,
                &receipt.artifact_path,
                &signature_path,
                &wrong_key_path,
                &fixture.definition.path().join("wrong-key-envelope.json"),
            )
            .expect_err("wrong public key")
            .to_string()
            .contains("verify")
        );

        let mut signature_result: PackageSignatureResult =
            serde_json::from_slice(&fs::read(&signature_path).expect("signature"))
                .expect("signature result");
        signature_result.signature = BASE64.encode([0_u8; 64]);
        let invalid_signature = fixture.definition.path().join("invalid-signature.json");
        fs::write(
            &invalid_signature,
            serde_json::to_vec(&signature_result).expect("invalid signature"),
        )
        .expect("write invalid signature");
        assert!(
            finalize_external_signature(
                &receipt.signing_request_path,
                &receipt.artifact_path,
                &invalid_signature,
                &public_key_path,
                &fixture.definition.path().join("invalid-envelope.json"),
            )
            .is_err()
        );
    }

    #[test]
    fn first_party_authoring_definitions_match_their_manifests() {
        for (manifest, definition) in [
            (
                include_str!("packages/job-agent/agentmesh-agent.toml"),
                include_str!("packages/job-agent/agentmesh-authoring.toml"),
            ),
            (
                include_str!("packages/lecturecast-agent/agentmesh-agent.toml"),
                include_str!("packages/lecturecast-agent/agentmesh-authoring.toml"),
            ),
            (
                include_str!("packages/deploy-agent/agentmesh-agent.toml"),
                include_str!("packages/deploy-agent/agentmesh-authoring.toml"),
            ),
        ] {
            let manifest =
                AgentPackageCatalog::parse_document(manifest).expect("first-party Manifest");
            let definition: PackageAuthoringDefinition =
                toml::from_str(definition).expect("first-party authoring definition");
            validate_definition(&definition, &manifest)
                .expect("first-party authoring definition matches Manifest");
        }
    }

    fn external_signature_documents(
        request_path: &Path,
        signing_key: &SigningKey,
    ) -> (PathBuf, PathBuf) {
        let request: PackageSigningRequest =
            serde_json::from_slice(&fs::read(request_path).expect("read request"))
                .expect("request");
        let payload = BASE64
            .decode(&request.payload_base64)
            .expect("decode payload");
        let signature = signing_key.sign(&payload);
        let parent = request_path.parent().expect("request parent");
        let signature_path = parent.join("signature-result.json");
        fs::write(
            &signature_path,
            serde_json::to_vec(&PackageSignatureResult {
                schema_version: SIGNATURE_RESULT_SCHEMA_VERSION,
                algorithm: SigningAlgorithm::Ed25519,
                key_id: TEST_KEY_ID.into(),
                signature: BASE64.encode(signature.to_bytes()),
            })
            .expect("signature result"),
        )
        .expect("write signature result");
        let public_key_path = parent.join("publisher-public-key.json");
        fs::write(
            &public_key_path,
            serde_json::to_vec(&PublisherPublicKeyDocument {
                schema_version: PUBLIC_KEY_SCHEMA_VERSION,
                algorithm: SigningAlgorithm::Ed25519,
                key_id: TEST_KEY_ID.into(),
                public_key: BASE64.encode(signing_key.verifying_key().to_bytes()),
            })
            .expect("public key"),
        )
        .expect("write public key");
        (signature_path, public_key_path)
    }

    struct AuthoringFixture {
        definition: tempfile::TempDir,
        source: tempfile::TempDir,
    }

    impl AuthoringFixture {
        fn new() -> Self {
            let fixture = Self {
                definition: tempfile::tempdir().expect("definition"),
                source: tempfile::tempdir().expect("source"),
            };
            fs::write(
                fixture.definition.path().join(PACKAGE_MANIFEST_PATH),
                JOB_MANIFEST,
            )
            .expect("write Manifest");
            fs::write(
                fixture.definition.path().join(AUTHORING_DEFINITION_PATH),
                fixture.definition_document(),
            )
            .expect("write authoring definition");
            for (path, contents) in [
                ("docs/agent-onboarding.md", "# Canonical workflow\n"),
                ("skills/claude-code/README.md", "# Claude adapter README\n"),
                ("skills/claude-code/SKILL.md", "# Claude Code Job Agent\n"),
                (
                    "skills/openclaw-job-agent/SKILL.md",
                    "# OpenClaw Job Agent\n",
                ),
            ] {
                let destination = fixture.source.path().join(path);
                fs::create_dir_all(destination.parent().expect("source parent"))
                    .expect("create source parent");
                fs::write(destination, contents).expect("write source");
            }
            fixture
        }

        fn definition_document(&self) -> String {
            r#"schemaVersion = 1
packageFiles = []

[[skillBundles]]
host = "claude-code"
files = ["skills/claude-code/README.md", "skills/claude-code/SKILL.md"]

[[skillBundles]]
host = "openclaw"
files = ["skills/openclaw-job-agent/SKILL.md"]
"#
            .into()
        }
    }
}
