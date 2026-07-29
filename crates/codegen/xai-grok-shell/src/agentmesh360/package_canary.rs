use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, Utc};
use ed25519_dalek::VerifyingKey;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use url::Url;

use super::package_trust::{TrustedRootKey, TrustedRootStore};

const ENABLE_ENV: &str = "AGENTMESH360_PACKAGE_CANARY_E1";
const AUTHORIZATION_ID: &str = "package_canary_e1_20260729_0002";
const BOUNDARY: &str = "/private/tmp/agentmesh360-p5-e1-client";
const STATE_HOME: &str = "/private/tmp/agentmesh360-p5-e1-client/state";
const CONFIG_PATH: &str = "/private/tmp/agentmesh360-p5-e1-client/package-canary-e1.json";
const HARD_STOP: &str = "2026-07-31T17:48:33Z";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const ROOT_A: &str = "agentmesh360-root-e1-p5-20260729-a";
const ROOT_B: &str = "agentmesh360-root-e1-p5-20260729-b";
const FAULT_HEADER: &str = "x-agentmesh360-e1-fault-token";

#[derive(Clone)]
pub(super) struct PackageCanaryRuntime {
    pub(super) allowed_origin: String,
    pub(super) default_headers: HeaderMap,
    pub(super) download_transport_override: Option<Url>,
    pub(super) origin_hostname: String,
    pub(super) origin_socket_addr: SocketAddr,
    pub(super) registry_url: Url,
    pub(super) roots: TrustedRootStore,
    pub(super) trust_bundle_url: Url,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageCanaryDocument {
    schema_version: u32,
    authorization_id: String,
    environment: String,
    executor_commit: String,
    state_home: String,
    origin: String,
    origin_ipv4: String,
    scenario: String,
    fault_token: String,
    root_keys: Vec<PackageCanaryRoot>,
    stops_at: String,
    production_authority_granted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageCanaryRoot {
    key_id: String,
    public_key_base64: String,
}

pub(super) fn load(state_home: &Path) -> Option<PackageCanaryRuntime> {
    match std::env::var(ENABLE_ENV) {
        Err(std::env::VarError::NotPresent) => None,
        Ok(value) if value == "1" => match load_enabled(state_home, Utc::now()) {
            Ok(runtime) => Some(runtime),
            Err(error) => {
                tracing::error!(
                    reason = %format!("{error:#}"),
                    "P5 Agent Package canary configuration rejected"
                );
                None
            }
        },
        _ => {
            tracing::error!("P5 Agent Package canary enable flag is invalid");
            None
        }
    }
}

fn load_enabled(state_home: &Path, now: DateTime<Utc>) -> Result<PackageCanaryRuntime> {
    let expected_state = dunce::canonicalize(STATE_HOME)
        .context("canonicalize fixed P5 Agent Package state home")?;
    let actual_state =
        dunce::canonicalize(state_home).context("canonicalize active Agent Package state home")?;
    if actual_state != expected_state || !actual_state.starts_with(BOUNDARY) {
        bail!("P5 Agent Package canary state home escaped its fixed boundary");
    }

    let config_path = PathBuf::from(CONFIG_PATH);
    let direct = fs::symlink_metadata(&config_path)
        .context("inspect P5 Agent Package canary configuration")?;
    if !direct.is_file() || direct.file_type().is_symlink() {
        bail!("P5 Agent Package canary configuration is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if direct.permissions().mode() & 0o777 != 0o600 {
            bail!("P5 Agent Package canary configuration is not mode 0600");
        }
    }
    #[cfg(not(unix))]
    {
        bail!("P5 Agent Package canary is only approved on Unix");
    }
    if direct.len() == 0 || direct.len() > MAX_CONFIG_BYTES {
        bail!("P5 Agent Package canary configuration size is invalid");
    }
    let canonical = dunce::canonicalize(&config_path)
        .context("canonicalize P5 Agent Package canary configuration")?;
    if canonical != config_path {
        bail!("P5 Agent Package canary configuration path is not canonical");
    }
    let bytes = fs::read(&config_path).context("read P5 Agent Package canary configuration")?;
    parse_document(&bytes, state_home, now)
}

fn parse_document(
    bytes: &[u8],
    state_home: &Path,
    now: DateTime<Utc>,
) -> Result<PackageCanaryRuntime> {
    let document: PackageCanaryDocument =
        serde_json::from_slice(bytes).context("parse P5 Agent Package canary configuration")?;
    let stops_at = DateTime::parse_from_rfc3339(&document.stops_at)
        .context("parse P5 Agent Package canary stop time")?
        .with_timezone(&Utc);
    let hard_stop = DateTime::parse_from_rfc3339(HARD_STOP)
        .expect("fixed P5 hard stop is valid")
        .with_timezone(&Utc);
    if document.schema_version != 1
        || document.authorization_id != AUTHORIZATION_ID
        || document.environment != "e1"
        || !is_lower_hex_commit(&document.executor_commit)
        || Path::new(&document.state_home) != state_home
        || document.production_authority_granted
        || stops_at != hard_stop
        || now >= stops_at
    {
        bail!("P5 Agent Package canary authority is invalid");
    }

    let origin = Url::parse(&document.origin).context("parse P5 Agent Package canary origin")?;
    let hostname = origin
        .host_str()
        .ok_or_else(|| anyhow!("P5 Agent Package canary origin has no host"))?;
    if origin.scheme() != "https"
        || origin.port().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
        || !approved_hostname(hostname)
    {
        bail!("P5 Agent Package canary origin is invalid");
    }

    let (trust_path, registry_path) = scenario_paths(&document.scenario)?;
    let trust_bundle_url = endpoint(&origin, trust_path)?;
    let registry_url = endpoint(&origin, registry_path)?;
    let download_transport_override = if document.scenario == "interrupted_install" {
        Some(endpoint(&origin, "/_e1/fault/truncated_response/registry")?)
    } else {
        None
    };

    if document.fault_token.len() != 43
        || !document
            .fault_token
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
    {
        bail!("P5 Agent Package canary fault authority is invalid");
    }
    let origin_ipv4: Ipv4Addr = document
        .origin_ipv4
        .parse()
        .context("parse P5 Agent Package canary origin IPv4")?;
    if !approved_public_ipv4(origin_ipv4) {
        bail!("P5 Agent Package canary origin IPv4 is invalid");
    }
    let mut default_headers = HeaderMap::new();
    default_headers.insert(
        HeaderName::from_static(FAULT_HEADER),
        HeaderValue::from_str(&document.fault_token)
            .context("parse P5 Agent Package canary fault authority")?,
    );

    if document.root_keys.len() != 2 {
        bail!("P5 Agent Package canary requires exactly two roots");
    }
    let mut roots = Vec::with_capacity(2);
    for root in document.root_keys {
        if !matches!(root.key_id.as_str(), ROOT_A | ROOT_B)
            || roots
                .iter()
                .any(|value: &TrustedRootKey| value.key_id == root.key_id)
        {
            bail!("P5 Agent Package canary root identity is invalid");
        }
        let bytes = BASE64
            .decode(root.public_key_base64.as_bytes())
            .context("decode P5 Agent Package canary root")?;
        let public_key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("P5 Agent Package canary root length is invalid"))?;
        VerifyingKey::from_bytes(&public_key).context("validate P5 Agent Package canary root")?;
        roots.push(TrustedRootKey {
            key_id: root.key_id,
            public_key,
        });
    }
    roots.sort_by(|left, right| left.key_id.cmp(&right.key_id));
    if roots[0].key_id != ROOT_A || roots[1].key_id != ROOT_B {
        bail!("P5 Agent Package canary roots are incomplete");
    }

    Ok(PackageCanaryRuntime {
        allowed_origin: origin.origin().ascii_serialization(),
        default_headers,
        download_transport_override,
        origin_hostname: hostname.to_owned(),
        origin_socket_addr: SocketAddr::new(IpAddr::V4(origin_ipv4), 443),
        registry_url,
        roots: TrustedRootStore::from_keys(roots)?,
        trust_bundle_url,
    })
}

fn approved_public_ipv4(value: Ipv4Addr) -> bool {
    let [first, second, _, _] = value.octets();
    !value.is_private()
        && !value.is_loopback()
        && !value.is_link_local()
        && !value.is_unspecified()
        && !value.is_multicast()
        && !value.is_broadcast()
        && !(first == 100 && (64..=127).contains(&second))
        && !(first == 198 && matches!(second, 18 | 19))
        && first < 224
}

fn endpoint(origin: &Url, target: &str) -> Result<Url> {
    let mut value = origin.clone();
    value.set_path(target);
    if value.origin() != origin.origin() || value.path() != target {
        bail!("P5 Agent Package canary endpoint is invalid");
    }
    Ok(value)
}

fn scenario_paths(scenario: &str) -> Result<(&'static str, &'static str)> {
    let value = match scenario {
        "baseline" => ("/v1/trust-bundle.json", "/v2/registry.json"),
        "same_permission_update" => (
            "/_e1/fault/same_permission_update/trust",
            "/_e1/fault/same_permission_update/registry",
        ),
        "permission_expansion_rejected" => (
            "/_e1/fault/permission_expansion_rejected/trust",
            "/_e1/fault/permission_expansion_rejected/registry",
        ),
        "permission_expansion_approved" => (
            "/_e1/fault/permission_expansion_approved/trust",
            "/_e1/fault/permission_expansion_approved/registry",
        ),
        "interrupted_install" => (
            "/_e1/fault/permission_expansion_approved/trust",
            "/_e1/fault/permission_expansion_approved/registry",
        ),
        "digest_mismatch" => (
            "/_e1/fault/permission_expansion_approved/trust",
            "/_e1/fault/digest_mismatch/registry",
        ),
        "registry_rollback" => (
            "/_e1/fault/permission_expansion_approved/trust",
            "/_e1/fault/registry_rollback/registry",
        ),
        "expired_metadata" => ("/_e1/fault/expired_metadata/trust", "/v2/registry.json"),
        "publisher_rotation" => (
            "/_e1/fault/publisher_rotation/trust",
            "/_e1/fault/publisher_rotation/registry",
        ),
        "publisher_revocation" => (
            "/_e1/fault/publisher_revocation/trust",
            "/_e1/fault/publisher_revocation/registry",
        ),
        "root_rotation" => (
            "/_e1/fault/root_rotation/trust",
            "/_e1/fault/root_rotation/registry",
        ),
        "registry_withdrawal" => (
            "/_e1/fault/root_rotation/trust",
            "/_e1/fault/registry_withdrawal/registry",
        ),
        _ => bail!("P5 Agent Package canary scenario is invalid"),
    };
    Ok(value)
}

fn approved_hostname(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("packages-p5-e1-") else {
        return false;
    };
    let Some(identifier) = suffix.strip_suffix(".agentmesh360.com") else {
        return false;
    };
    identifier.len() == 8
        && identifier
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
}

fn is_lower_hex_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone as _;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    fn document(scenario: &str) -> Vec<u8> {
        let root_a = SigningKey::from_bytes(&[1_u8; 32])
            .verifying_key()
            .to_bytes();
        let root_b = SigningKey::from_bytes(&[2_u8; 32])
            .verifying_key()
            .to_bytes();
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "authorizationId": AUTHORIZATION_ID,
            "environment": "e1",
            "executorCommit": "a".repeat(40),
            "stateHome": STATE_HOME,
            "origin": "https://packages-p5-e1-1234abcd.agentmesh360.com",
            "originIpv4": "203.0.113.10",
            "scenario": scenario,
            "faultToken": "x".repeat(43),
            "rootKeys": [
                {
                    "keyId": ROOT_A,
                    "publicKeyBase64": BASE64.encode(root_a)
                },
                {
                    "keyId": ROOT_B,
                    "publicKeyBase64": BASE64.encode(root_b)
                }
            ],
            "stopsAt": HARD_STOP,
            "productionAuthorityGranted": false
        }))
        .expect("serialize canary document")
    }

    #[test]
    fn accepts_only_fixed_p5_origin_roots_and_scenario_routes() {
        let now = Utc
            .with_ymd_and_hms(2026, 7, 29, 0, 0, 0)
            .single()
            .expect("test time");
        for scenario in [
            "baseline",
            "same_permission_update",
            "permission_expansion_rejected",
            "permission_expansion_approved",
            "interrupted_install",
            "digest_mismatch",
            "registry_rollback",
            "expired_metadata",
            "publisher_rotation",
            "publisher_revocation",
            "root_rotation",
            "registry_withdrawal",
        ] {
            let runtime = parse_document(&document(scenario), Path::new(STATE_HOME), now)
                .expect("approved P5 canary document");
            assert_eq!(
                runtime.allowed_origin,
                "https://packages-p5-e1-1234abcd.agentmesh360.com"
            );
            assert_eq!(
                runtime.origin_socket_addr,
                "203.0.113.10:443".parse().expect("socket address")
            );
            assert_eq!(
                runtime
                    .default_headers
                    .get(FAULT_HEADER)
                    .and_then(|value| value.to_str().ok()),
                Some("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
            );
        }
        assert!(parse_document(&document("unknown"), Path::new(STATE_HOME), now).is_err());
    }

    #[test]
    fn rejects_expiry_wrong_state_or_expanded_authority() {
        let expired = Utc
            .with_ymd_and_hms(2026, 8, 1, 0, 0, 0)
            .single()
            .expect("test time");
        assert!(parse_document(&document("baseline"), Path::new(STATE_HOME), expired).is_err());
        let now = Utc
            .with_ymd_and_hms(2026, 7, 29, 0, 0, 0)
            .single()
            .expect("test time");
        assert!(parse_document(&document("baseline"), Path::new("/tmp/other"), now).is_err());
        let mut value: serde_json::Value =
            serde_json::from_slice(&document("baseline")).expect("document");
        value["productionAuthorityGranted"] = json!(true);
        assert!(
            parse_document(
                &serde_json::to_vec(&value).expect("serialize"),
                Path::new(STATE_HOME),
                now
            )
            .is_err()
        );
        let mut fake_ip: serde_json::Value =
            serde_json::from_slice(&document("baseline")).expect("document");
        fake_ip["originIpv4"] = json!("198.18.1.1");
        assert!(
            parse_document(
                &serde_json::to_vec(&fake_ip).expect("serialize"),
                Path::new(STATE_HOME),
                now
            )
            .is_err()
        );
    }
}
