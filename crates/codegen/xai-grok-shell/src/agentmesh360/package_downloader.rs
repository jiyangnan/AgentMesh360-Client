use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::StreamExt as _;
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE};
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncWriteExt as _;
use url::Url;
use uuid::Uuid;

use super::access::ClientAccess;
use super::package_artifact::{PackageArtifactVerifier, VerifiedStagedPackage};
use super::package_canary;
use super::package_registry_fetcher::{PRODUCTION_PACKAGE_ORIGIN, validate_endpoint};
use super::package_release::MAX_RELEASE_MANIFEST_BYTES;
use super::package_trust_cache::PackageTrustCacheStore;

#[cfg(test)]
use super::package_trust::TrustedRootStore;

const ENVELOPE_LIMIT: usize = 64 * 1024;
const ARTIFACT_LIMIT: usize = 32 * 1024 * 1024;

pub(crate) struct PackageArtifactDownloader {
    state_home: PathBuf,
    cache: PackageTrustCacheStore,
    client: reqwest::Client,
    allowed_origin: String,
    canary_transport_override: Option<Url>,
    #[cfg(test)]
    transport_origin_override: Option<Url>,
}

impl PackageArtifactDownloader {
    pub(crate) fn in_home(state_home: impl Into<PathBuf>) -> Self {
        let state_home = state_home.into();
        if let Some(canary) = package_canary::load(&state_home) {
            return Self {
                cache: PackageTrustCacheStore::in_home_with_roots(&state_home, canary.roots),
                state_home,
                client: download_client(canary.default_headers),
                allowed_origin: canary.allowed_origin,
                canary_transport_override: canary.download_transport_override,
                #[cfg(test)]
                transport_origin_override: None,
            };
        }
        Self {
            cache: PackageTrustCacheStore::in_home(&state_home),
            state_home,
            client: download_client(reqwest::header::HeaderMap::new()),
            allowed_origin: PRODUCTION_PACKAGE_ORIGIN.into(),
            canary_transport_override: None,
            #[cfg(test)]
            transport_origin_override: None,
        }
    }

    #[cfg(test)]
    pub(super) fn for_test(
        state_home: impl Into<PathBuf>,
        roots: TrustedRootStore,
        transport_origin_override: Url,
    ) -> Self {
        let state_home = state_home.into();
        Self {
            cache: PackageTrustCacheStore::in_home_with_roots(&state_home, roots),
            state_home,
            client: download_client(reqwest::header::HeaderMap::new()),
            allowed_origin: PRODUCTION_PACKAGE_ORIGIN.into(),
            canary_transport_override: None,
            transport_origin_override: Some(transport_origin_override),
        }
    }

    pub(crate) async fn download_verified(
        &self,
        package_id: &str,
        access: &ClientAccess,
    ) -> Result<VerifiedPackageDownload> {
        let remote = self
            .cache
            .load_verified_package(package_id, access)?
            .ok_or_else(|| anyhow!("verified remote Agent Package is unavailable"))?;
        let client_release = remote.record.client_projection();
        let release_manifest_url =
            self.validate_download_url(&client_release.release_manifest.url)?;
        let artifact_url = self.validate_download_url(&client_release.artifact_url)?;
        let envelope_url = self.validate_download_url(&client_release.envelope_url)?;
        let operation = DownloadOperation::create(&self.state_home)?;
        let release_manifest_path = operation.path().join("agent-release.json");
        let envelope_path = operation.path().join("envelope.json");
        let artifact_path = operation.path().join("artifact.tar.zst");

        let release_manifest = download_to_private_file(
            &self.client,
            &self.request_url(&release_manifest_url),
            &release_manifest_path,
            MAX_RELEASE_MANIFEST_BYTES,
            DownloadContentKind::ReleaseManifest,
        )
        .await?;
        if release_manifest.sha256 != client_release.release_manifest.sha256 {
            bail!("Agent Release Manifest digest does not match verified registry");
        }
        let verified_release = client_release
            .verify_release_document(&release_manifest.bytes)
            .context("cross-check Agent Release Manifest with verified Client projection")?;

        let envelope = download_to_private_file(
            &self.client,
            &self.request_url(&envelope_url),
            &envelope_path,
            ENVELOPE_LIMIT,
            DownloadContentKind::Envelope,
        )
        .await?;
        if envelope.sha256 != client_release.envelope_sha256 {
            bail!("Agent Package envelope digest does not match verified registry");
        }
        let envelope_document =
            String::from_utf8(envelope.bytes).context("Agent Package envelope must be UTF-8")?;

        let artifact = download_to_private_file(
            &self.client,
            &self.request_url(&artifact_url),
            &artifact_path,
            ARTIFACT_LIMIT,
            DownloadContentKind::Artifact,
        )
        .await?;
        if artifact.sha256 != client_release.artifact_sha256 {
            bail!("Agent Package artifact digest does not match verified registry");
        }

        let verified =
            PackageArtifactVerifier::with_trust_store(&self.state_home, remote.trusted_publishers)
                .verify_to_staging(&artifact_path, &envelope_document)?;
        if verified.artifact_sha256 != verified_release.artifact_sha256
            || verified.envelope_sha256 != verified_release.envelope_sha256
            || verified.file_manifest_sha256 != verified_release.artifact_file_manifest_sha256
            || verified.signature_key_id != verified_release.envelope_signature_key_id
        {
            bail!("downloaded Agent Package verification differs from the Agent Release Manifest");
        }
        if verified.manifest.package_id != client_release.package_id
            || verified.manifest.agent.agent_id != client_release.agent_id
            || verified.manifest.version != client_release.version
            || verified.manifest.publisher != client_release.publisher
        {
            bail!("downloaded Agent Package identity does not match verified registry");
        }
        let audit = PackageDownloadAudit {
            package_id: client_release.package_id,
            agent_id: client_release.agent_id,
            version: client_release.version,
            artifact_bytes: artifact.size,
            envelope_bytes: envelope.size,
        };
        Ok(VerifiedPackageDownload { audit, verified })
    }

    fn validate_download_url(&self, value: &str) -> Result<Url> {
        let url = Url::parse(value).context("parse verified Agent Package URL")?;
        validate_endpoint(&url, false)
            .map_err(|()| anyhow!("verified Agent Package URL is unsafe"))?;
        if url.origin().ascii_serialization() != self.allowed_origin {
            bail!("verified Agent Package URL origin is not allowed");
        }
        Ok(url)
    }

    fn request_url(&self, verified_url: &Url) -> Url {
        if let Some(url) = &self.canary_transport_override {
            return url.clone();
        }
        #[cfg(test)]
        if let Some(origin) = &self.transport_origin_override {
            let mut request_url = origin.clone();
            request_url.set_path(verified_url.path());
            return request_url;
        }
        verified_url.clone()
    }
}

fn download_client(default_headers: reqwest::header::HeaderMap) -> reqwest::Client {
    reqwest::Client::builder()
        .default_headers(default_headers)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("Agent Package download HTTP client configuration is valid")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageDownloadAudit {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub artifact_bytes: usize,
    pub envelope_bytes: usize,
}

#[derive(Debug)]
pub(crate) struct VerifiedPackageDownload {
    pub audit: PackageDownloadAudit,
    verified: VerifiedStagedPackage,
}

impl VerifiedPackageDownload {
    pub(super) fn staged(&self) -> &VerifiedStagedPackage {
        &self.verified
    }

    pub(super) fn into_staged(self) -> VerifiedStagedPackage {
        self.verified
    }

    #[cfg(test)]
    pub(super) fn for_test(verified: VerifiedStagedPackage) -> Self {
        let audit = PackageDownloadAudit {
            package_id: verified.manifest.package_id.clone(),
            agent_id: verified.manifest.agent.agent_id.clone(),
            version: verified.manifest.version.clone(),
            artifact_bytes: 1,
            envelope_bytes: 1,
        };
        Self { audit, verified }
    }
}

#[derive(Clone, Copy)]
enum DownloadContentKind {
    ReleaseManifest,
    Envelope,
    Artifact,
}

impl DownloadContentKind {
    fn accepts(self, value: &str) -> bool {
        let Some(mime) = value.split(';').next().map(str::trim) else {
            return false;
        };
        match self {
            Self::ReleaseManifest | Self::Envelope => mime.eq_ignore_ascii_case("application/json"),
            Self::Artifact => [
                "application/octet-stream",
                "application/zstd",
                "application/x-zstd",
                "application/vnd.agentmesh.package",
            ]
            .iter()
            .any(|allowed| mime.eq_ignore_ascii_case(allowed)),
        }
    }
}

struct DownloadedFile {
    sha256: String,
    size: usize,
    bytes: Vec<u8>,
}

async fn download_to_private_file(
    client: &reqwest::Client,
    url: &Url,
    destination: &Path,
    limit: usize,
    content_kind: DownloadContentKind,
) -> Result<DownloadedFile> {
    let response = client
        .get(url.clone())
        .header(
            ACCEPT,
            match content_kind {
                DownloadContentKind::ReleaseManifest | DownloadContentKind::Envelope => {
                    "application/json"
                }
                DownloadContentKind::Artifact => {
                    "application/vnd.agentmesh.package, application/zstd, application/octet-stream"
                }
            },
        )
        .send()
        .await
        .map_err(|_| anyhow!("Agent Package download transport failed"))?;
    if response.url() != url || response.status() != StatusCode::OK {
        bail!("Agent Package download response was rejected");
    }
    if !response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| content_kind.accepts(value))
    {
        bail!("Agent Package download content type was rejected");
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length == 0 || length > limit as u64)
    {
        bail!("Agent Package download size is outside the allowed range");
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.mode(0o600);
    }
    let std_file = options
        .open(destination)
        .context("create private Agent Package download file")?;
    set_private_file_permissions(destination)?;
    let mut file = tokio::fs::File::from_std(std_file);
    let mut digest = Sha256::new();
    let mut size = 0_usize;
    let mut retained = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| anyhow!("Agent Package download stream failed"))?;
        size = size
            .checked_add(chunk.len())
            .ok_or_else(|| anyhow!("Agent Package download size overflow"))?;
        if size > limit {
            bail!("Agent Package download exceeded the allowed size");
        }
        file.write_all(&chunk)
            .await
            .context("write private Agent Package download")?;
        digest.update(&chunk);
        if matches!(
            content_kind,
            DownloadContentKind::ReleaseManifest | DownloadContentKind::Envelope
        ) {
            retained.extend_from_slice(&chunk);
        }
    }
    if size == 0 {
        bail!("Agent Package download is empty");
    }
    file.flush()
        .await
        .context("flush private Agent Package download")?;
    file.sync_all()
        .await
        .context("sync private Agent Package download")?;
    drop(file);
    Ok(DownloadedFile {
        sha256: lower_hex(&digest.finalize()),
        size,
        bytes: retained,
    })
}

struct DownloadOperation {
    path: PathBuf,
}

impl DownloadOperation {
    fn create(state_home: &Path) -> Result<Self> {
        let package_root = state_home.join("packages");
        let downloads_root = package_root.join(".downloads");
        create_private_dir(&package_root)?;
        create_private_dir(&downloads_root)?;
        let path = downloads_root.join(format!("download-{}", Uuid::now_v7()));
        create_private_new_dir(&path)?;
        set_private_dir_permissions(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DownloadOperation {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn create_private_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() {
                bail!("Agent Package download directory is not a real directory");
            }
            return set_private_dir_permissions(path);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).context("inspect private Agent Package download directory");
        }
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;

        builder.mode(0o700);
    }
    builder
        .create(path)
        .context("create private Agent Package download directory")?;
    set_private_dir_permissions(path)
}

fn create_private_new_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;

        builder.mode(0o700);
    }
    builder
        .create(path)
        .context("create private Agent Package download staging")
}

fn set_private_dir_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .context("secure private Agent Package download directory")?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .context("secure private Agent Package download file")?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn lower_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut encoded, byte| {
            write!(&mut encoded, "{byte:02x}").expect("write digest hex");
            encoded
        },
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use chrono::{TimeZone as _, Utc};
    use ed25519_dalek::SigningKey;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::package_artifact::{
        DownloadArtifactFixture, download_artifact_fixture_for_test,
    };
    use super::super::package_registry_snapshot::signed_registry_release_record_document_for_test;
    use super::super::package_release::release_document_for_download_test;
    use super::super::package_trust::{TrustedRootKey, signed_bundle_document_for_test};
    use super::*;

    const ROOT_KEY_ID: &str = "agentmesh360-root-test-2026";
    const PACKAGE_ID: &str = "com.agentmesh360.job-agent";

    #[tokio::test]
    async fn downloads_registry_selected_bytes_and_returns_verified_staging() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let (origin, server) = serve(vec![
            TestResponse::json_bytes(&release),
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&fixture.artifact),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);
        let downloader = downloader(temp.path(), &root, &origin);

        let downloaded = downloader
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect("download verified Package");

        assert_eq!(downloaded.audit.package_id, PACKAGE_ID);
        assert_eq!(downloaded.audit.agent_id, "job-agent");
        assert_eq!(downloaded.staged().manifest.agent.agent_id, "job-agent");
        assert!(
            downloaded
                .staged()
                .staging_path()
                .join("docs/agent-onboarding.md")
                .is_file()
        );
        assert!(download_root_is_empty(temp.path()));
        let requests = server.await.expect("server requests");
        assert_eq!(requests.len(), 3);
        assert!(requests[0].contains("agent-release.v1.json"));
        assert!(requests[1].contains("signature.v1.json"));
        assert!(requests[2].contains("ampkg.tar.zst"));
        assert!(!requests.join("\n").contains("authorization:"));
        let audit = serde_json::to_string(&downloaded.audit).expect("audit");
        assert!(!audit.contains("http://"));
        assert!(!audit.contains(temp.path().to_string_lossy().as_ref()));
        assert!(!audit.contains("sha256"));
    }

    #[tokio::test]
    async fn digest_failure_cleans_download_without_creating_verified_staging() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let mut tampered = fixture.artifact.clone();
        tampered.push(0);
        let (origin, server) = serve(vec![
            TestResponse::json_bytes(&release),
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&tampered),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);

        let error = downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("tampered artifact");

        assert!(error.to_string().contains("digest"));
        assert!(download_root_is_empty(temp.path()));
        assert!(!temp.path().join("packages/.staging").exists());
        let _ = server.await.expect("server requests");
    }

    #[tokio::test]
    async fn declared_oversized_envelope_is_rejected_before_artifact_download() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let (origin, server) = serve(vec![
            TestResponse::json_bytes(&release),
            TestResponse::json(&fixture.envelope).with_content_length(ENVELOPE_LIMIT + 1),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);

        let error = downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("oversized envelope");

        assert!(error.to_string().contains("size"));
        assert!(download_root_is_empty(temp.path()));
        assert!(!temp.path().join("packages/.staging").exists());
        assert_eq!(server.await.expect("server requests").len(), 2);
    }

    #[tokio::test]
    async fn registry_identity_mismatch_discards_both_staging_areas() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.8");
        let (origin, server) = serve(vec![
            TestResponse::json_bytes(&release),
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&fixture.artifact),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &fixture, "0.4.8", &release);

        let error = downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("registry identity mismatch");

        assert!(error.to_string().contains("identity"));
        assert!(download_root_is_empty(temp.path()));
        assert!(
            temp.path()
                .join("packages/.staging")
                .read_dir()
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true)
        );
        let _ = server.await.expect("server requests");
    }

    #[tokio::test]
    async fn release_digest_and_channel_drift_block_before_envelope_download() {
        let fixture = download_artifact_fixture_for_test();
        let root = SigningKey::from_bytes(&[91_u8; 32]);

        let digest_temp = tempfile::tempdir().expect("digest tempdir");
        let release = release_fixture(&fixture, "0.4.7");
        let mut tampered = release.clone();
        tampered.push(b' ');
        let (origin, server) = serve(vec![TestResponse::json_bytes(&tampered)]).await;
        seed_remote_package(digest_temp.path(), &root, &fixture, "0.4.7", &release);
        let error = downloader(digest_temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("Release digest mismatch");
        assert!(error.to_string().contains("digest"));
        assert_eq!(server.await.expect("digest requests").len(), 1);
        assert!(download_root_is_empty(digest_temp.path()));

        let strict_temp = tempfile::tempdir().expect("strict tempdir");
        let invalid_release = b"{}".to_vec();
        let (origin, server) = serve(vec![TestResponse::json_bytes(&invalid_release)]).await;
        seed_remote_package(
            strict_temp.path(),
            &root,
            &fixture,
            "0.4.7",
            &invalid_release,
        );
        let error = downloader(strict_temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("strict Release parse");
        assert!(format!("{error:#}").contains("verify Agent Release Manifest"));
        assert_eq!(server.await.expect("strict requests").len(), 1);
        assert!(download_root_is_empty(strict_temp.path()));

        let drift_temp = tempfile::tempdir().expect("drift tempdir");
        let drifted_release = release_document_for_download_test(
            PACKAGE_ID,
            "job-agent",
            "0.4.7",
            &"0".repeat(64),
            &fixture.envelope_sha256,
            &fixture.file_manifest_sha256,
            &fixture.signature_key_id,
        );
        let (origin, server) = serve(vec![TestResponse::json_bytes(&drifted_release)]).await;
        seed_remote_package(
            drift_temp.path(),
            &root,
            &fixture,
            "0.4.7",
            &drifted_release,
        );
        let error = downloader(drift_temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("Release channel drift");
        assert!(format!("{error:#}").contains("projection digest"));
        assert_eq!(server.await.expect("drift requests").len(), 1);
        assert!(download_root_is_empty(drift_temp.path()));

        let metadata_temp = tempfile::tempdir().expect("metadata tempdir");
        let metadata_release = release_document_for_download_test(
            PACKAGE_ID,
            "job-agent",
            "0.4.7",
            &fixture.artifact_sha256,
            &fixture.envelope_sha256,
            &"0".repeat(64),
            "agentmesh360-wrong-release-key",
        );
        let (origin, server) = serve(vec![
            TestResponse::json_bytes(&metadata_release),
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&fixture.artifact),
        ])
        .await;
        seed_remote_package(
            metadata_temp.path(),
            &root,
            &fixture,
            "0.4.7",
            &metadata_release,
        );
        let error = downloader(metadata_temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("Release verification metadata drift");
        assert!(
            error
                .to_string()
                .contains("verification differs from the Agent Release")
        );
        assert_eq!(server.await.expect("metadata requests").len(), 3);
        assert!(download_root_is_empty(metadata_temp.path()));
        assert!(
            metadata_temp
                .path()
                .join("packages/.staging")
                .read_dir()
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true)
        );
    }

    #[tokio::test]
    async fn missing_or_redirected_release_is_rejected_before_envelope_download() {
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let root = SigningKey::from_bytes(&[91_u8; 32]);

        for response in [
            TestResponse::json_bytes(&release).with_status(404),
            TestResponse::json_bytes(&release)
                .with_status(302)
                .with_location("/redirected-release.json"),
        ] {
            let temp = tempfile::tempdir().expect("tempdir");
            let (origin, server) = serve(vec![response]).await;
            seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);

            downloader(temp.path(), &root, &origin)
                .download_verified(PACKAGE_ID, &access())
                .await
                .expect_err("missing or redirected Release");

            assert_eq!(server.await.expect("Release requests").len(), 1);
            assert!(download_root_is_empty(temp.path()));
        }
    }

    #[tokio::test]
    async fn declared_oversized_release_is_rejected_before_envelope_download() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let (origin, server) = serve(vec![
            TestResponse::json_bytes(&release).with_content_length(MAX_RELEASE_MANIFEST_BYTES + 1),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);

        let error = downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("oversized Release");

        assert!(error.to_string().contains("size"));
        assert_eq!(server.await.expect("Release requests").len(), 1);
        assert!(download_root_is_empty(temp.path()));
    }

    #[tokio::test]
    async fn invalid_access_blocks_before_any_download_connection() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);
        let access = access();
        access.invalidate();

        downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access)
            .await
            .expect_err("invalid access");

        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        assert!(!temp.path().join("packages/.downloads").exists());
    }

    #[tokio::test]
    async fn expired_registry_blocks_release_fetch_instead_of_using_stale_lkg() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        let expired = ClientAccess::with_trusted_time_for_test(
            Utc.with_ymd_and_hms(2026, 8, 2, 0, 0, 0)
                .single()
                .expect("expired time"),
        );

        downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &expired)
            .await
            .expect_err("expired Registry");

        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        assert!(!temp.path().join("packages/.downloads").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_download_root_is_rejected_before_network() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let release = release_fixture(&fixture, "0.4.7");
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        seed_remote_package(temp.path(), &root, &fixture, "0.4.7", &release);
        fs::create_dir_all(temp.path().join("packages")).expect("packages");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).expect("outside");
        symlink(&outside, temp.path().join("packages/.downloads")).expect("symlink downloads");

        let error = downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("symlinked download root");

        assert!(error.to_string().contains("real directory"));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        assert!(
            outside
                .read_dir()
                .expect("outside entries")
                .next()
                .is_none()
        );
    }

    fn downloader(state_home: &Path, root: &SigningKey, origin: &str) -> PackageArtifactDownloader {
        PackageArtifactDownloader::for_test(
            state_home,
            roots(root),
            Url::parse(origin).expect("transport origin"),
        )
    }

    fn seed_remote_package(
        state_home: &Path,
        root: &SigningKey,
        fixture: &DownloadArtifactFixture,
        version: &str,
        release_document: &[u8],
    ) {
        let release_url =
            format!("{PRODUCTION_PACKAGE_ORIGIN}/{PACKAGE_ID}-{version}.agent-release.v1.json");
        let artifact_url =
            format!("{PRODUCTION_PACKAGE_ORIGIN}/{PACKAGE_ID}-{version}.ampkg.tar.zst");
        let envelope_url =
            format!("{PRODUCTION_PACKAGE_ORIGIN}/{PACKAGE_ID}-{version}.signature.v1.json");
        let trust =
            signed_bundle_document_for_test(root, ROOT_KEY_ID, 7, "2026-08-01T00:00:00Z", 7);
        let registry = signed_registry_release_record_document_for_test(
            root,
            ROOT_KEY_ID,
            42,
            7,
            PACKAGE_ID,
            "job-agent",
            version,
            &release_url,
            &lower_hex(&Sha256::digest(release_document)),
            &artifact_url,
            &fixture.artifact_sha256,
            &envelope_url,
            &fixture.envelope_sha256,
        );
        PackageTrustCacheStore::in_home_with_roots(state_home, roots(root))
            .accept_documents(&trust, &registry, &access())
            .expect("seed verified remote Package");
    }

    fn release_fixture(fixture: &DownloadArtifactFixture, version: &str) -> Vec<u8> {
        release_document_for_download_test(
            PACKAGE_ID,
            "job-agent",
            version,
            &fixture.artifact_sha256,
            &fixture.envelope_sha256,
            &fixture.file_manifest_sha256,
            &fixture.signature_key_id,
        )
    }

    fn roots(root: &SigningKey) -> TrustedRootStore {
        TrustedRootStore::with_key(TrustedRootKey {
            key_id: ROOT_KEY_ID.into(),
            public_key: root.verifying_key().to_bytes(),
        })
    }

    fn access() -> ClientAccess {
        ClientAccess::with_trusted_time_for_test(
            Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0)
                .single()
                .expect("time"),
        )
    }

    fn download_root_is_empty(state_home: &Path) -> bool {
        state_home
            .join("packages/.downloads")
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    }

    struct TestResponse {
        content_type: &'static str,
        body: Vec<u8>,
        content_length: Option<usize>,
        status: u16,
        location: Option<&'static str>,
    }

    impl TestResponse {
        fn json(body: &str) -> Self {
            Self::json_bytes(body.as_bytes())
        }

        fn json_bytes(body: &[u8]) -> Self {
            Self {
                content_type: "application/json",
                body: body.to_vec(),
                content_length: None,
                status: 200,
                location: None,
            }
        }

        fn artifact(body: &[u8]) -> Self {
            Self {
                content_type: "application/octet-stream",
                body: body.to_vec(),
                content_length: None,
                status: 200,
                location: None,
            }
        }

        fn with_content_length(mut self, content_length: usize) -> Self {
            self.content_length = Some(content_length);
            self
        }

        fn with_status(mut self, status: u16) -> Self {
            self.status = status;
            self
        }

        fn with_location(mut self, location: &'static str) -> Self {
            self.location = Some(location);
            self
        }
    }

    async fn serve(responses: Vec<TestResponse>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        let task = tokio::spawn(async move {
            let mut responses = VecDeque::from(responses);
            let mut requests = Vec::new();
            while let Some(response) = responses.pop_front() {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut request = vec![0; 8192];
                let read = stream.read(&mut request).await.expect("read");
                requests.push(String::from_utf8_lossy(&request[..read]).to_ascii_lowercase());
                let location = response
                    .location
                    .map(|value| format!("Location: {value}\r\n"))
                    .unwrap_or_default();
                let headers = format!(
                    "HTTP/1.1 {} Test\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
                    response.status,
                    response.content_type,
                    response.content_length.unwrap_or(response.body.len()),
                    location,
                );
                stream.write_all(headers.as_bytes()).await.expect("headers");
                let _ = stream.write_all(&response.body).await;
            }
            requests
        });
        (format!("http://{address}"), task)
    }
}
