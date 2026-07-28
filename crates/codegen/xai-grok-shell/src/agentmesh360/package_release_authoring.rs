//! Offline Release assembly after an external Publisher has signed a Package.
//!
//! The public CLI wrapper never receives private key material. It re-verifies
//! the external signature, verifies the Artifact through H1 with an ephemeral
//! in-memory public-key store, exports H2d1 Host bundles, assembles the H2d2
//! Release Manifest, and binds an unpublished H2d3 Registry record.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use url::Url;

use super::package_artifact::{
    FILE_MANIFEST_PATH, MAX_FILE_BYTES, PackageArtifactVerifier, PackageSignatureEnvelope,
};
use super::package_authoring::{
    create_new_private_directory, finalize_external_signature, sha256_hex,
    validate_output_file_name, write_new_private_file,
};
use super::package_registry_snapshot::{
    HostBundleLocation, ReleaseChannelLocations, bind_verified_release_record,
};
use super::package_release::assemble_agent_release;
use super::package_skill_export::{export_verified_host_skills, read_bounded_regular_file};
use super::package_trust::{TrustedPublisherKey, TrustedPublisherStore};

const RELEASE_ASSEMBLY_RECEIPT_SCHEMA_VERSION: u32 = 1;
const PUBLIC_KEY_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfflinePublisherPublicKey {
    schema_version: u32,
    algorithm: String,
    key_id: String,
    public_key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseOutputDigest {
    pub file_name: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseHostBundleDigest {
    pub host: String,
    pub entrypoint: String,
    pub file_name: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAssemblyReceipt {
    pub schema_version: u32,
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub publisher: String,
    pub key_id: String,
    pub envelope: ReleaseOutputDigest,
    pub package_file_manifest: ReleaseOutputDigest,
    pub host_bundles: Vec<ReleaseHostBundleDigest>,
    pub release_manifest: ReleaseOutputDigest,
    pub registry_record: ReleaseOutputDigest,
    pub client_projection_sha256: String,
    pub host_projection_sha256: String,
    pub receipt_file_name: String,
}

#[allow(clippy::too_many_arguments)]
pub fn assemble_offline_release(
    request_path: &Path,
    artifact_path: &Path,
    signature_result_path: &Path,
    public_key_path: &Path,
    host_projection_path: &Path,
    output_dir: &Path,
    release_base_url: &str,
) -> Result<ReleaseAssemblyReceipt> {
    let release_base_url = validate_release_base_url(release_base_url)?;
    create_new_private_directory(output_dir)?;
    let result = assemble_offline_release_in_directory(
        request_path,
        artifact_path,
        signature_result_path,
        public_key_path,
        host_projection_path,
        output_dir,
        &release_base_url,
    );
    if result.is_err() {
        let _ = fs::remove_dir_all(output_dir);
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn assemble_offline_release_in_directory(
    request_path: &Path,
    artifact_path: &Path,
    signature_result_path: &Path,
    public_key_path: &Path,
    host_projection_path: &Path,
    output_dir: &Path,
    release_base_url: &str,
) -> Result<ReleaseAssemblyReceipt> {
    let public_key = read_offline_public_key(public_key_path)?;
    let envelope_file_name = artifact_identity_file_name(artifact_path, "signature.v1.json")?;
    let envelope_path = output_dir.join(&envelope_file_name);
    let finalize = finalize_external_signature(
        request_path,
        artifact_path,
        signature_result_path,
        public_key_path,
        &envelope_path,
    )
    .context("finalize externally signed Agent Package")?;
    let envelope_document = read_bounded_regular_file(&envelope_path, MAX_FILE_BYTES)
        .context("read finalized Agent Package Envelope")?;
    let envelope: PackageSignatureEnvelope = serde_json::from_slice(&envelope_document)
        .context("parse finalized Agent Package Envelope")?;
    if public_key.key_id != finalize.key_id || public_key.key_id != envelope.key_id {
        bail!("offline Publisher public key differs from the finalized Envelope");
    }

    let verification_state = output_dir.join(".verification-state");
    let trust_store = TrustedPublisherStore::for_offline_authoring(TrustedPublisherKey {
        key_id: public_key.key_id.clone(),
        publisher: envelope.publisher.clone(),
        public_key: public_key.public_key,
    });
    let verified = PackageArtifactVerifier::with_trust_store(&verification_state, trust_store)
        .verify_to_staging(
            artifact_path,
            std::str::from_utf8(&envelope_document)
                .context("Agent Package Envelope must be UTF-8")?,
        )
        .context("H1 verify externally signed Agent Package")?;

    let projection_document = read_bounded_regular_file(host_projection_path, MAX_FILE_BYTES)
        .context("read authored Host projection")?;
    let host_exports = export_verified_host_skills(&verified, &projection_document)
        .context("H2d1 export verified Host Skills")?
        .write_to_new_directory(&output_dir.join("host-bundles"))
        .context("write H2d1 Host Skill bundles")?;

    let file_manifest_file_name = format!(
        "{}-{}.package-files.v1.json",
        verified.manifest.package_id, verified.manifest.version
    );
    validate_output_file_name(&file_manifest_file_name)?;
    let file_manifest_document = read_bounded_regular_file(
        &verified.staging_path().join(FILE_MANIFEST_PATH),
        MAX_FILE_BYTES,
    )
    .context("read H1-verified Package file manifest")?;
    if sha256_hex(&file_manifest_document) != verified.file_manifest_sha256 {
        bail!("H1-verified Package file manifest digest changed");
    }
    write_new_private_file(
        &output_dir.join(&file_manifest_file_name),
        &file_manifest_document,
    )?;

    let release_build = assemble_agent_release(
        &verified,
        &envelope_document,
        &projection_document,
        &host_exports,
    )
    .context("H2d2 assemble Agent Release")?;
    let release_descriptor = release_build
        .verified_descriptor()
        .context("verify assembled Agent Release descriptor")?;
    let locations = ReleaseChannelLocations {
        release_manifest_url: release_url(release_base_url, &release_descriptor.release_file_name),
        artifact_url: release_url(release_base_url, &release_descriptor.artifact_file_name),
        envelope_url: release_url(release_base_url, &release_descriptor.envelope_file_name),
        host_projection_url: release_url(
            release_base_url,
            &release_descriptor.host_projection_file_name,
        ),
        host_bundles: release_descriptor
            .host_bundles
            .iter()
            .map(|bundle| HostBundleLocation {
                host: bundle.host,
                bundle_url: release_url(release_base_url, &bundle.file_name),
            })
            .collect(),
    };
    let registry_record = bind_verified_release_record(&release_build, locations)
        .context("H2d3 bind unpublished Agent Release Registry record")?;
    registry_record
        .client_projection()
        .verify_release_document(release_build.document())
        .context("cross-check Client Release projection")?;
    registry_record
        .host_projection()
        .verify_release_document(release_build.document())
        .context("cross-check Host Release projection")?;

    let client_projection_document = serde_json::to_vec(&registry_record.client_projection())
        .context("serialize Client Release projection")?;
    let registry_host_projection_document = serde_json::to_vec(&registry_record.host_projection())
        .context("serialize Host Release projection")?;
    let registry_document =
        serde_json::to_vec(&registry_record).context("serialize Registry record")?;
    let registry_file_name = format!(
        "{}-{}.registry-record.v2.json",
        registry_record.package_id, registry_record.version
    );
    validate_output_file_name(&registry_file_name)?;
    write_new_private_file(&output_dir.join(&registry_file_name), &registry_document)?;

    let release_document = release_build.document().to_vec();
    let release = release_build
        .write_to_new_directory(&output_dir.join("release-manifest"))
        .context("write H2d2 Agent Release Manifest")?;
    if sha256_hex(&release_document) != release.manifest_sha256 {
        bail!("written Agent Release Manifest digest changed");
    }

    let host_bundle_digests = host_exports
        .bundles()
        .iter()
        .map(|bundle| {
            let file_name = bundle
                .bundle_path()
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| anyhow!("Host bundle file name is invalid"))?;
            Ok(ReleaseHostBundleDigest {
                host: bundle.host().as_str().to_owned(),
                entrypoint: bundle.entrypoint().to_owned(),
                file_name: file_name.to_owned(),
                sha256: bundle.bundle_sha256().to_owned(),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let receipt_file_name = format!(
        "{}-{}.finalize-receipt.v1.json",
        registry_record.package_id, registry_record.version
    );
    validate_output_file_name(&receipt_file_name)?;
    let receipt = ReleaseAssemblyReceipt {
        schema_version: RELEASE_ASSEMBLY_RECEIPT_SCHEMA_VERSION,
        package_id: registry_record.package_id,
        agent_id: registry_record.agent_id,
        version: registry_record.version,
        publisher: registry_record.publisher,
        key_id: finalize.key_id,
        envelope: ReleaseOutputDigest {
            file_name: envelope_file_name,
            sha256: finalize.envelope_sha256,
        },
        package_file_manifest: ReleaseOutputDigest {
            file_name: file_manifest_file_name,
            sha256: verified.file_manifest_sha256.clone(),
        },
        host_bundles: host_bundle_digests,
        release_manifest: ReleaseOutputDigest {
            file_name: release
                .manifest_path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| anyhow!("Release Manifest file name is invalid"))?
                .to_owned(),
            sha256: release.manifest_sha256,
        },
        registry_record: ReleaseOutputDigest {
            file_name: registry_file_name,
            sha256: sha256_hex(&registry_document),
        },
        client_projection_sha256: sha256_hex(&client_projection_document),
        host_projection_sha256: sha256_hex(&registry_host_projection_document),
        receipt_file_name: receipt_file_name.clone(),
    };
    let receipt_document =
        serde_json::to_vec(&receipt).context("serialize Release assembly receipt")?;
    write_new_private_file(&output_dir.join(&receipt_file_name), &receipt_document)?;

    drop(verified);
    fs::remove_dir_all(&verification_state)
        .context("remove offline authoring verification state")?;
    Ok(receipt)
}

fn read_offline_public_key(path: &Path) -> Result<ValidatedOfflinePublisherKey> {
    let document = read_bounded_regular_file(path, MAX_FILE_BYTES)
        .context("read offline Publisher public key")?;
    let public_key: OfflinePublisherPublicKey =
        serde_json::from_slice(&document).context("parse offline Publisher public key")?;
    if public_key.schema_version != PUBLIC_KEY_SCHEMA_VERSION || public_key.algorithm != "ed25519" {
        bail!("offline Publisher public key schema or algorithm is invalid");
    }
    let bytes = BASE64
        .decode(&public_key.public_key)
        .context("decode offline Publisher public key")?;
    if bytes.len() != 32 || BASE64.encode(&bytes) != public_key.public_key {
        bail!("offline Publisher public key is not canonical Ed25519 bytes");
    }
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow!("offline Publisher public key length is invalid"))?;
    VerifyingKey::from_bytes(&bytes).context("validate offline Publisher Ed25519 public key")?;
    Ok(ValidatedOfflinePublisherKey {
        key_id: public_key.key_id,
        public_key: bytes,
    })
}

struct ValidatedOfflinePublisherKey {
    key_id: String,
    public_key: [u8; 32],
}

fn validate_release_base_url(value: &str) -> Result<String> {
    let parsed = Url::parse(value).context("parse offline Release base URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        bail!("offline Release base URL is not an allowed HTTPS origin path");
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn release_url(base: &str, file_name: &str) -> String {
    format!("{base}/{file_name}")
}

fn artifact_identity_file_name(artifact_path: &Path, suffix: &str) -> Result<String> {
    let artifact = artifact_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("Agent Package artifact file name is invalid"))?;
    let stem = artifact
        .strip_suffix(".ampkg.tar.zst")
        .ok_or_else(|| anyhow!("Agent Package artifact suffix is invalid"))?;
    let file_name = format!("{stem}.{suffix}");
    validate_output_file_name(&file_name)?;
    Ok(file_name)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use base64::engine::general_purpose::STANDARD as BASE64;
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::Value;
    use tempfile::TempDir;
    use walkdir::WalkDir;

    use super::super::package_authoring::build_package;
    use super::*;

    const TEST_KEY_ID: &str = "release-authoring-test";

    #[test]
    fn assembles_deterministic_release_outputs_without_private_key_input() {
        let fixture = fixture_root();
        let root = tempfile::tempdir().expect("release authoring temp");
        let first = build_and_sign(&fixture, &root, "first");
        let second = build_and_sign(&fixture, &root, "second");

        let first_receipt = assemble_offline_release(
            &first.request,
            &first.artifact,
            &first.signature_result,
            &first.public_key,
            &first.projection,
            &root.path().join("release-first"),
            "https://packages.agentmesh360.invalid/e0/future-agent/1.0.0",
        )
        .expect("first Release assembly");
        let second_receipt = assemble_offline_release(
            &second.request,
            &second.artifact,
            &second.signature_result,
            &second.public_key,
            &second.projection,
            &root.path().join("release-second"),
            "https://packages.agentmesh360.invalid/e0/future-agent/1.0.0",
        )
        .expect("second Release assembly");

        assert_eq!(first_receipt, second_receipt);
        assert_eq!(first_receipt.agent_id, "future-agent");
        assert_eq!(first_receipt.host_bundles.len(), 2);
        assert_eq!(
            directory_files(&root.path().join("release-first")),
            directory_files(&root.path().join("release-second"))
        );
        assert!(
            !root
                .path()
                .join("release-first/.verification-state")
                .exists()
        );
    }

    #[test]
    fn removes_partial_output_after_signature_or_url_failure() {
        let fixture = fixture_root();
        let root = tempfile::tempdir().expect("release authoring temp");
        let signed = build_and_sign(&fixture, &root, "invalid");
        let invalid_signature = root.path().join("invalid-signature.json");
        fs::write(
            &invalid_signature,
            br#"{"schemaVersion":1,"algorithm":"ed25519","keyId":"release-authoring-test","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}"#,
        )
        .expect("write invalid signature");
        let output = root.path().join("invalid-release");
        assert!(
            assemble_offline_release(
                &signed.request,
                &signed.artifact,
                &invalid_signature,
                &signed.public_key,
                &signed.projection,
                &output,
                "https://packages.agentmesh360.invalid/e0/future-agent/1.0.0",
            )
            .is_err()
        );
        assert!(!output.exists());

        let url_output = root.path().join("invalid-url-release");
        assert!(
            assemble_offline_release(
                &signed.request,
                &signed.artifact,
                &signed.signature_result,
                &signed.public_key,
                &signed.projection,
                &url_output,
                "http://packages.agentmesh360.invalid/e0",
            )
            .is_err()
        );
        assert!(!url_output.exists());
    }

    struct SignedBuild {
        request: PathBuf,
        artifact: PathBuf,
        signature_result: PathBuf,
        public_key: PathBuf,
        projection: PathBuf,
    }

    fn build_and_sign(fixture: &Path, root: &TempDir, label: &str) -> SignedBuild {
        let build = build_package(fixture, fixture, TEST_KEY_ID)
            .expect("build fixture")
            .write_to_new_directory(&root.path().join(format!("build-{label}")))
            .expect("write fixture build");
        let signing_key = SigningKey::from_bytes(&[71_u8; 32]);
        let request: Value = serde_json::from_slice(
            &fs::read(&build.signing_request_path).expect("read signing request"),
        )
        .expect("parse signing request");
        let payload = BASE64
            .decode(request["payloadBase64"].as_str().expect("payloadBase64"))
            .expect("decode signing payload");
        let signature_result = root.path().join(format!("{label}-signature-result.json"));
        fs::write(
            &signature_result,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "algorithm": "ed25519",
                "keyId": TEST_KEY_ID,
                "signature": BASE64.encode(signing_key.sign(&payload).to_bytes()),
            }))
            .expect("serialize signature result"),
        )
        .expect("write signature result");
        let public_key = root.path().join(format!("{label}-public-key.json"));
        fs::write(
            &public_key,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "algorithm": "ed25519",
                "keyId": TEST_KEY_ID,
                "publicKey": BASE64.encode(signing_key.verifying_key().to_bytes()),
            }))
            .expect("serialize public key"),
        )
        .expect("write public key");
        SignedBuild {
            request: build.signing_request_path,
            artifact: build.artifact_path,
            signature_result,
            public_key,
            projection: build.host_projection_path,
        }
    }

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/release-provenance/future-agent")
    }

    fn directory_files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        WalkDir::new(root)
            .into_iter()
            .map(|entry| entry.expect("walk release output"))
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .expect("relative release output")
                    .to_path_buf();
                let bytes = fs::read(entry.path()).expect("read release output");
                (relative, bytes)
            })
            .collect()
    }
}
