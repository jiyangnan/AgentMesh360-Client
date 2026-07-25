use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest as _, Sha256};

use super::access::ClientAccess;
use super::package_registry_snapshot::{
    PackageRegistrySnapshotVerifier, RemotePackageRecord, VerifiedPackageRegistrySnapshot,
};
use super::package_trust::{TrustedPublisherStore, TrustedRootStore};
use super::state;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageTrustCacheAudit {
    pub root_key_id: String,
    pub trust_sequence: u64,
    pub trust_expires_at: DateTime<Utc>,
    pub registry_revision: u64,
    pub registry_expires_at: DateTime<Utc>,
    pub package_count: usize,
    pub verified_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedRemotePackageCatalog {
    pub registry_revision: u64,
    pub registry_expires_at: DateTime<Utc>,
    pub packages: Vec<RemotePackageSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemotePackageSummary {
    pub package_id: String,
    pub agent_id: String,
    pub version: String,
    pub publisher: String,
}

#[derive(Clone)]
pub(crate) struct PackageTrustCacheStore {
    state_home: PathBuf,
    roots: TrustedRootStore,
}

impl PackageTrustCacheStore {
    pub(crate) fn in_home(state_home: impl Into<PathBuf>) -> Self {
        Self {
            state_home: state_home.into(),
            roots: TrustedRootStore::embedded(),
        }
    }

    #[cfg(test)]
    pub(super) fn in_home_with_roots(
        state_home: impl Into<PathBuf>,
        roots: TrustedRootStore,
    ) -> Self {
        Self {
            state_home: state_home.into(),
            roots,
        }
    }

    pub(crate) fn accept_documents(
        &self,
        trust_document: &str,
        registry_document: &str,
        access: &ClientAccess,
    ) -> Result<PackageTrustCacheAudit> {
        self.accept_conditional_documents(Some(trust_document), Some(registry_document), access)
    }

    pub(super) fn accept_conditional_documents(
        &self,
        trust_document: Option<&str>,
        registry_document: Option<&str>,
        access: &ClientAccess,
    ) -> Result<PackageTrustCacheAudit> {
        let mut connection = state::open(&self.state_home)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("start Agent Package trust cache update")?;
        let current = read_cached_row(&transaction)?;
        let trust_document = trust_document
            .or_else(|| current.as_ref().map(|row| row.trust_document.as_str()))
            .ok_or_else(|| anyhow!("Agent Package publisher trust cache is unavailable"))?;
        let registry_document = registry_document
            .or_else(|| current.as_ref().map(|row| row.registry_document.as_str()))
            .ok_or_else(|| anyhow!("Agent Package registry cache is unavailable"))?;
        let minimum_sequence = current
            .as_ref()
            .map(|row| positive_u64("trust sequence", row.trust_sequence))
            .transpose()?
            .unwrap_or(1);
        let minimum_revision = current
            .as_ref()
            .map(|row| positive_u64("registry revision", row.registry_revision))
            .transpose()?
            .unwrap_or(1);

        let trusted_publishers = TrustedPublisherStore::from_signed_bundle(
            trust_document,
            &self.roots,
            access,
            minimum_sequence,
        )
        .context("verify Agent Package publisher trust before caching")?;
        let registry = PackageRegistrySnapshotVerifier::with_roots(self.roots.clone())
            .verify_document(
                registry_document,
                access,
                minimum_revision,
                &trusted_publishers,
            )
            .context("verify Agent Package registry before caching")?;
        let trust_document_sha256 = sha256_hex(trust_document.as_bytes());
        let registry_document_sha256 = sha256_hex(registry_document.as_bytes());
        let trust_audit = trusted_publishers.audit();
        let root_key_id = trust_audit
            .root_key_id
            .ok_or_else(|| anyhow!("verified Agent Package publisher trust has no root"))?;
        let trust_expires_at = trust_audit
            .expires_at
            .ok_or_else(|| anyhow!("verified Agent Package publisher trust has no expiry"))?;

        if let Some(current) = &current {
            reject_equivocation(
                "publisher trust",
                trust_audit.trust_sequence,
                positive_u64("trust sequence", current.trust_sequence)?,
                &trust_document_sha256,
                &current.trust_document_sha256,
            )?;
            reject_equivocation(
                "registry",
                registry.revision,
                positive_u64("registry revision", current.registry_revision)?,
                &registry_document_sha256,
                &current.registry_document_sha256,
            )?;
        }

        if registry.root_key_id != root_key_id
            || registry.trust_bundle_sequence != trust_audit.trust_sequence
        {
            bail!("verified Agent Package trust and registry binding split");
        }
        let verified_at = access
            .trusted_server_now()
            .context("Agent Package trust cache write requires fresh Core server time")?;
        let verified_at = parse_timestamp("verification time", &format_timestamp(verified_at))?;
        let verified_at_text = format_timestamp(verified_at);
        transaction
            .execute(
                "INSERT INTO package_trust_cache (
                   singleton_id, root_key_id, trust_sequence, trust_document,
                   trust_document_sha256, trust_expires_at, registry_revision,
                   registry_document, registry_document_sha256, registry_expires_at,
                   verified_at, updated_at
                 ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
                 ON CONFLICT(singleton_id) DO UPDATE SET
                   root_key_id = excluded.root_key_id,
                   trust_sequence = excluded.trust_sequence,
                   trust_document = excluded.trust_document,
                   trust_document_sha256 = excluded.trust_document_sha256,
                   trust_expires_at = excluded.trust_expires_at,
                   registry_revision = excluded.registry_revision,
                   registry_document = excluded.registry_document,
                   registry_document_sha256 = excluded.registry_document_sha256,
                   registry_expires_at = excluded.registry_expires_at,
                   verified_at = excluded.verified_at,
                   updated_at = excluded.updated_at",
                params![
                    root_key_id,
                    positive_i64("trust sequence", trust_audit.trust_sequence)?,
                    trust_document,
                    trust_document_sha256,
                    format_timestamp(trust_expires_at),
                    positive_i64("registry revision", registry.revision)?,
                    registry_document,
                    registry_document_sha256,
                    format_timestamp(registry.expires_at),
                    verified_at_text,
                ],
            )
            .context("persist verified Agent Package trust cache")?;
        transaction
            .commit()
            .context("commit Agent Package trust cache update")?;

        cache_audit(root_key_id, &trusted_publishers, &registry, verified_at)
    }

    pub(crate) fn load_verified_audit(
        &self,
        access: &ClientAccess,
    ) -> Result<Option<PackageTrustCacheAudit>> {
        self.load_verified(access)
            .map(|verified| verified.map(|verified| verified.audit))
    }

    pub(super) fn load_verified_package(
        &self,
        package_id: &str,
        access: &ClientAccess,
    ) -> Result<Option<VerifiedRemotePackage>> {
        let Some(verified) = self.load_verified(access)? else {
            return Ok(None);
        };
        let record = verified
            .registry
            .packages
            .into_iter()
            .find(|record| record.package_id == package_id);
        Ok(record.map(|record| VerifiedRemotePackage {
            record,
            trusted_publishers: verified.trusted_publishers,
        }))
    }

    pub(crate) fn load_verified_catalog(
        &self,
        access: &ClientAccess,
    ) -> Result<Option<VerifiedRemotePackageCatalog>> {
        self.load_verified(access).map(|verified| {
            verified.map(|verified| VerifiedRemotePackageCatalog {
                registry_revision: verified.registry.revision,
                registry_expires_at: verified.registry.expires_at,
                packages: verified
                    .registry
                    .packages
                    .into_iter()
                    .map(|record| RemotePackageSummary {
                        package_id: record.package_id,
                        agent_id: record.agent_id,
                        version: record.version,
                        publisher: record.publisher,
                    })
                    .collect(),
            })
        })
    }

    fn load_verified(&self, access: &ClientAccess) -> Result<Option<VerifiedPackageTrustCache>> {
        let connection = state::open(&self.state_home)?;
        let Some(cached) = read_cached_row(&connection)? else {
            return Ok(None);
        };
        if sha256_hex(cached.trust_document.as_bytes()) != cached.trust_document_sha256
            || sha256_hex(cached.registry_document.as_bytes()) != cached.registry_document_sha256
        {
            bail!("Agent Package trust cache document digest mismatch");
        }

        let trust_sequence = positive_u64("trust sequence", cached.trust_sequence)?;
        let registry_revision = positive_u64("registry revision", cached.registry_revision)?;
        let trusted_publishers = TrustedPublisherStore::from_signed_bundle(
            &cached.trust_document,
            &self.roots,
            access,
            trust_sequence,
        )
        .context("reverify cached Agent Package publisher trust")?;
        let registry = PackageRegistrySnapshotVerifier::with_roots(self.roots.clone())
            .verify_document(
                &cached.registry_document,
                access,
                registry_revision,
                &trusted_publishers,
            )
            .context("reverify cached Agent Package registry")?;
        let trust_audit = trusted_publishers.audit();
        let trust_expires_at = parse_timestamp("trust expiry", &cached.trust_expires_at)?;
        let registry_expires_at = parse_timestamp("registry expiry", &cached.registry_expires_at)?;
        let verified_at = parse_timestamp("verification time", &cached.verified_at)?;
        let updated_at = parse_timestamp("update time", &cached.updated_at)?;

        if trust_audit.trust_sequence != trust_sequence
            || trust_audit.root_key_id.as_deref() != Some(cached.root_key_id.as_str())
            || trust_audit.expires_at != Some(trust_expires_at)
            || registry.revision != registry_revision
            || registry.root_key_id != cached.root_key_id
            || registry.trust_bundle_sequence != trust_sequence
            || registry.expires_at != registry_expires_at
            || updated_at != verified_at
        {
            bail!("Agent Package trust cache metadata does not match signed documents");
        }

        let audit = cache_audit(
            cached.root_key_id,
            &trusted_publishers,
            &registry,
            verified_at,
        )?;
        Ok(Some(VerifiedPackageTrustCache {
            audit,
            trusted_publishers,
            registry,
        }))
    }
}

pub(super) struct VerifiedRemotePackage {
    pub record: RemotePackageRecord,
    pub trusted_publishers: TrustedPublisherStore,
}

struct VerifiedPackageTrustCache {
    audit: PackageTrustCacheAudit,
    trusted_publishers: TrustedPublisherStore,
    registry: VerifiedPackageRegistrySnapshot,
}

fn cache_audit(
    root_key_id: String,
    trusted_publishers: &TrustedPublisherStore,
    registry: &VerifiedPackageRegistrySnapshot,
    verified_at: DateTime<Utc>,
) -> Result<PackageTrustCacheAudit> {
    let trust = trusted_publishers.audit();
    Ok(PackageTrustCacheAudit {
        root_key_id,
        trust_sequence: trust.trust_sequence,
        trust_expires_at: trust
            .expires_at
            .ok_or_else(|| anyhow!("verified Agent Package publisher trust has no expiry"))?,
        registry_revision: registry.revision,
        registry_expires_at: registry.expires_at,
        package_count: registry.packages.len(),
        verified_at,
    })
}

#[derive(Debug)]
struct CachedTrustRow {
    root_key_id: String,
    trust_sequence: i64,
    trust_document: String,
    trust_document_sha256: String,
    trust_expires_at: String,
    registry_revision: i64,
    registry_document: String,
    registry_document_sha256: String,
    registry_expires_at: String,
    verified_at: String,
    updated_at: String,
}

impl CachedTrustRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            root_key_id: row.get(0)?,
            trust_sequence: row.get(1)?,
            trust_document: row.get(2)?,
            trust_document_sha256: row.get(3)?,
            trust_expires_at: row.get(4)?,
            registry_revision: row.get(5)?,
            registry_document: row.get(6)?,
            registry_document_sha256: row.get(7)?,
            registry_expires_at: row.get(8)?,
            verified_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    }
}

fn read_cached_row(connection: &rusqlite::Connection) -> Result<Option<CachedTrustRow>> {
    connection
        .query_row(
            "SELECT root_key_id, trust_sequence, trust_document, trust_document_sha256,
                    trust_expires_at, registry_revision, registry_document,
                    registry_document_sha256, registry_expires_at, verified_at, updated_at
             FROM package_trust_cache WHERE singleton_id = 1",
            [],
            CachedTrustRow::from_row,
        )
        .optional()
        .context("read Agent Package trust cache")
}

fn reject_equivocation(
    subject: &str,
    accepted: u64,
    current: u64,
    accepted_digest: &str,
    current_digest: &str,
) -> Result<()> {
    if accepted == current && accepted_digest != current_digest {
        bail!("Agent Package {subject} equivocation at the accepted version");
    }
    Ok(())
}

fn positive_u64(field: &str, value: i64) -> Result<u64> {
    let value = u64::try_from(value)
        .with_context(|| format!("Agent Package trust cache {field} invalid"))?;
    if value == 0 {
        bail!("Agent Package trust cache {field} invalid");
    }
    Ok(value)
}

fn positive_i64(field: &str, value: u64) -> Result<i64> {
    let value = i64::try_from(value)
        .with_context(|| format!("Agent Package trust cache {field} too large"))?;
    if value == 0 {
        bail!("Agent Package trust cache {field} invalid");
    }
    Ok(value)
}

fn parse_timestamp(field: &str, value: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("Agent Package trust cache {field} invalid"))
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn format_timestamp(timestamp: DateTime<Utc>) -> String {
    timestamp.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut encoded, byte| {
            write!(&mut encoded, "{byte:02x}").expect("write SHA-256 hex");
            encoded
        })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone as _;
    use ed25519_dalek::SigningKey;

    use super::super::package_registry_snapshot::signed_registry_document_for_test;
    use super::super::package_trust::{TrustedRootKey, signed_bundle_document_for_test};
    use super::*;

    const ROOT_KEY_ID: &str = "agentmesh360-root-test-2026";

    #[test]
    fn accepts_and_reverifies_a_redacted_last_known_good_cache() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = SigningKey::from_bytes(&[51_u8; 32]);
        let roots = roots(&root);
        let store = PackageTrustCacheStore::in_home_with_roots(temp.path(), roots.clone());
        let current_access = access();
        let trust = trust_document(&root, 7, "2026-08-01T00:00:00Z", 61);
        let registry = registry_document(&root, 42, 7, '1');

        let accepted = store
            .accept_documents(&trust, &registry, &current_access)
            .expect("accept signed package trust");
        assert_eq!(
            accepted,
            PackageTrustCacheAudit {
                root_key_id: ROOT_KEY_ID.into(),
                trust_sequence: 7,
                trust_expires_at: timestamp(2026, 8, 1, 0, 0, 0),
                registry_revision: 42,
                registry_expires_at: timestamp(2026, 8, 1, 0, 0, 0),
                package_count: 1,
                verified_at: timestamp(2026, 7, 24, 12, 0, 0),
            }
        );
        let audit_debug = format!("{accepted:?}");
        assert!(!audit_debug.contains("https://"));
        assert!(!audit_debug.contains("document"));
        assert!(!audit_debug.contains(temp.path().to_string_lossy().as_ref()));

        let restarted = PackageTrustCacheStore::in_home_with_roots(temp.path(), roots);
        assert_eq!(
            restarted
                .load_verified_audit(&current_access)
                .expect("load cache after restart"),
            Some(accepted)
        );
        let catalog = restarted
            .load_verified_catalog(&current_access)
            .expect("load verified remote catalog")
            .expect("verified remote catalog");
        assert_eq!(
            catalog,
            VerifiedRemotePackageCatalog {
                registry_revision: 42,
                registry_expires_at: timestamp(2026, 8, 1, 0, 0, 0),
                packages: vec![RemotePackageSummary {
                    package_id: "job-agent".into(),
                    agent_id: "job-agent".into(),
                    version: "1.2.0".into(),
                    publisher: "agentmesh360".into(),
                }],
            }
        );
        let catalog_json = serde_json::to_string(&catalog).expect("serialize remote catalog");
        for private_field in [
            "artifactUrl",
            "artifactSha256",
            "envelopeUrl",
            "envelopeSha256",
            "rootKeyId",
            "signature",
            "https://",
        ] {
            assert!(!catalog_json.contains(private_field));
        }
        let connection = state::open(temp.path()).expect("open cache database");
        let rows: u32 = connection
            .query_row("SELECT COUNT(*) FROM package_trust_cache", [], |row| {
                row.get(0)
            })
            .expect("cache row count");
        assert_eq!(rows, 1);
    }

    #[test]
    fn rejects_rollback_and_equivocation_without_replacing_last_known_good() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = SigningKey::from_bytes(&[51_u8; 32]);
        let store = PackageTrustCacheStore::in_home_with_roots(temp.path(), roots(&root));
        let access = access();
        let original_trust = trust_document(&root, 7, "2026-08-01T00:00:00Z", 61);
        let original_registry = registry_document(&root, 42, 7, '1');
        let original = store
            .accept_documents(&original_trust, &original_registry, &access)
            .expect("accept original trust");

        let rollback_trust = trust_document(&root, 6, "2026-08-01T00:00:00Z", 61);
        let trust_rollback = store
            .accept_documents(
                &rollback_trust,
                &registry_document(&root, 43, 6, '2'),
                &access,
            )
            .expect_err("trust rollback");
        assert!(format!("{trust_rollback:#}").contains("stale"));
        let registry_rollback = store
            .accept_documents(
                &original_trust,
                &registry_document(&root, 41, 7, '1'),
                &access,
            )
            .expect_err("registry rollback");
        assert!(format!("{registry_rollback:#}").contains("stale"));
        let equivocated_trust = trust_document(&root, 7, "2026-08-02T00:00:00Z", 62);
        assert!(
            store
                .accept_documents(&equivocated_trust, &original_registry, &access)
                .expect_err("trust equivocation")
                .to_string()
                .contains("equivocation")
        );
        assert!(
            store
                .accept_documents(
                    &original_trust,
                    &registry_document(&root, 42, 7, '2'),
                    &access,
                )
                .expect_err("registry equivocation")
                .to_string()
                .contains("equivocation")
        );
        assert_eq!(
            store.load_verified_audit(&access).expect("last known good"),
            Some(original)
        );
    }

    #[test]
    fn corrupted_cache_and_stale_access_fail_closed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = SigningKey::from_bytes(&[51_u8; 32]);
        let store = PackageTrustCacheStore::in_home_with_roots(temp.path(), roots(&root));
        let current_access = access();
        let trust = trust_document(&root, 7, "2026-08-01T00:00:00Z", 61);
        let registry = registry_document(&root, 42, 7, '1');
        store
            .accept_documents(&trust, &registry, &current_access)
            .expect("accept original trust");

        current_access.invalidate();
        let load_error = store
            .load_verified_audit(&current_access)
            .expect_err("invalidated access");
        assert!(format!("{load_error:#}").contains("fresh Core server time"));
        let write_error = store
            .accept_documents(&trust, &registry, &current_access)
            .expect_err("invalidated cache write");
        assert!(format!("{write_error:#}").contains("fresh Core server time"));

        let connection = state::open(temp.path()).expect("open cache database");
        connection
            .execute(
                "UPDATE package_trust_cache SET registry_document_sha256 = ?1",
                params!["0".repeat(64)],
            )
            .expect("tamper cache digest");
        let fresh_access = access();
        assert!(
            store
                .load_verified_audit(&fresh_access)
                .expect_err("tampered digest")
                .to_string()
                .contains("digest mismatch")
        );
    }

    #[test]
    fn production_cache_remains_empty_without_an_audited_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = PackageTrustCacheStore::in_home(temp.path());
        assert_eq!(
            store
                .load_verified_audit(&access())
                .expect("empty production cache"),
            None
        );
    }

    fn roots(root: &SigningKey) -> TrustedRootStore {
        TrustedRootStore::with_key(TrustedRootKey {
            key_id: ROOT_KEY_ID.into(),
            public_key: root.verifying_key().to_bytes(),
        })
    }

    fn access() -> ClientAccess {
        ClientAccess::with_trusted_time_for_test(timestamp(2026, 7, 24, 12, 0, 0))
    }

    fn trust_document(
        root: &SigningKey,
        sequence: u64,
        expires_at: &str,
        publisher_seed: u8,
    ) -> String {
        signed_bundle_document_for_test(root, ROOT_KEY_ID, sequence, expires_at, publisher_seed)
    }

    fn registry_document(
        root: &SigningKey,
        revision: u64,
        trust_sequence: u64,
        digest_character: char,
    ) -> String {
        signed_registry_document_for_test(
            root,
            ROOT_KEY_ID,
            revision,
            trust_sequence,
            digest_character,
        )
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
