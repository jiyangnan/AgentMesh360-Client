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
    InstalledPackageRecord, PackageInstallResult, PackageInstallService, PackageStatusIssue,
    VerifiedPackageInstallPlan,
};
use super::registry::AgentRegistry;

const APPROVAL_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_APPROVALS: usize = 32;

pub(crate) struct PackageDeliveryService {
    downloader: PackageArtifactDownloader,
    installer: PackageInstallService,
    registry: AgentRegistry,
    pending: Arc<Mutex<BTreeMap<Uuid, PendingPackageApproval>>>,
    approval_ttl: Duration,
}

impl PackageDeliveryService {
    pub(crate) fn in_home(state_home: impl Into<PathBuf>) -> Self {
        let state_home = state_home.into();
        let registry = AgentRegistry::in_home(&state_home);
        Self::in_home_with_registry(state_home, registry)
    }

    pub(crate) fn in_home_with_registry(
        state_home: impl Into<PathBuf>,
        registry: AgentRegistry,
    ) -> Self {
        let state_home = state_home.into();
        Self {
            downloader: PackageArtifactDownloader::in_home(&state_home),
            installer: PackageInstallService::in_home(&state_home),
            registry,
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
    ) -> Result<PackageInstallReceipt> {
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

        let verified = pending.download.into_staged();
        let plan = pending.plan;
        self.install_with_plan_and_refresh(verified, plan, true)
    }

    fn prepare_downloaded(
        &self,
        downloaded: VerifiedPackageDownload,
        owner_account_id: i64,
    ) -> Result<PackageDeliveryResult> {
        let plan = self.installer.plan_verified_install(downloaded.staged())?;
        let Some(approval) = plan.approval_request() else {
            return self
                .install_with_plan_and_refresh(downloaded.into_staged(), plan, false)
                .map(|receipt| PackageDeliveryResult::Installed { receipt });
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
            registry: AgentRegistry::in_home(&state_home),
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

    fn install_with_plan_and_refresh(
        &self,
        verified: super::package_artifact::VerifiedStagedPackage,
        plan: VerifiedPackageInstallPlan,
        permissions_approved: bool,
    ) -> Result<PackageInstallReceipt> {
        let (installed, refresh) = self.registry.mutate_and_refresh_package_catalog(|| {
            let observed_plan = self.installer.plan_verified_install(&verified)?;
            if observed_plan != plan {
                bail!("Agent Package approval no longer matches install state");
            }
            self.installer
                .install_verified_with_plan(verified, &plan, permissions_approved)
                .and_then(installed_only)
        })?;
        Ok(self.install_receipt(installed, refresh))
    }

    #[cfg(test)]
    fn finalize_installed(&self, installed: InstalledPackageRecord) -> PackageInstallReceipt {
        let refresh = self.registry.refresh_package_catalog();
        self.install_receipt(installed, refresh)
    }

    fn install_receipt(
        &self,
        installed: InstalledPackageRecord,
        refresh: Result<Arc<super::agent_packages::AgentPackageCatalog>>,
    ) -> PackageInstallReceipt {
        let health = self.registry.package_catalog_health();
        let visibility = match refresh {
            Ok(catalog) => match catalog
                .packages
                .iter()
                .find(|package| package.package_id == installed.package_id)
            {
                Some(package)
                    if package.agent.agent_id == installed.agent_id
                        && package.version == installed.active.version =>
                {
                    PackageRuntimeVisibility::Visible {
                        catalog_generation: health.generation,
                        catalog_revision: catalog.catalog_revision,
                    }
                }
                Some(package) if package.agent.agent_id == installed.agent_id => {
                    PackageRuntimeVisibility::Superseded {
                        catalog_generation: health.generation,
                        catalog_revision: catalog.catalog_revision,
                        active_version: package.version.clone(),
                    }
                }
                _ => PackageRuntimeVisibility::RefreshPending {
                    catalog_generation: health.generation,
                    catalog_revision: health.catalog_revision,
                    issue: runtime_refresh_issue(),
                },
            },
            Err(_) => PackageRuntimeVisibility::RefreshPending {
                catalog_generation: health.generation,
                catalog_revision: health.catalog_revision,
                issue: health.last_issue.unwrap_or_else(runtime_refresh_issue),
            },
        };
        PackageInstallReceipt {
            package_id: installed.package_id,
            agent_id: installed.agent_id,
            version: installed.active.version,
            runtime_visibility: visibility,
        }
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
    ApprovalRequired { approval: PackageApprovalChallenge },
    Installed { receipt: PackageInstallReceipt },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageInstallReceipt {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub runtime_visibility: PackageRuntimeVisibility,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub(crate) enum PackageRuntimeVisibility {
    Visible {
        catalog_generation: u64,
        catalog_revision: u64,
    },
    Superseded {
        catalog_generation: u64,
        catalog_revision: u64,
        active_version: String,
    },
    RefreshPending {
        catalog_generation: u64,
        catalog_revision: Option<u64>,
        issue: PackageStatusIssue,
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

fn runtime_refresh_issue() -> PackageStatusIssue {
    PackageStatusIssue {
        code: "runtime_catalog_refresh_pending".into(),
        summary: "The Package is installed but is not yet visible to the runtime catalog.".into(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::fs;

    use chrono::{TimeZone as _, Utc};
    use ed25519_dalek::SigningKey;
    use sha2::{Digest as _, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::agent_packages::AgentPackageCatalog;
    use super::super::package_artifact::{
        DownloadArtifactFixture, FILE_MANIFEST_PATH, PackageArtifactVerifier,
        VerifiedStagedPackage, download_artifact_fixture_for_test,
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
    const JOB_MANIFEST: &str = include_str!("packages/job-agent/agentmesh-agent.toml");

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
        assert!(matches!(
            installed.runtime_visibility,
            PackageRuntimeVisibility::Visible { .. }
        ));
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
        let receipt = serde_json::to_string(&installed).expect("serialize install receipt");
        for secret in ["sha256", "relativePath", temp.path().to_str().unwrap()] {
            assert!(!receipt.contains(secret));
        }
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

    #[test]
    fn new_agent_becomes_visible_and_projects_for_existing_accounts() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::in_home(temp.path());
        assert_eq!(service.registry.list(1).expect("account one").len(), 3);
        assert_eq!(service.registry.list(2).expect("account two").len(), 3);
        let result = service
            .prepare_downloaded(
                verified_download_from_manifest(temp.path(), &new_agent_manifest(), 'b'),
                1,
            )
            .expect("prepare new Agent");
        let PackageDeliveryResult::ApprovalRequired { approval } = result else {
            panic!("expected approval");
        };

        let receipt = service
            .approve_and_install(&approval.approval_id, &access())
            .expect("install new Agent");

        assert_eq!(receipt.agent_id, "research-agent");
        assert!(matches!(
            receipt.runtime_visibility,
            PackageRuntimeVisibility::Visible { .. }
        ));
        for owner_account_id in [1, 2] {
            let agents = service
                .registry
                .list(owner_account_id)
                .expect("project account Agent");
            assert!(
                agents.iter().any(|agent| {
                    agent.agent_id == "research-agent" && agent.version == "0.1.0"
                })
            );
        }
        let activated = service
            .registry
            .prepare_activation(1, "research-agent")
            .expect("activate projected Agent");
        let expected_session_id =
            super::super::registry::stable_main_session_id(1, "research-agent").to_string();
        assert_eq!(
            activated.main_session_id.as_deref(),
            Some(expected_session_id.as_str())
        );
    }

    #[test]
    fn refresh_failure_keeps_last_good_and_reports_installed_pending_then_recovers() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::in_home(temp.path());
        let initial_health = service.registry.package_catalog_health();
        let installed = install_direct(
            &service,
            verified_download_from_manifest(temp.path(), &new_agent_manifest(), 'c'),
        );
        let active_path = temp
            .path()
            .join("packages")
            .join(&installed.active.relative_path);
        fs::write(active_path.join("docs/agent-onboarding.md"), b"tampered")
            .expect("tamper installed Package");

        let pending = service.finalize_installed(installed.clone());

        assert!(matches!(
            pending.runtime_visibility,
            PackageRuntimeVisibility::RefreshPending { .. }
        ));
        let degraded = service.registry.package_catalog_health();
        assert_eq!(degraded.generation, initial_health.generation);
        assert_eq!(degraded.catalog_revision, initial_health.catalog_revision);
        assert!(degraded.last_issue.is_some());
        assert!(
            service
                .registry
                .package_catalog()
                .expect("last-known-good")
                .package_for_agent("research-agent")
                .is_err()
        );
        assert!(
            service
                .installer
                .get("com.agentmesh360.research-agent")
                .expect("installed record")
                .is_some()
        );
        fs::write(
            active_path.join("docs/agent-onboarding.md"),
            b"# Job Agent workflow\n",
        )
        .expect("restore installed Package");

        let recovered = service.finalize_installed(installed);

        assert!(matches!(
            recovered.runtime_visibility,
            PackageRuntimeVisibility::Visible { .. }
        ));
        let health = service.registry.package_catalog_health();
        assert_eq!(health.generation, initial_health.generation + 1);
        assert!(health.last_issue.is_none());
    }

    #[test]
    fn older_install_refresh_cannot_overwrite_a_newer_active_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = PackageDeliveryService::in_home(temp.path());
        let older = install_direct(
            &service,
            verified_download_from_manifest(temp.path(), &runtime_upgrade_manifest("0.4.8"), 'd'),
        );
        let newer = install_direct(
            &service,
            verified_download_from_manifest(temp.path(), &runtime_upgrade_manifest("0.4.9"), 'e'),
        );

        let superseded = service.finalize_installed(older);
        let visible = service.finalize_installed(newer);

        assert!(matches!(
            superseded.runtime_visibility,
            PackageRuntimeVisibility::Superseded {
                active_version,
                ..
            } if active_version == "0.4.9"
        ));
        assert!(matches!(
            visible.runtime_visibility,
            PackageRuntimeVisibility::Visible { .. }
        ));
        assert_eq!(
            service
                .registry
                .package_catalog()
                .expect("Catalog")
                .package_for_agent("job-agent")
                .expect("Job Agent")
                .version,
            "0.4.9"
        );
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

    fn verified_download_from_manifest(
        state_home: &std::path::Path,
        document: &str,
        digest_byte: char,
    ) -> VerifiedPackageDownload {
        let manifest = AgentPackageCatalog::parse_document(document).expect("manifest");
        let staging_dir = state_home.join("test-delivery-staging").join(format!(
            "{}-{}",
            digest_byte,
            Uuid::now_v7()
        ));
        fs::create_dir_all(&staging_dir).expect("staging");
        write_test_package_tree(&staging_dir, document);
        VerifiedPackageDownload::for_test(VerifiedStagedPackage::for_test(
            manifest,
            digest_byte.to_string().repeat(64),
            "agentmesh360-release-test",
            staging_dir,
        ))
    }

    fn install_direct(
        service: &PackageDeliveryService,
        downloaded: VerifiedPackageDownload,
    ) -> InstalledPackageRecord {
        let plan = service
            .installer
            .plan_verified_install(downloaded.staged())
            .expect("install plan");
        let result = service
            .installer
            .install_verified_with_plan(downloaded.into_staged(), &plan, true)
            .expect("install Package");
        installed_only(result).expect("installed Package")
    }

    fn write_test_package_tree(staging_dir: &std::path::Path, document: &str) {
        let files = [
            ("agentmesh-agent.toml", document.as_bytes()),
            ("docs/agent-onboarding.md", b"# Job Agent workflow\n"),
            ("skills/claude-code/SKILL.md", b"# Claude Code adapter\n"),
            (
                "skills/openclaw-job-agent/SKILL.md",
                b"# OpenClaw adapter\n",
            ),
        ];
        let mut records = Vec::new();
        for (relative_path, contents) in files {
            let destination = staging_dir.join(relative_path);
            fs::create_dir_all(destination.parent().expect("file parent")).expect("file parent");
            fs::write(&destination, contents).expect("write test Package file");
            records.push(serde_json::json!({
                "path": relative_path,
                "size": contents.len(),
                "sha256": lower_hex(&Sha256::digest(contents)),
            }));
        }
        records.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
        fs::write(
            staging_dir.join(FILE_MANIFEST_PATH),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "files": records,
            }))
            .expect("serialize file manifest"),
        )
        .expect("write file manifest");
    }

    fn lower_hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;

        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut output, "{byte:02x}").expect("hex");
        }
        output
    }

    fn new_agent_manifest() -> String {
        JOB_MANIFEST
            .replacen(
                "packageId = \"com.agentmesh360.job-agent\"",
                "packageId = \"com.agentmesh360.research-agent\"",
                1,
            )
            .replacen("version = \"0.4.7\"", "version = \"0.1.0\"", 1)
            .replacen("agentId = \"job-agent\"", "agentId = \"research-agent\"", 1)
            .replacen(
                "displayName = \"Job Agent\"",
                "displayName = \"Research Agent\"",
                1,
            )
            .replacen("sortOrder = 10", "sortOrder = 40", 1)
    }

    fn runtime_upgrade_manifest(version: &str) -> String {
        JOB_MANIFEST
            .replacen(
                "version = \"0.4.7\"",
                &format!("version = \"{version}\""),
                1,
            )
            .replacen("You are Job Agent", "You are Runtime Upgraded Job Agent", 1)
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
