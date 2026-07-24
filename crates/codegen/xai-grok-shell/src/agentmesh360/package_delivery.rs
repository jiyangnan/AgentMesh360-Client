use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use parking_lot::Mutex;
use serde::Serialize;
use uuid::Uuid;

use super::access::ClientAccess;
use super::package_downloader::{PackageArtifactDownloader, VerifiedPackageDownload};
use super::package_installer::{
    InstalledPackageRecord, PackageInstallResult, PackageInstallService, VerifiedPackageInstallPlan,
};

const APPROVAL_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_APPROVALS: usize = 32;

pub(crate) struct PackageDeliveryService {
    downloader: PackageArtifactDownloader,
    installer: PackageInstallService,
    pending: Arc<Mutex<BTreeMap<Uuid, PendingPackageApproval>>>,
    approval_ttl: Duration,
}

impl PackageDeliveryService {
    pub(crate) fn in_home(state_home: impl Into<PathBuf>) -> Self {
        let state_home = state_home.into();
        Self {
            downloader: PackageArtifactDownloader::in_home(&state_home),
            installer: PackageInstallService::in_home(&state_home),
            pending: Arc::new(Mutex::new(BTreeMap::new())),
            approval_ttl: APPROVAL_TTL,
        }
    }

    pub(crate) async fn download_or_request_approval(
        &self,
        package_id: &str,
        access: &ClientAccess,
    ) -> Result<PackageDeliveryResult> {
        let owner_account_id = require_account(access)?;
        self.ensure_pending_capacity()?;
        let downloaded = self
            .downloader
            .download_verified(package_id, access)
            .await?;
        if require_account(access)? != owner_account_id {
            bail!("Agent Package delivery access changed during download");
        }
        self.prepare_downloaded(downloaded, owner_account_id)
    }

    pub(crate) fn approve_and_install(
        &self,
        approval_id: &str,
        access: &ClientAccess,
    ) -> Result<InstalledPackageRecord> {
        let owner_account_id = require_account(access)?;
        let approval_id = Uuid::parse_str(approval_id)
            .map_err(|_| anyhow!("Agent Package approval is unavailable"))?;
        let pending = {
            let mut approvals = self.pending.lock();
            purge_expired(&mut approvals, Instant::now());
            if approvals
                .get(&approval_id)
                .is_none_or(|pending| pending.owner_account_id != owner_account_id)
            {
                bail!("Agent Package approval is unavailable");
            }
            approvals
                .remove(&approval_id)
                .expect("checked pending Package approval")
        };
        require_account(access)?;

        let observed_plan = self
            .installer
            .plan_verified_install(pending.download.staged())?;
        if observed_plan != pending.plan {
            bail!("Agent Package approval no longer matches install state");
        }
        let result = self.installer.install_verified_with_plan(
            pending.download.into_staged(),
            &pending.plan,
            true,
        )?;
        installed_only(result)
    }

    fn prepare_downloaded(
        &self,
        downloaded: VerifiedPackageDownload,
        owner_account_id: i64,
    ) -> Result<PackageDeliveryResult> {
        let plan = self.installer.plan_verified_install(downloaded.staged())?;
        let Some(approval) = plan.approval_request() else {
            let result = self.installer.install_verified_with_plan(
                downloaded.into_staged(),
                &plan,
                false,
            )?;
            return installed_only(result).map(|package| PackageDeliveryResult::Installed {
                package: Box::new(package),
            });
        };

        let approval_id = Uuid::now_v7();
        let expires_at = Instant::now()
            .checked_add(self.approval_ttl)
            .ok_or_else(|| anyhow!("Agent Package approval expiry is invalid"))?;
        let challenge = PackageApprovalChallenge {
            approval_id: approval_id.to_string(),
            package_id: approval.package_id,
            version: approval.version,
            added_permissions: approval.added_permissions,
            expires_in_seconds: self.approval_ttl.as_secs(),
        };
        let mut approvals = self.pending.lock();
        purge_expired(&mut approvals, Instant::now());
        if approvals.len() >= MAX_PENDING_APPROVALS {
            bail!("too many pending Agent Package approvals");
        }
        approvals.insert(
            approval_id,
            PendingPackageApproval {
                owner_account_id,
                expires_at,
                plan,
                download: downloaded,
            },
        );
        drop(approvals);
        self.schedule_expiration(approval_id, expires_at);
        Ok(PackageDeliveryResult::ApprovalRequired {
            approval: challenge,
        })
    }

    fn ensure_pending_capacity(&self) -> Result<()> {
        let mut approvals = self.pending.lock();
        purge_expired(&mut approvals, Instant::now());
        if approvals.len() >= MAX_PENDING_APPROVALS {
            bail!("too many pending Agent Package approvals");
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_ttl(state_home: impl Into<PathBuf>, approval_ttl: Duration) -> Self {
        let mut service = Self::in_home(state_home);
        service.approval_ttl = approval_ttl;
        service
    }

    #[cfg(test)]
    fn for_test(
        state_home: impl Into<PathBuf>,
        roots: super::package_trust::TrustedRootStore,
        transport_origin: url::Url,
    ) -> Self {
        let state_home = state_home.into();
        Self {
            downloader: PackageArtifactDownloader::for_test(&state_home, roots, transport_origin),
            installer: PackageInstallService::in_home(&state_home),
            pending: Arc::new(Mutex::new(BTreeMap::new())),
            approval_ttl: APPROVAL_TTL,
        }
    }

    fn schedule_expiration(&self, approval_id: Uuid, expires_at: Instant) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let pending = Arc::clone(&self.pending);
        runtime.spawn(async move {
            tokio::time::sleep_until(tokio::time::Instant::from_std(expires_at)).await;
            pending.lock().remove(&approval_id);
        });
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageApprovalChallenge {
    pub approval_id: String,
    pub package_id: String,
    pub version: String,
    pub added_permissions: Vec<String>,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub(crate) enum PackageDeliveryResult {
    ApprovalRequired {
        approval: PackageApprovalChallenge,
    },
    Installed {
        package: Box<InstalledPackageRecord>,
    },
}

struct PendingPackageApproval {
    owner_account_id: i64,
    expires_at: Instant,
    plan: VerifiedPackageInstallPlan,
    download: VerifiedPackageDownload,
}

fn purge_expired(approvals: &mut BTreeMap<Uuid, PendingPackageApproval>, now: Instant) {
    approvals.retain(|_, pending| now < pending.expires_at);
}

fn require_account(access: &ClientAccess) -> Result<i64> {
    access
        .require()
        .map_err(|_| anyhow!("Agent Package delivery requires active subscription"))?;
    access
        .current_account_id()
        .ok_or_else(|| anyhow!("Agent Package delivery requires an active account"))
}

fn installed_only(result: PackageInstallResult) -> Result<InstalledPackageRecord> {
    match result {
        PackageInstallResult::Installed { package } => Ok(*package),
        PackageInstallResult::ApprovalRequired { .. } => {
            bail!("Agent Package install state changed; approval must be requested again")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::fs;

    use chrono::{TimeZone as _, Utc};
    use ed25519_dalek::SigningKey;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::package_artifact::{
        DownloadArtifactFixture, PackageArtifactVerifier, download_artifact_fixture_for_test,
    };
    use super::super::package_registry_fetcher::PRODUCTION_PACKAGE_ORIGIN;
    use super::super::package_registry_snapshot::signed_registry_record_document_for_test;
    use super::super::package_trust::{
        TrustedPublisherKey, TrustedPublisherStore, TrustedRootKey, TrustedRootStore,
        signed_bundle_document_for_test,
    };
    use super::super::package_trust_cache::PackageTrustCacheStore;
    use super::*;

    const ROOT_KEY_ID: &str = "agentmesh360-root-test-2026";
    const PACKAGE_ID: &str = "com.agentmesh360.job-agent";

    #[tokio::test]
    async fn signed_registry_download_flows_into_approval_and_install() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fixture = download_artifact_fixture_for_test();
        let (origin, server) = serve(vec![
            TestResponse::json(&fixture.envelope),
            TestResponse::artifact(&fixture.artifact),
        ])
        .await;
        let root = SigningKey::from_bytes(&[91_u8; 32]);
        seed_remote_package(temp.path(), &root, &fixture);
        let service = PackageDeliveryService::for_test(
            temp.path(),
            roots(&root),
            url::Url::parse(&origin).expect("origin"),
        );
        let access = access();

        let result = service
            .download_or_request_approval(PACKAGE_ID, &access)
            .await
            .expect("download and request approval");
        let PackageDeliveryResult::ApprovalRequired { approval } = result else {
            panic!("expected approval");
        };
        let installed = service
            .approve_and_install(&approval.approval_id, &access)
            .expect("approved install");

        assert_eq!(installed.package_id, PACKAGE_ID);
        assert_eq!(server.await.expect("server requests").len(), 2);
        assert!(
            temp.path()
                .join("packages/.downloads")
                .read_dir()
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true)
        );
    }

    #[test]
    fn approval_is_bound_one_time_and_installs_without_exposing_sensitive_fields() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::in_home(temp.path());
        let access = access();

        let result = service
            .prepare_downloaded(verified_download(temp.path()), 1)
            .expect("prepare approval");
        let PackageDeliveryResult::ApprovalRequired { approval } = result else {
            panic!("expected approval");
        };

        assert!(
            service
                .installer
                .get("com.agentmesh360.job-agent")
                .expect("registry")
                .is_none()
        );
        let serialized = serde_json::to_string(&approval).expect("serialize challenge");
        for secret in [
            "sha256",
            "artifact",
            "account",
            "path",
            temp.path().to_str().unwrap(),
        ] {
            assert!(!serialized.to_ascii_lowercase().contains(secret));
        }

        let installed = service
            .approve_and_install(&approval.approval_id, &access)
            .expect("approved install");
        assert_eq!(installed.package_id, "com.agentmesh360.job-agent");
        assert!(
            service
                .approve_and_install(&approval.approval_id, &access)
                .expect_err("approval replay")
                .to_string()
                .contains("unavailable")
        );
    }

    #[test]
    fn invalid_access_and_wrong_id_do_not_consume_a_valid_approval() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::in_home(temp.path());
        let result = service
            .prepare_downloaded(verified_download(temp.path()), 1)
            .expect("prepare approval");
        let PackageDeliveryResult::ApprovalRequired { approval } = result else {
            panic!("expected approval");
        };
        let invalid = access();
        invalid.invalidate();

        service
            .approve_and_install(&approval.approval_id, &invalid)
            .expect_err("invalid access");
        service
            .approve_and_install(&Uuid::now_v7().to_string(), &access())
            .expect_err("wrong approval id");
        service
            .approve_and_install(&approval.approval_id, &access())
            .expect("valid approval remains");
    }

    #[test]
    fn tampered_staging_invalidates_approval_and_cleans_without_installing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::in_home(temp.path());
        let result = service
            .prepare_downloaded(verified_download(temp.path()), 1)
            .expect("prepare approval");
        let PackageDeliveryResult::ApprovalRequired { approval } = result else {
            panic!("expected approval");
        };
        let staging = service
            .pending
            .lock()
            .values()
            .next()
            .expect("pending")
            .download
            .staged()
            .staging_path()
            .to_path_buf();
        fs::write(staging.join("docs/agent-onboarding.md"), b"tampered").expect("tamper");

        service
            .approve_and_install(&approval.approval_id, &access())
            .expect_err("tampered staging");

        assert!(
            service
                .installer
                .get("com.agentmesh360.job-agent")
                .expect("registry")
                .is_none()
        );
        assert!(!staging.exists());
    }

    #[test]
    fn install_state_change_invalidates_the_bound_approval_plan() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::in_home(temp.path());
        let result = service
            .prepare_downloaded(verified_download(temp.path()), 1)
            .expect("prepare approval");
        let PackageDeliveryResult::ApprovalRequired { approval } = result else {
            panic!("expected approval");
        };

        let competing = verified_download(temp.path());
        let competing_plan = service
            .installer
            .plan_verified_install(competing.staged())
            .expect("competing plan");
        let competing_result = service
            .installer
            .install_verified_with_plan(competing.into_staged(), &competing_plan, true)
            .expect("competing install");
        installed_only(competing_result).expect("installed competing Package");

        let error = service
            .approve_and_install(&approval.approval_id, &access())
            .expect_err("stale approval");

        assert!(error.to_string().contains("no longer matches"));
        assert!(service.pending.lock().is_empty());
    }

    #[test]
    fn expired_approval_drops_staging_and_never_installs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::with_ttl(temp.path(), Duration::ZERO);
        let result = service
            .prepare_downloaded(verified_download(temp.path()), 1)
            .expect("prepare approval");
        let PackageDeliveryResult::ApprovalRequired { approval } = result else {
            panic!("expected approval");
        };

        service
            .approve_and_install(&approval.approval_id, &access())
            .expect_err("expired approval");

        assert!(service.pending.lock().is_empty());
        assert!(
            temp.path()
                .join("packages/.staging")
                .read_dir()
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true)
        );
        assert!(
            service
                .installer
                .get("com.agentmesh360.job-agent")
                .expect("registry")
                .is_none()
        );
    }

    #[tokio::test]
    async fn pending_staging_is_removed_when_approval_ttl_elapses() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::with_ttl(temp.path(), Duration::from_millis(10));
        let result = service
            .prepare_downloaded(verified_download(temp.path()), 1)
            .expect("prepare approval");
        let PackageDeliveryResult::ApprovalRequired { .. } = result else {
            panic!("expected approval");
        };
        let staging = service
            .pending
            .lock()
            .values()
            .next()
            .expect("pending")
            .download
            .staged()
            .staging_path()
            .to_path_buf();

        tokio::time::sleep(Duration::from_millis(30)).await;

        assert!(service.pending.lock().is_empty());
        assert!(!staging.exists());
    }

    fn verified_download(state_home: &std::path::Path) -> VerifiedPackageDownload {
        let fixture = download_artifact_fixture_for_test();
        let artifact_path = state_home.join(format!("fixture-{}.tar.zst", Uuid::now_v7()));
        fs::write(&artifact_path, fixture.artifact).expect("write artifact");
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let trust_store = TrustedPublisherStore::with_key(TrustedPublisherKey {
            key_id: "agentmesh360-release-test".into(),
            publisher: "agentmesh360".into(),
            public_key: signing_key.verifying_key().to_bytes(),
        });
        let verified = PackageArtifactVerifier::with_trust_store(state_home, trust_store)
            .verify_to_staging(&artifact_path, &fixture.envelope)
            .expect("verify fixture");
        fs::remove_file(artifact_path).expect("remove fixture artifact");
        VerifiedPackageDownload::for_test(verified)
    }

    fn seed_remote_package(
        state_home: &std::path::Path,
        root: &SigningKey,
        fixture: &DownloadArtifactFixture,
    ) {
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
            "0.4.7",
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

    struct TestResponse {
        content_type: &'static str,
        body: Vec<u8>,
    }

    impl TestResponse {
        fn json(body: &str) -> Self {
            Self {
                content_type: "application/json",
                body: body.as_bytes().to_vec(),
            }
        }

        fn artifact(body: &[u8]) -> Self {
            Self {
                content_type: "application/octet-stream",
                body: body.to_vec(),
            }
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
                requests.push(String::from_utf8_lossy(&request[..read]).to_string());
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.content_type,
                    response.body.len()
                );
                stream.write_all(headers.as_bytes()).await.expect("headers");
                stream.write_all(&response.body).await.expect("body");
            }
            requests
        });
        (format!("http://{address}"), task)
    }

    fn access() -> ClientAccess {
        ClientAccess::with_trusted_time_for_test(
            Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0)
                .single()
                .expect("time"),
        )
    }
}
