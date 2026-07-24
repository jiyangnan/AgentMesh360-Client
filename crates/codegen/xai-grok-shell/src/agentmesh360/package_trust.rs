use std::collections::HashMap;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use super::access::ClientAccess;

const TRUST_BUNDLE_SCHEMA_VERSION: u32 = 1;
const MAX_TRUST_BUNDLE_BYTES: usize = 64 * 1024;
const MAX_PUBLISHER_KEYS: usize = 64;
const EMBEDDED_PUBLISHER_TRUST_BUNDLE: Option<&str> = None;

#[derive(Clone, Debug)]
pub(crate) struct TrustedPublisherKey {
    pub key_id: String,
    pub publisher: String,
    pub public_key: [u8; 32],
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TrustedPublisherStore {
    keys: HashMap<String, TrustedPublisherKey>,
    trust_sequence: u64,
    root_key_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PublisherTrustAudit {
    pub trust_sequence: u64,
    pub root_key_id: Option<String>,
    pub active_key_count: usize,
}

impl TrustedPublisherStore {
    pub(crate) fn embedded() -> Self {
        // H2b0 deliberately adds the signed rotation/revocation mechanism without fabricating a
        // production root. Until an audited root key and signed bundle ship, external Packages
        // remain rejected.
        if EMBEDDED_PUBLISHER_TRUST_BUNDLE.is_some() {
            tracing::error!(
                "embedded Agent Package publisher trust requires a fresh Core time gate"
            );
        }
        Self::default()
    }

    pub(crate) fn from_signed_bundle(
        document: &str,
        roots: &TrustedRootStore,
        access: &ClientAccess,
        minimum_sequence: u64,
    ) -> Result<Self> {
        let now = access
            .trusted_server_now()
            .context("Agent Package publisher trust requires fresh Core server time")?;
        Self::from_signed_bundle_at(document, roots, now, minimum_sequence)
    }

    fn from_signed_bundle_at(
        document: &str,
        roots: &TrustedRootStore,
        now: DateTime<Utc>,
        minimum_sequence: u64,
    ) -> Result<Self> {
        if document.is_empty() || document.len() > MAX_TRUST_BUNDLE_BYTES {
            bail!("Agent Package publisher trust bundle size is invalid");
        }
        let bundle: PublisherTrustBundle =
            serde_json::from_str(document).context("parse Agent Package publisher trust bundle")?;
        validate_bundle(&bundle, now, minimum_sequence)?;
        roots.verify(&bundle)?;

        let mut keys = HashMap::new();
        for record in &bundle.keys {
            if record.status != PublisherKeyStatus::Active {
                continue;
            }
            let public_key = decode_public_key(&record.public_key)?;
            keys.insert(
                record.key_id.clone(),
                TrustedPublisherKey {
                    key_id: record.key_id.clone(),
                    publisher: record.publisher.clone(),
                    public_key,
                },
            );
        }
        Ok(Self {
            keys,
            trust_sequence: bundle.sequence,
            root_key_id: Some(bundle.root_key_id),
        })
    }

    #[cfg(test)]
    pub(super) fn with_key(key: TrustedPublisherKey) -> Self {
        Self::with_key_and_audit(key, 0, None)
    }

    #[cfg(test)]
    pub(super) fn with_key_and_audit(
        key: TrustedPublisherKey,
        trust_sequence: u64,
        root_key_id: Option<String>,
    ) -> Self {
        Self {
            keys: HashMap::from([(key.key_id.clone(), key)]),
            trust_sequence,
            root_key_id,
        }
    }

    pub(crate) fn get(&self, key_id: &str) -> Result<&TrustedPublisherKey> {
        self.keys
            .get(key_id)
            .ok_or_else(|| anyhow!("Agent Package signature key is not trusted"))
    }

    pub(crate) fn trusts_publisher(&self, publisher: &str) -> bool {
        self.keys
            .values()
            .any(|trusted| trusted.publisher == publisher)
    }

    pub(crate) fn audit(&self) -> PublisherTrustAudit {
        PublisherTrustAudit {
            trust_sequence: self.trust_sequence,
            root_key_id: self.root_key_id.clone(),
            active_key_count: self.keys.len(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TrustedRootKey {
    pub key_id: String,
    pub public_key: [u8; 32],
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TrustedRootStore {
    keys: HashMap<String, TrustedRootKey>,
}

impl TrustedRootStore {
    pub(crate) fn embedded() -> Self {
        // The production root is intentionally empty until the release key ceremony and
        // independent audit are complete.
        Self::default()
    }

    #[cfg(test)]
    pub(super) fn with_key(key: TrustedRootKey) -> Self {
        Self {
            keys: HashMap::from([(key.key_id.clone(), key)]),
        }
    }

    fn verify(&self, bundle: &PublisherTrustBundle) -> Result<()> {
        self.verify_signed_payload(
            &bundle.root_key_id,
            &bundle.signature,
            trust_bundle_signature_payload(bundle).as_bytes(),
            "Agent Package publisher trust",
        )
    }

    pub(super) fn verify_signed_payload(
        &self,
        root_key_id: &str,
        signature: &str,
        payload: &[u8],
        subject: &'static str,
    ) -> Result<()> {
        let root = self
            .keys
            .get(root_key_id)
            .ok_or_else(|| anyhow!("{subject} root is not trusted"))?;
        let verifying_key = VerifyingKey::from_bytes(&root.public_key)
            .with_context(|| format!("load {subject} root"))?;
        let signature_bytes = decode_canonical_base64(&format!("{subject} signature"), signature)?;
        let signature = Signature::from_slice(&signature_bytes)
            .with_context(|| format!("parse {subject} signature"))?;
        verifying_key
            .verify_strict(payload, &signature)
            .with_context(|| format!("verify {subject} signature"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublisherTrustBundle {
    schema_version: u32,
    sequence: u64,
    root_key_id: String,
    generated_at: String,
    expires_at: String,
    keys: Vec<PublisherTrustKeyRecord>,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublisherTrustKeyRecord {
    key_id: String,
    publisher: String,
    algorithm: String,
    public_key: String,
    status: PublisherKeyStatus,
    not_before: String,
    not_after: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PublisherKeyStatus {
    Active,
    Retired,
    Revoked,
}

impl PublisherKeyStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Retired => "retired",
            Self::Revoked => "revoked",
        }
    }
}

fn validate_bundle(
    bundle: &PublisherTrustBundle,
    now: DateTime<Utc>,
    minimum_sequence: u64,
) -> Result<()> {
    if bundle.schema_version != TRUST_BUNDLE_SCHEMA_VERSION {
        bail!(
            "unsupported Agent Package publisher trust schema version: {}",
            bundle.schema_version
        );
    }
    if bundle.sequence == 0 || bundle.sequence < minimum_sequence {
        bail!("Agent Package publisher trust sequence is stale");
    }
    validate_identifier("rootKeyId", &bundle.root_key_id)?;
    let generated_at = parse_timestamp("generatedAt", &bundle.generated_at)?;
    let expires_at = parse_timestamp("expiresAt", &bundle.expires_at)?;
    if generated_at >= expires_at || now < generated_at || now >= expires_at {
        bail!("Agent Package publisher trust bundle is outside its validity window");
    }
    if bundle.keys.len() > MAX_PUBLISHER_KEYS {
        bail!("Agent Package publisher trust bundle contains too many keys");
    }
    let mut previous_key_id: Option<&str> = None;
    for record in &bundle.keys {
        validate_identifier("keyId", &record.key_id)?;
        validate_identifier("publisher", &record.publisher)?;
        if previous_key_id.is_some_and(|previous| previous >= record.key_id.as_str()) {
            bail!("Agent Package publisher trust keys must be uniquely sorted by keyId");
        }
        previous_key_id = Some(&record.key_id);
        if record.algorithm != "ed25519" {
            bail!("Agent Package publisher trust key algorithm is unsupported");
        }
        decode_public_key(&record.public_key)?;
        let not_before = parse_timestamp("notBefore", &record.not_before)?;
        let not_after = parse_timestamp("notAfter", &record.not_after)?;
        if not_before >= not_after {
            bail!("Agent Package publisher key validity window is invalid");
        }
        if record.status == PublisherKeyStatus::Active && (now < not_before || now >= not_after) {
            bail!("active Agent Package publisher key is outside its validity window");
        }
    }
    if bundle.signature.is_empty() {
        bail!("Agent Package publisher trust signature must not be empty");
    }
    Ok(())
}

fn validate_identifier(field: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.' | b'_')
        })
        || value.starts_with(['-', '.', '_'])
        || value.ends_with(['-', '.', '_'])
    {
        bail!("Agent Package publisher trust {field} is invalid");
    }
    Ok(())
}

fn parse_timestamp(field: &str, value: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("Agent Package publisher trust {field} is invalid"))
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn decode_public_key(value: &str) -> Result<[u8; 32]> {
    let bytes = decode_canonical_base64("Agent Package publisher public key", value)?;
    let public_key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow!("Agent Package publisher public key must be 32 bytes"))?;
    VerifyingKey::from_bytes(&public_key)
        .context("validate Agent Package publisher Ed25519 public key")?;
    Ok(public_key)
}

fn decode_canonical_base64(field: &str, value: &str) -> Result<Vec<u8>> {
    let bytes = BASE64
        .decode(value)
        .with_context(|| format!("decode {field}"))?;
    if BASE64.encode(&bytes) != value {
        bail!("{field} must use canonical base64");
    }
    Ok(bytes)
}

fn trust_bundle_signature_payload(bundle: &PublisherTrustBundle) -> String {
    let mut payload = format!(
        "agentmesh360-publisher-trust-v1\nschemaVersion={}\nsequence={}\nrootKeyId={}\ngeneratedAt={}\nexpiresAt={}\n",
        bundle.schema_version,
        bundle.sequence,
        bundle.root_key_id,
        bundle.generated_at,
        bundle.expires_at
    );
    for key in &bundle.keys {
        payload.push_str(&format!(
            "key={}|{}|{}|{}|{}|{}|{}\n",
            key.key_id,
            key.publisher,
            key.algorithm,
            key.public_key,
            key.status.as_str(),
            key.not_before,
            key.not_after
        ));
    }
    payload
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use chrono::TimeZone as _;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;

    const ROOT_KEY_ID: &str = "agentmesh360-root-test-2026";

    #[test]
    fn signed_bundle_supports_overlap_rotation_and_revocation() {
        let root = SigningKey::from_bytes(&[11_u8; 32]);
        let now = Utc
            .with_ymd_and_hms(2026, 7, 24, 12, 0, 0)
            .single()
            .expect("now");
        let mut bundle = bundle_fixture();
        sign_bundle(&mut bundle, &root);
        let document = serde_json::to_string(&bundle).expect("bundle");
        let roots = TrustedRootStore::with_key(TrustedRootKey {
            key_id: ROOT_KEY_ID.into(),
            public_key: root.verifying_key().to_bytes(),
        });
        let access = ClientAccess::with_trusted_time_for_test(now);

        let store = TrustedPublisherStore::from_signed_bundle(&document, &roots, &access, 7)
            .expect("trusted bundle");

        assert_eq!(
            store.audit(),
            PublisherTrustAudit {
                trust_sequence: 7,
                root_key_id: Some(ROOT_KEY_ID.into()),
                active_key_count: 2,
            }
        );
        assert!(store.get("agentmesh360-release-a").is_ok());
        assert!(store.get("agentmesh360-release-b").is_ok());
        assert!(store.get("agentmesh360-release-retired").is_err());
        assert!(store.get("agentmesh360-release-revoked").is_err());

        access.invalidate();
        assert!(
            TrustedPublisherStore::from_signed_bundle(&document, &roots, &access, 7)
                .expect_err("invalidated trusted time")
                .to_string()
                .contains("fresh Core server time")
        );
        let stale_access = ClientAccess::with_stale_trusted_time_for_test(now);
        assert!(
            TrustedPublisherStore::from_signed_bundle(&document, &roots, &stale_access, 7)
                .expect_err("stale trusted time")
                .to_string()
                .contains("fresh Core server time")
        );
    }

    #[test]
    fn trust_bundle_rejects_tamper_unknown_root_expiry_and_rollback() {
        let root = SigningKey::from_bytes(&[11_u8; 32]);
        let roots = TrustedRootStore::with_key(TrustedRootKey {
            key_id: ROOT_KEY_ID.into(),
            public_key: root.verifying_key().to_bytes(),
        });
        let now = Utc
            .with_ymd_and_hms(2026, 7, 24, 12, 0, 0)
            .single()
            .expect("now");

        let mut tampered = bundle_fixture();
        sign_bundle(&mut tampered, &root);
        tampered.keys[0].publisher = "attacker".into();
        let tampered = serde_json::to_string(&tampered).expect("tampered");
        assert!(
            TrustedPublisherStore::from_signed_bundle_at(&tampered, &roots, now, 7)
                .expect_err("tamper")
                .to_string()
                .contains("signature")
        );

        let mut unknown_root = bundle_fixture();
        unknown_root.root_key_id = "unknown-root".into();
        sign_bundle(&mut unknown_root, &root);
        let unknown_root = serde_json::to_string(&unknown_root).expect("unknown root");
        assert!(
            TrustedPublisherStore::from_signed_bundle_at(&unknown_root, &roots, now, 7)
                .expect_err("unknown root")
                .to_string()
                .contains("not trusted")
        );

        let mut bundle = bundle_fixture();
        sign_bundle(&mut bundle, &root);
        let document = serde_json::to_string(&bundle).expect("bundle");
        assert!(
            TrustedPublisherStore::from_signed_bundle_at(
                &document,
                &roots,
                Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0)
                    .single()
                    .expect("expired"),
                7,
            )
            .expect_err("expired")
            .to_string()
            .contains("validity")
        );
        assert!(
            TrustedPublisherStore::from_signed_bundle_at(&document, &roots, now, 8)
                .expect_err("rollback")
                .to_string()
                .contains("stale")
        );

        let mut unsorted = bundle_fixture();
        unsorted.keys.swap(0, 1);
        sign_bundle(&mut unsorted, &root);
        let unsorted = serde_json::to_string(&unsorted).expect("unsorted");
        assert!(
            TrustedPublisherStore::from_signed_bundle_at(&unsorted, &roots, now, 7)
                .expect_err("unsorted")
                .to_string()
                .contains("uniquely sorted")
        );

        let mut invalid_key = bundle_fixture();
        invalid_key.keys[0].public_key = BASE64.encode([2_u8; 32]);
        sign_bundle(&mut invalid_key, &root);
        let invalid_key = serde_json::to_string(&invalid_key).expect("invalid key");
        assert!(
            TrustedPublisherStore::from_signed_bundle_at(&invalid_key, &roots, now, 7)
                .expect_err("invalid Ed25519 key")
                .to_string()
                .contains("public key")
        );
    }

    #[test]
    fn production_root_and_publisher_store_remain_empty_until_audited_keys_ship() {
        assert!(TrustedRootStore::embedded().keys.is_empty());
        assert!(TrustedPublisherStore::embedded().keys.is_empty());
    }

    fn bundle_fixture() -> PublisherTrustBundle {
        let active_a = publisher_key(
            "agentmesh360-release-a",
            [21_u8; 32],
            PublisherKeyStatus::Active,
        );
        let active_b = publisher_key(
            "agentmesh360-release-b",
            [22_u8; 32],
            PublisherKeyStatus::Active,
        );
        let retired = publisher_key(
            "agentmesh360-release-retired",
            [23_u8; 32],
            PublisherKeyStatus::Retired,
        );
        let revoked = publisher_key(
            "agentmesh360-release-revoked",
            [24_u8; 32],
            PublisherKeyStatus::Revoked,
        );
        PublisherTrustBundle {
            schema_version: 1,
            sequence: 7,
            root_key_id: ROOT_KEY_ID.into(),
            generated_at: "2026-07-01T00:00:00Z".into(),
            expires_at: "2026-08-01T00:00:00Z".into(),
            keys: vec![active_a, active_b, retired, revoked],
            signature: String::new(),
        }
    }

    fn publisher_key(
        key_id: &str,
        signing_seed: [u8; 32],
        status: PublisherKeyStatus,
    ) -> PublisherTrustKeyRecord {
        let public_key = SigningKey::from_bytes(&signing_seed)
            .verifying_key()
            .to_bytes();
        PublisherTrustKeyRecord {
            key_id: key_id.into(),
            publisher: "agentmesh360".into(),
            algorithm: "ed25519".into(),
            public_key: BASE64.encode(public_key),
            status,
            not_before: "2026-06-01T00:00:00Z".into(),
            not_after: "2027-06-01T00:00:00Z".into(),
        }
    }

    fn sign_bundle(bundle: &mut PublisherTrustBundle, root: &SigningKey) {
        let signature = root.sign(trust_bundle_signature_payload(bundle).as_bytes());
        bundle.signature = BASE64.encode(signature.to_bytes());
    }
}
