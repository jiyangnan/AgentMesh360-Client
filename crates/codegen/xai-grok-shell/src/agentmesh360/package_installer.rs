use std::collections::BTreeSet;
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use semver::Version;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use walkdir::WalkDir;

use super::agent_packages::{AgentPackageManifest, PackagePermission};
use super::package_artifact::{
    PackageArtifactVerifier, VerifiedStagedPackage, verify_installed_package_tree,
};

#[cfg(test)]
use super::agent_packages::AgentPackageCatalog;
#[cfg(test)]
use super::package_artifact::{FILE_MANIFEST_PATH, TrustedPublisherStore};

#[cfg(test)]
const PACKAGE_MANIFEST_PATH: &str = "agentmesh-agent.toml";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPackageVersion {
    pub version: String,
    pub artifact_sha256: String,
    pub file_manifest_sha256: String,
    pub relative_path: String,
    pub requested_permissions: Vec<PackagePermission>,
    pub signature_key_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPackageRecord {
    pub package_id: String,
    pub agent_id: String,
    pub active: InstalledPackageVersion,
    pub previous: Option<InstalledPackageVersion>,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageApprovalRequest {
    pub package_id: String,
    pub version: String,
    pub added_permissions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "status")]
pub(crate) enum PackageInstallResult {
    ApprovalRequired {
        approval: PackageApprovalRequest,
    },
    Installed {
        package: Box<InstalledPackageRecord>,
    },
}

pub(crate) struct PackageInstallService {
    state_home: PathBuf,
    package_root: PathBuf,
    verifier: PackageArtifactVerifier,
}

impl PackageInstallService {
    pub(crate) fn in_home(state_home: impl AsRef<Path>) -> Self {
        let state_home = state_home.as_ref().to_path_buf();
        Self {
            package_root: state_home.join("packages"),
            verifier: PackageArtifactVerifier::in_home(&state_home),
            state_home,
        }
    }

    #[cfg(test)]
    fn with_trust_store(state_home: impl AsRef<Path>, trust_store: TrustedPublisherStore) -> Self {
        let state_home = state_home.as_ref().to_path_buf();
        Self {
            package_root: state_home.join("packages"),
            verifier: PackageArtifactVerifier::with_trust_store(&state_home, trust_store),
            state_home,
        }
    }

    pub(crate) fn install(
        &self,
        artifact_path: &Path,
        envelope_document: &str,
        permissions_approved: bool,
    ) -> Result<PackageInstallResult> {
        let verified = self
            .verifier
            .verify_to_staging(artifact_path, envelope_document)?;
        self.install_verified(verified, permissions_approved, false)
    }

    pub(crate) fn get(&self, package_id: &str) -> Result<Option<InstalledPackageRecord>> {
        let conn = super::state::open(&self.state_home)?;
        read_record(&conn, package_id)
    }

    pub(crate) fn verified_active_manifests(&self) -> Result<Vec<AgentPackageManifest>> {
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let package_ids = {
            let mut statement = transaction
                .prepare("SELECT package_id FROM agent_package_registry ORDER BY package_id ASC")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut manifests = Vec::with_capacity(package_ids.len());
        for package_id in package_ids {
            let record = read_record(&transaction, &package_id)?
                .ok_or_else(|| anyhow!("Agent Package Registry changed while loading Catalog"))?;
            let active_dir = self.resolve_installed_path(&record.active.relative_path)?;
            let manifest =
                verify_installed_package_tree(&active_dir, &record.active.file_manifest_sha256)?;
            ensure_installed_identity(
                &manifest,
                &record.package_id,
                &record.agent_id,
                &record.active.version,
            )?;
            if manifest.requested_permissions != record.active.requested_permissions {
                bail!("installed Agent Package permissions differ from their approved Registry");
            }
            manifests.push(manifest);
        }
        transaction.commit()?;
        Ok(manifests)
    }

    pub(crate) fn rollback(&self, package_id: &str) -> Result<InstalledPackageRecord> {
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_record(&transaction, package_id)?
            .ok_or_else(|| anyhow!("Agent Package is not installed"))?;
        let previous = current
            .previous
            .clone()
            .ok_or_else(|| anyhow!("Agent Package has no previous version to roll back"))?;
        let previous_dir = self.resolve_installed_path(&previous.relative_path)?;
        let manifest =
            verify_installed_package_tree(&previous_dir, &previous.file_manifest_sha256)?;
        ensure_installed_identity(
            &manifest,
            &current.package_id,
            &current.agent_id,
            &previous.version,
        )?;

        let active_permissions = serde_json::to_string(&current.active.requested_permissions)?;
        let previous_permissions = serde_json::to_string(&previous.requested_permissions)?;
        let updated_at = now();
        transaction.execute(
            "UPDATE agent_package_registry SET \
             active_version = ?2, active_artifact_sha256 = ?3, \
             active_file_manifest_sha256 = ?4, active_relative_path = ?5, \
             active_permissions_json = ?6, active_signature_key_id = ?7, \
             previous_version = ?8, previous_artifact_sha256 = ?9, \
             previous_file_manifest_sha256 = ?10, previous_relative_path = ?11, \
             previous_permissions_json = ?12, previous_signature_key_id = ?13, updated_at = ?14 \
             WHERE package_id = ?1",
            params![
                package_id,
                previous.version,
                previous.artifact_sha256,
                previous.file_manifest_sha256,
                previous.relative_path,
                previous_permissions,
                previous.signature_key_id,
                current.active.version,
                current.active.artifact_sha256,
                current.active.file_manifest_sha256,
                current.active.relative_path,
                active_permissions,
                current.active.signature_key_id,
                updated_at
            ],
        )?;
        let rolled_back = read_record(&transaction, package_id)?
            .ok_or_else(|| anyhow!("rolled back Agent Package disappeared"))?;
        transaction.commit()?;
        Ok(rolled_back)
    }

    fn install_verified(
        &self,
        mut verified: VerifiedStagedPackage,
        permissions_approved: bool,
        fail_after_rename: bool,
    ) -> Result<PackageInstallResult> {
        let manifest = verified.manifest.clone();
        let current = self.get(&manifest.package_id)?;
        self.validate_identity_and_version(&manifest, &verified.artifact_sha256, current.as_ref())?;
        self.ensure_agent_id_available(&manifest.package_id, &manifest.agent.agent_id)?;

        if current
            .as_ref()
            .is_some_and(|record| record.active.artifact_sha256 == verified.artifact_sha256)
        {
            let current = current.expect("checked current Package");
            let active_dir = self.resolve_installed_path(&current.active.relative_path)?;
            let active_manifest =
                verify_installed_package_tree(&active_dir, &current.active.file_manifest_sha256)?;
            ensure_installed_identity(
                &active_manifest,
                &current.package_id,
                &current.agent_id,
                &current.active.version,
            )?;
            return Ok(PackageInstallResult::Installed {
                package: Box::new(current),
            });
        }

        let added_permissions = added_permissions(current.as_ref(), &manifest);
        if !added_permissions.is_empty() && !permissions_approved {
            return Ok(PackageInstallResult::ApprovalRequired {
                approval: PackageApprovalRequest {
                    package_id: manifest.package_id,
                    version: manifest.version,
                    added_permissions,
                },
            });
        }

        let expected_active_digest = current
            .as_ref()
            .map(|record| record.active.artifact_sha256.clone());
        let destination = self.new_version_destination(&manifest, &verified.artifact_sha256)?;
        sync_tree(verified.staging_path())?;
        fs::rename(verified.staging_path(), &destination)
            .context("atomically move verified Agent Package into immutable version storage")?;
        verified.disarm_staging_cleanup();
        sync_directory(
            destination
                .parent()
                .ok_or_else(|| anyhow!("installed Package has no parent directory"))?,
        )?;

        if fail_after_rename {
            bail!("injected Agent Package registry commit failure");
        }

        let relative_path = destination
            .strip_prefix(&self.package_root)
            .context("installed Package escaped Package root")?
            .to_string_lossy()
            .into_owned();
        let package = self.commit_registry(
            &manifest,
            &verified.artifact_sha256,
            &verified.file_manifest_sha256,
            &verified.signature_key_id,
            &relative_path,
            expected_active_digest.as_deref(),
        )?;
        Ok(PackageInstallResult::Installed {
            package: Box::new(package),
        })
    }

    fn validate_identity_and_version(
        &self,
        manifest: &AgentPackageManifest,
        artifact_sha256: &str,
        current: Option<&InstalledPackageRecord>,
    ) -> Result<()> {
        let Some(current) = current else {
            return Ok(());
        };
        if current.agent_id != manifest.agent.agent_id {
            bail!("Agent Package upgrade cannot change agentId");
        }
        let incoming = Version::parse(&manifest.version)?;
        let active = Version::parse(&current.active.version)?;
        match incoming.cmp_precedence(&active) {
            std::cmp::Ordering::Less => {
                bail!("Agent Package downgrade requires explicit rollback");
            }
            std::cmp::Ordering::Equal
                if incoming != active || current.active.artifact_sha256 != artifact_sha256 =>
            {
                bail!(
                    "Agent Package SemVer precedence is immutable and cannot change build metadata or artifact digest"
                );
            }
            _ => {}
        }
        Ok(())
    }

    fn ensure_agent_id_available(&self, package_id: &str, agent_id: &str) -> Result<()> {
        let conn = super::state::open(&self.state_home)?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT package_id FROM agent_package_registry WHERE agent_id = ?1",
                [agent_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_some_and(|existing| existing != package_id) {
            bail!("agentId is already owned by another installed Package");
        }
        Ok(())
    }

    fn new_version_destination(
        &self,
        manifest: &AgentPackageManifest,
        artifact_sha256: &str,
    ) -> Result<PathBuf> {
        create_private_dir(&self.package_root)?;
        let parent = self
            .package_root
            .join("versions")
            .join(&manifest.package_id)
            .join(&manifest.version);
        create_private_dir(&parent)?;
        Ok(parent.join(format!("{}-{}", artifact_sha256, Uuid::now_v7())))
    }

    fn commit_registry(
        &self,
        manifest: &AgentPackageManifest,
        artifact_sha256: &str,
        file_manifest_sha256: &str,
        signature_key_id: &str,
        relative_path: &str,
        expected_active_digest: Option<&str>,
    ) -> Result<InstalledPackageRecord> {
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_record(&transaction, &manifest.package_id)?;
        if current
            .as_ref()
            .map(|record| record.active.artifact_sha256.as_str())
            != expected_active_digest
        {
            bail!("Agent Package Active version changed during installation");
        }
        if current
            .as_ref()
            .is_some_and(|record| record.agent_id != manifest.agent.agent_id)
        {
            bail!("Agent Package upgrade cannot change agentId");
        }
        let conflicting_package: Option<String> = transaction
            .query_row(
                "SELECT package_id FROM agent_package_registry \
                 WHERE agent_id = ?1 AND package_id <> ?2",
                params![manifest.agent.agent_id, manifest.package_id],
                |row| row.get(0),
            )
            .optional()?;
        if conflicting_package.is_some() {
            bail!("agentId is already owned by another installed Package");
        }

        let permissions = serde_json::to_string(&manifest.requested_permissions)?;
        let updated_at = now();
        if let Some(current) = current {
            let previous_permissions =
                serde_json::to_string(&current.active.requested_permissions)?;
            transaction.execute(
                "UPDATE agent_package_registry SET agent_id = ?2, \
                 active_version = ?3, active_artifact_sha256 = ?4, \
                 active_file_manifest_sha256 = ?5, active_relative_path = ?6, \
                 active_permissions_json = ?7, active_signature_key_id = ?8, \
                 previous_version = ?9, previous_artifact_sha256 = ?10, \
                 previous_file_manifest_sha256 = ?11, previous_relative_path = ?12, \
                 previous_permissions_json = ?13, previous_signature_key_id = ?14, \
                 updated_at = ?15 WHERE package_id = ?1",
                params![
                    manifest.package_id,
                    manifest.agent.agent_id,
                    manifest.version,
                    artifact_sha256,
                    file_manifest_sha256,
                    relative_path,
                    permissions,
                    signature_key_id,
                    current.active.version,
                    current.active.artifact_sha256,
                    current.active.file_manifest_sha256,
                    current.active.relative_path,
                    previous_permissions,
                    current.active.signature_key_id,
                    updated_at,
                ],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO agent_package_registry (
                   package_id, agent_id, active_version, active_artifact_sha256,
                   active_file_manifest_sha256, active_relative_path, active_permissions_json,
                   active_signature_key_id, installed_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    manifest.package_id,
                    manifest.agent.agent_id,
                    manifest.version,
                    artifact_sha256,
                    file_manifest_sha256,
                    relative_path,
                    permissions,
                    signature_key_id,
                    updated_at,
                ],
            )?;
        }
        let installed = read_record(&transaction, &manifest.package_id)?
            .ok_or_else(|| anyhow!("installed Agent Package disappeared"))?;
        transaction.commit()?;
        Ok(installed)
    }

    fn resolve_installed_path(&self, relative_path: &str) -> Result<PathBuf> {
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || relative.components().next() != Some(Component::Normal("versions".as_ref()))
        {
            bail!("installed Agent Package path is invalid");
        }
        let resolved = self.package_root.join(relative);
        if !resolved.is_dir() {
            bail!("installed Agent Package directory is missing");
        }
        Ok(resolved)
    }

    #[cfg(test)]
    fn install_verified_for_test(
        &self,
        verified: VerifiedStagedPackage,
        permissions_approved: bool,
    ) -> Result<PackageInstallResult> {
        self.install_verified(verified, permissions_approved, false)
    }

    #[cfg(test)]
    fn install_verified_with_interruption_for_test(
        &self,
        verified: VerifiedStagedPackage,
    ) -> Result<PackageInstallResult> {
        self.install_verified(verified, true, true)
    }
}

#[derive(Debug)]
struct RawInstalledPackageRecord {
    package_id: String,
    agent_id: String,
    active_version: String,
    active_artifact_sha256: String,
    active_file_manifest_sha256: String,
    active_relative_path: String,
    active_permissions_json: String,
    active_signature_key_id: String,
    previous_version: Option<String>,
    previous_artifact_sha256: Option<String>,
    previous_file_manifest_sha256: Option<String>,
    previous_relative_path: Option<String>,
    previous_permissions_json: Option<String>,
    previous_signature_key_id: Option<String>,
    installed_at: String,
    updated_at: String,
}

fn read_record(conn: &Connection, package_id: &str) -> Result<Option<InstalledPackageRecord>> {
    let raw = conn
        .query_row(
            "SELECT package_id, agent_id, active_version, active_artifact_sha256, \
             active_file_manifest_sha256, active_relative_path, active_permissions_json, \
             active_signature_key_id, previous_version, previous_artifact_sha256, \
             previous_file_manifest_sha256, previous_relative_path, previous_permissions_json, \
             previous_signature_key_id, installed_at, updated_at \
             FROM agent_package_registry WHERE package_id = ?1",
            [package_id],
            |row| {
                Ok(RawInstalledPackageRecord {
                    package_id: row.get(0)?,
                    agent_id: row.get(1)?,
                    active_version: row.get(2)?,
                    active_artifact_sha256: row.get(3)?,
                    active_file_manifest_sha256: row.get(4)?,
                    active_relative_path: row.get(5)?,
                    active_permissions_json: row.get(6)?,
                    active_signature_key_id: row.get(7)?,
                    previous_version: row.get(8)?,
                    previous_artifact_sha256: row.get(9)?,
                    previous_file_manifest_sha256: row.get(10)?,
                    previous_relative_path: row.get(11)?,
                    previous_permissions_json: row.get(12)?,
                    previous_signature_key_id: row.get(13)?,
                    installed_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            },
        )
        .optional()?;
    raw.map(parse_record).transpose()
}

fn parse_record(raw: RawInstalledPackageRecord) -> Result<InstalledPackageRecord> {
    let active = InstalledPackageVersion {
        version: raw.active_version,
        artifact_sha256: raw.active_artifact_sha256,
        file_manifest_sha256: raw.active_file_manifest_sha256,
        relative_path: raw.active_relative_path,
        requested_permissions: serde_json::from_str(&raw.active_permissions_json)
            .context("parse Active Agent Package permissions")?,
        signature_key_id: raw.active_signature_key_id,
    };
    let previous = match (
        raw.previous_version,
        raw.previous_artifact_sha256,
        raw.previous_file_manifest_sha256,
        raw.previous_relative_path,
        raw.previous_permissions_json,
        raw.previous_signature_key_id,
    ) {
        (None, None, None, None, None, None) => None,
        (
            Some(version),
            Some(artifact_sha256),
            Some(file_manifest_sha256),
            Some(relative_path),
            Some(permissions),
            Some(key),
        ) => Some(InstalledPackageVersion {
            version,
            artifact_sha256,
            file_manifest_sha256,
            relative_path,
            requested_permissions: serde_json::from_str(&permissions)
                .context("parse Previous Agent Package permissions")?,
            signature_key_id: key,
        }),
        _ => bail!("Agent Package Registry previous version is incomplete"),
    };
    Ok(InstalledPackageRecord {
        package_id: raw.package_id,
        agent_id: raw.agent_id,
        active,
        previous,
        installed_at: raw.installed_at,
        updated_at: raw.updated_at,
    })
}

fn added_permissions(
    current: Option<&InstalledPackageRecord>,
    manifest: &AgentPackageManifest,
) -> Vec<String> {
    let current = current
        .map(|record| {
            record
                .active
                .requested_permissions
                .iter()
                .map(|permission| permission.as_str())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    manifest
        .requested_permissions
        .iter()
        .map(|permission| permission.as_str())
        .filter(|permission| !current.contains(permission))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn ensure_installed_identity(
    manifest: &AgentPackageManifest,
    package_id: &str,
    agent_id: &str,
    version: &str,
) -> Result<()> {
    if manifest.package_id != package_id
        || manifest.agent.agent_id != agent_id
        || manifest.version != version
    {
        bail!("installed Agent Package identity is invalid");
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .with_context(|| format!("create Package directory {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("secure Package directory {}", path.display()))?;
    }
    Ok(())
}

fn sync_tree(root: &Path) -> Result<()> {
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.context("walk verified Agent Package staging")?;
        if entry.file_type().is_symlink() {
            bail!("verified Agent Package staging unexpectedly contains a symlink");
        }
        if entry.file_type().is_file() {
            File::open(entry.path())
                .with_context(|| format!("open staged Package file {}", entry.path().display()))?
                .sync_all()
                .with_context(|| format!("sync staged Package file {}", entry.path().display()))?;
        }
    }
    sync_directory(root)
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)
        .with_context(|| format!("open Package directory {}", path.display()))?
        .sync_all()
        .with_context(|| format!("sync Package directory {}", path.display()))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::agentmesh360::model_policy::CapabilityRequirement;
    use crate::agentmesh360::registry::{AgentRegistry, stable_main_session_id};

    const JOB_MANIFEST: &str = include_str!("packages/job-agent/agentmesh-agent.toml");
    const JOB_PACKAGE_ID: &str = "com.agentmesh360.job-agent";

    #[test]
    fn initial_install_requires_permission_approval_then_commits_active() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = service(temp.path());

        let request = service
            .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), false)
            .expect("approval result");
        let PackageInstallResult::ApprovalRequired { approval } = request else {
            panic!("expected approval");
        };
        assert_eq!(approval.package_id, JOB_PACKAGE_ID);
        assert_eq!(
            approval.added_permissions,
            [
                "browser_control",
                "external_actions",
                "local_files",
                "network_access"
            ]
        );
        assert!(service.get(JOB_PACKAGE_ID).expect("registry").is_none());

        let installed = installed(
            service
                .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), true)
                .expect("install"),
        );

        assert_eq!(installed.active.version, "0.4.7");
        assert!(installed.previous.is_none());
        assert!(
            temp.path()
                .join("packages")
                .join(&installed.active.relative_path)
                .is_dir()
        );
    }

    #[test]
    fn upgrade_requires_only_added_permission_and_preserves_previous_for_rollback() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = service(temp.path());
        installed(
            service
                .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), true)
                .expect("install first"),
        );
        let upgrade = upgraded_manifest();

        let request = service
            .install_verified_for_test(verified(temp.path(), &upgrade, 'b'), false)
            .expect("approval result");
        let PackageInstallResult::ApprovalRequired { approval } = request else {
            panic!("expected approval");
        };
        assert_eq!(approval.added_permissions, ["process_execution"]);
        assert_eq!(
            service
                .get(JOB_PACKAGE_ID)
                .expect("registry")
                .expect("active")
                .active
                .version,
            "0.4.7"
        );

        let upgraded = installed(
            service
                .install_verified_for_test(verified(temp.path(), &upgrade, 'b'), true)
                .expect("upgrade"),
        );
        assert_eq!(upgraded.active.version, "0.4.8");
        assert_eq!(
            upgraded
                .previous
                .as_ref()
                .map(|version| version.version.as_str()),
            Some("0.4.7")
        );

        let rolled_back = service.rollback(JOB_PACKAGE_ID).expect("rollback");
        assert_eq!(rolled_back.active.version, "0.4.7");
        assert_eq!(
            rolled_back
                .previous
                .as_ref()
                .map(|version| version.version.as_str()),
            Some("0.4.8")
        );
        assert_eq!(rolled_back.agent_id, "job-agent");
    }

    #[test]
    fn interrupted_registry_commit_leaves_old_active_unchanged() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = service(temp.path());
        installed(
            service
                .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), true)
                .expect("install first"),
        );

        let error = service
            .install_verified_with_interruption_for_test(verified(
                temp.path(),
                &upgraded_manifest(),
                'b',
            ))
            .expect_err("interrupted commit");

        assert!(error.to_string().contains("injected"));
        let active = service
            .get(JOB_PACKAGE_ID)
            .expect("registry")
            .expect("active");
        assert_eq!(active.active.version, "0.4.7");
        assert!(active.previous.is_none());
        let version_dirs = WalkDir::new(temp.path().join("packages").join("versions"))
            .min_depth(3)
            .max_depth(3)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_dir())
            .count();
        assert_eq!(version_dirs, 2, "new version may remain only as an orphan");
    }

    #[test]
    fn upgrade_cannot_change_stable_agent_identity_or_rewrite_same_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = service(temp.path());
        installed(
            service
                .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), true)
                .expect("install first"),
        );

        let changed_agent =
            upgraded_manifest().replacen("agentId = \"job-agent\"", "agentId = \"other-agent\"", 1);
        let identity_error = service
            .install_verified_for_test(verified(temp.path(), &changed_agent, 'b'), true)
            .expect_err("changed agent id");
        assert!(identity_error.to_string().contains("agentId"));

        let digest_error = service
            .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'c'), true)
            .expect_err("same version new digest");
        assert!(digest_error.to_string().contains("immutable"));

        let build_metadata =
            JOB_MANIFEST.replacen("version = \"0.4.7\"", "version = \"0.4.7+replacement\"", 1);
        let build_metadata_error = service
            .install_verified_for_test(verified(temp.path(), &build_metadata, 'd'), true)
            .expect_err("same precedence with new build metadata");
        assert!(
            build_metadata_error
                .to_string()
                .contains("SemVer precedence")
        );

        let downgrade = JOB_MANIFEST.replacen("version = \"0.4.7\"", "version = \"0.4.6\"", 1);
        let downgrade_error = service
            .install_verified_for_test(verified(temp.path(), &downgrade, 'e'), true)
            .expect_err("implicit downgrade");
        assert!(downgrade_error.to_string().contains("explicit rollback"));
    }

    #[test]
    fn rollback_rejects_tampered_previous_content_or_inventory_without_changing_active() {
        for tamper_inventory in [false, true] {
            let temp = tempfile::tempdir().expect("tempdir");
            let service = service(temp.path());
            installed(
                service
                    .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), true)
                    .expect("install first"),
            );
            installed(
                service
                    .install_verified_for_test(
                        verified(temp.path(), &upgraded_manifest(), 'b'),
                        true,
                    )
                    .expect("upgrade"),
            );
            let before = service
                .get(JOB_PACKAGE_ID)
                .expect("registry")
                .expect("installed record");
            let previous = before.previous.as_ref().expect("previous");
            let previous_dir = temp.path().join("packages").join(&previous.relative_path);
            let tampered_path = if tamper_inventory {
                previous_dir.join(FILE_MANIFEST_PATH)
            } else {
                previous_dir.join("docs/agent-onboarding.md")
            };
            let tampered_contents: &[u8] = if tamper_inventory {
                b"tampered after verified install"
            } else {
                b"# Bad Agent workflow\n"
            };
            fs::write(&tampered_path, tampered_contents).expect("tamper previous package");

            let error = service
                .rollback(JOB_PACKAGE_ID)
                .expect_err("tampered previous must not become Active");
            assert!(error.to_string().contains("digest"));
            assert_eq!(
                service
                    .get(JOB_PACKAGE_ID)
                    .expect("registry")
                    .expect("installed record"),
                before
            );
        }
    }

    #[test]
    fn idempotent_reinstall_rejects_tampered_active_content() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = service(temp.path());
        let before = installed(
            service
                .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), true)
                .expect("install"),
        );
        let active_dir = temp
            .path()
            .join("packages")
            .join(&before.active.relative_path);
        fs::write(
            active_dir.join("docs/agent-onboarding.md"),
            b"# Bad Agent workflow\n",
        )
        .expect("tamper Active Package");

        let error = service
            .install_verified_for_test(verified(temp.path(), JOB_MANIFEST, 'a'), true)
            .expect_err("tampered idempotent install");
        assert!(error.to_string().contains("digest"));
        assert_eq!(
            service
                .get(JOB_PACKAGE_ID)
                .expect("registry")
                .expect("installed record"),
            before
        );
    }

    #[test]
    fn runtime_catalog_loads_verified_active_upgrade_and_new_agent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = service(temp.path());
        installed(
            service
                .install_verified_for_test(
                    verified(temp.path(), &runtime_upgrade_manifest(), 'b'),
                    true,
                )
                .expect("install upgraded Job Agent"),
        );
        installed(
            service
                .install_verified_for_test(verified(temp.path(), &new_agent_manifest(), 'c'), true)
                .expect("install new Agent"),
        );

        let registry = AgentRegistry::in_home(temp.path());
        let catalog = registry.package_catalog().expect("runtime Catalog");
        assert_eq!(catalog.packages.len(), 4);
        assert_eq!(
            catalog
                .package_for_agent("job-agent")
                .expect("Job Agent")
                .version,
            "0.4.8"
        );
        assert!(
            catalog.package_for_agent("research-agent").is_ok(),
            "new verified Agent is present"
        );
        assert!(
            registry
                .agent_definition("job-agent")
                .expect("runtime Agent definition")
                .prompt_body
                .as_deref()
                .is_some_and(|prompt| prompt.contains("Runtime Upgraded Job Agent"))
        );
        assert_eq!(
            registry
                .model_policy("job-agent")
                .expect("runtime Model Policy")
                .tools,
            CapabilityRequirement::Required
        );
        let activated = registry
            .prepare_activation(41, "research-agent")
            .expect("activate dynamic Agent");
        let expected_session = stable_main_session_id(41, "research-agent").to_string();
        assert_eq!(
            activated.main_session_id.as_deref(),
            Some(expected_session.as_str())
        );
        assert_eq!(registry.list(41).expect("runtime Agents").len(), 4);
    }

    #[test]
    fn runtime_catalog_fails_closed_for_tampered_or_conflicting_active_package() {
        let tampered_home = tempfile::tempdir().expect("tempdir");
        let tampered_service = service(tampered_home.path());
        let installed_package = installed(
            tampered_service
                .install_verified_for_test(
                    verified(tampered_home.path(), &upgraded_manifest(), 'b'),
                    true,
                )
                .expect("install upgraded Job Agent"),
        );
        fs::write(
            tampered_home
                .path()
                .join("packages")
                .join(installed_package.active.relative_path)
                .join("docs/agent-onboarding.md"),
            b"# Bad Agent workflow\n",
        )
        .expect("tamper Active Package");
        let tampered_registry = AgentRegistry::in_home(tampered_home.path());
        assert!(
            tampered_registry
                .package_catalog()
                .expect_err("tampered Active Package")
                .to_string()
                .contains("digest")
        );

        let conflict_home = tempfile::tempdir().expect("tempdir");
        let conflict_service = service(conflict_home.path());
        installed(
            conflict_service
                .install_verified_for_test(
                    verified(conflict_home.path(), &conflicting_agent_manifest(), 'c'),
                    true,
                )
                .expect("install conflicting Package"),
        );
        let conflicting_registry = AgentRegistry::in_home(conflict_home.path());
        assert!(
            conflicting_registry
                .package_catalog()
                .expect_err("agentId conflict")
                .to_string()
                .contains("conflicts")
        );
    }

    fn service(state_home: &Path) -> PackageInstallService {
        // The transaction tests start after H1a verification, so no production or test signing
        // key is needed here.
        PackageInstallService::with_trust_store(state_home, TrustedPublisherStore::default())
    }

    fn verified(state_home: &Path, document: &str, digest_byte: char) -> VerifiedStagedPackage {
        let manifest = AgentPackageCatalog::parse_document(document).expect("manifest");
        let staging_dir =
            state_home
                .join("test-staging")
                .join(format!("{}-{}", digest_byte, Uuid::now_v7()));
        fs::create_dir_all(&staging_dir).expect("staging");
        write_test_package_tree(&staging_dir, document);
        VerifiedStagedPackage::for_test(
            manifest,
            digest_byte.to_string().repeat(64),
            "agentmesh360-test-2026",
            staging_dir,
        )
    }

    fn write_test_package_tree(staging_dir: &Path, document: &str) {
        let files = [
            (PACKAGE_MANIFEST_PATH, document.as_bytes()),
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

    fn upgraded_manifest() -> String {
        JOB_MANIFEST
            .replacen("version = \"0.4.7\"", "version = \"0.4.8\"", 1)
            .replacen(
                "  \"network_access\",\n]",
                "  \"network_access\",\n  \"process_execution\",\n]",
                1,
            )
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

    fn runtime_upgrade_manifest() -> String {
        upgraded_manifest()
            .replacen("You are Job Agent", "You are Runtime Upgraded Job Agent", 1)
            .replacen("tools = \"preferred\"", "tools = \"required\"", 1)
    }

    fn conflicting_agent_manifest() -> String {
        JOB_MANIFEST.replacen(
            "packageId = \"com.agentmesh360.job-agent\"",
            "packageId = \"com.example.job-agent\"",
            1,
        )
    }

    fn installed(result: PackageInstallResult) -> InstalledPackageRecord {
        let PackageInstallResult::Installed { package } = result else {
            panic!("expected installed Package");
        };
        *package
    }
}
