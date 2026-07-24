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
use super::package_registry_fetcher::{PRODUCTION_PACKAGE_ORIGIN, validate_endpoint};
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
    #[cfg(test)]
    transport_origin_override: Option<Url>,
}

impl PackageArtifactDownloader {
    pub(crate) fn in_home(state_home: impl Into<PathBuf>) -> Self {
        let state_home = state_home.into();
        Self {
            cache: PackageTrustCacheStore::in_home(&state_home),
            state_home,
            client: download_client(),
            allowed_origin: PRODUCTION_PACKAGE_ORIGIN.into(),
            #[cfg(test)]
            transport_origin_override: None,
        }
    }

    #[cfg(test)]
    fn for_test(
        state_home: impl Into<PathBuf>,
        roots: TrustedRootStore,
        transport_origin_override: Url,
    ) -> Self {
        let state_home = state_home.into();
        Self {
            cache: PackageTrustCacheStore::in_home_with_roots(&state_home, roots),
            state_home,
            client: download_client(),
            allowed_origin: PRODUCTION_PACKAGE_ORIGIN.into(),
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
        let artifact_url = self.validate_download_url(&remote.record.artifact_url)?;
        let envelope_url = self.validate_download_url(&remote.record.envelope_url)?;
        let operation = DownloadOperation::create(&self.state_home)?;
        let envelope_path = operation.path().join("envelope.json");
        let artifact_path = operation.path().join("artifact.tar.zst");

        let envelope = download_to_private_file(
            &self.client,
            &self.request_url(&envelope_url),
            &envelope_path,
            ENVELOPE_LIMIT,
            DownloadContentKind::Envelope,
        )
        .await?;
        if envelope.sha256 != remote.record.envelope_sha256 {
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
        if artifact.sha256 != remote.record.artifact_sha256 {
            bail!("Agent Package artifact digest does not match verified registry");
        }

        let verified =
            PackageArtifactVerifier::with_trust_store(&self.state_home, remote.trusted_publishers)
                .verify_to_staging(&artifact_path, &envelope_document)?;
        if verified.manifest.package_id != remote.record.package_id
            || verified.manifest.agent.agent_id != remote.record.agent_id
            || verified.manifest.version != remote.record.version
            || verified.manifest.publisher != remote.record.publisher
        {
            bail!("downloaded Agent Package identity does not match verified registry");
        }
        let audit = PackageDownloadAudit {
            package_id: remote.record.package_id,
            agent_id: remote.record.agent_id,
            version: remote.record.version,
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
        #[cfg(test)]
        if let Some(origin) = &self.transport_origin_override {
            let mut request_url = origin.clone();
            request_url.set_path(verified_url.path());
            return request_url;
        }
        verified_url.clone()
    }
}

fn download_client() -> reqwest::Client {
    reqwest::Client::builder()
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
}

#[derive(Clone, Copy)]
enum DownloadContentKind {
    Envelope,
    Artifact,
}

impl DownloadContentKind {
    fn accepts(self, value: &str) -> bool {
        let Some(mime) = value.split(';').next().map(str::trim) else {
            return false;
        };
        match self {
            Self::Envelope => mime.eq_ignore_ascii_case("application/json"),
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
                DownloadContentKind::Envelope => "application/json",
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
        if matches!(content_kind, DownloadContentKind::Envelope) {
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
    use super::super::package_registry_snapshot::signed_registry_record_document_for_test;
    use super::super::package_trust::{TrustedRootKey, signed_bundle_document_for_test};
    use super::*;

    const ROOT_KEY_ID: &str = "agentmesh360-root-test-2026";
    const PACKAGE_ID: &str = "com.agentmesh360.job-agent";

    #[tokio::test]
    async fn downloads_registry_selected_bytes_and_returns_verified_staging() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let (origin, server) = serve(vec![
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&fixture.artifact),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &origin, &fixture, "0.4.7");
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
        assert_eq!(requests.len(), 2);
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
        let mut tampered = fixture.artifact.clone();
        tampered.push(0);
        let (origin, server) = serve(vec![
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&tampered),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &origin, &fixture, "0.4.7");

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
        let (origin, server) = serve(vec![
            TestResponse::json(&fixture.envelope).with_content_length(ENVELOPE_LIMIT + 1),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &origin, &fixture, "0.4.7");

        let error = downloader(temp.path(), &root, &origin)
            .download_verified(PACKAGE_ID, &access())
            .await
            .expect_err("oversized envelope");

        assert!(error.to_string().contains("size"));
        assert!(download_root_is_empty(temp.path()));
        assert!(!temp.path().join("packages/.staging").exists());
        assert_eq!(server.await.expect("server requests").len(), 1);
    }

    #[tokio::test]
    async fn registry_identity_mismatch_discards_both_staging_areas() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let (origin, server) = serve(vec![
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&fixture.artifact),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &origin, &fixture, "0.4.8");

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
    async fn invalid_access_blocks_before_any_download_connection() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        seed_remote_package(temp.path(), &root, &origin, &fixture, "0.4.7");
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

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_download_root_is_rejected_before_network() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        seed_remote_package(temp.path(), &root, &origin, &fixture, "0.4.7");
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
        origin: &str,
        fixture: &DownloadArtifactFixture,
        version: &str,
    ) {
        let _ = origin;
        let artifact_url = format!("{PRODUCTION_PACKAGE_ORIGIN}/job-agent.tar.zst");
        let envelope_url = format!("{PRODUCTION_PACKAGE_ORIGIN}/job-agent.signature.json");
        let trust =
            signed_bundle_document_for_test(root, ROOT_KEY_ID, 7, "2026-08-01T00:00:00Z", 7);
        let registry = signed_registry_record_document_for_test(
            root,
            ROOT_KEY_ID,
            42,
            7,
            PACKAGE_ID,
            "job-agent",
            version,
            &artifact_url,
            &fixture.artifact_sha256,
            &envelope_url,
            &fixture.envelope_sha256,
        );
        PackageTrustCacheStore::in_home_with_roots(state_home, roots(root))
            .accept_documents(&trust, &registry, &access())
            .expect("seed verified remote Package");
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
    }

    impl TestResponse {
        fn json(body: &str) -> Self {
            Self {
                content_type: "application/json",
                body: body.as_bytes().to_vec(),
                content_length: None,
            }
        }

        fn artifact(body: &[u8]) -> Self {
            Self {
                content_type: "application/octet-stream",
                body: body.to_vec(),
                content_length: None,
            }
        }

        fn with_content_length(mut self, content_length: usize) -> Self {
            self.content_length = Some(content_length);
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
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.content_type,
                    response.content_length.unwrap_or(response.body.len())
                );
                stream.write_all(headers.as_bytes()).await.expect("headers");
                let _ = stream.write_all(&response.body).await;
            }
            requests
        });
        (format!("http://{address}"), task)
    }
}
