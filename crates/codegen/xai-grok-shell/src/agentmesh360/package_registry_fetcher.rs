use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::StreamExt as _;
use reqwest::StatusCode;
use reqwest::header::{
    ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, ETAG, HeaderMap, HeaderName, HeaderValue,
    IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use url::Url;

use super::access::ClientAccess;
use super::package_canary;
use super::package_trust_cache::{
    PackageTrustCacheAudit, PackageTrustCacheStore, RemotePackageSummary,
};
use super::state;

#[cfg(test)]
use super::package_trust::TrustedRootStore;

pub(super) const PRODUCTION_PACKAGE_ORIGIN: &str = "https://packages.agentmesh360.com";
const PRODUCTION_TRUST_BUNDLE_URL: Option<&str> = None;
const PRODUCTION_REGISTRY_URL: Option<&str> = None;
const TRUST_BUNDLE_RESPONSE_LIMIT: usize = 64 * 1024;
const REGISTRY_RESPONSE_LIMIT: usize = 1024 * 1024;
const VALIDATOR_LIMIT: usize = 256;

#[derive(Clone)]
pub(crate) struct PackageRegistryFetcher {
    state_home: PathBuf,
    cache: PackageTrustCacheStore,
    client: reqwest::Client,
    endpoints: Option<RemotePackageMetadataEndpoints>,
}

impl PackageRegistryFetcher {
    pub(crate) fn embedded(state_home: impl Into<PathBuf>) -> Self {
        let state_home = state_home.into();
        if let Some(canary) = package_canary::load(&state_home) {
            let dns_override = (canary.origin_hostname.clone(), canary.origin_socket_addr);
            return Self {
                cache: PackageTrustCacheStore::in_home_with_roots(&state_home, canary.roots),
                state_home,
                client: http_client(canary.default_headers, Some(dns_override)),
                endpoints: Some(RemotePackageMetadataEndpoints {
                    trust_bundle: canary.trust_bundle_url,
                    registry: canary.registry_url,
                }),
            };
        }
        let endpoints = match (PRODUCTION_TRUST_BUNDLE_URL, PRODUCTION_REGISTRY_URL) {
            (Some(trust), Some(registry)) => {
                match RemotePackageMetadataEndpoints::production(trust, registry) {
                    Ok(endpoints) => Some(endpoints),
                    Err(()) => {
                        tracing::error!("embedded Agent Package registry endpoints are invalid");
                        None
                    }
                }
            }
            _ => None,
        };
        Self {
            cache: PackageTrustCacheStore::in_home(&state_home),
            state_home,
            client: http_client(HeaderMap::new(), None),
            endpoints,
        }
    }

    #[cfg(test)]
    fn for_test(
        state_home: impl Into<PathBuf>,
        roots: TrustedRootStore,
        trust_url: Url,
        registry_url: Url,
    ) -> Self {
        let state_home = state_home.into();
        let endpoints = RemotePackageMetadataEndpoints::loopback_test(trust_url, registry_url)
            .expect("valid loopback Package metadata endpoints");
        Self {
            cache: PackageTrustCacheStore::in_home_with_roots(&state_home, roots),
            state_home,
            client: http_client(HeaderMap::new(), None),
            endpoints: Some(endpoints),
        }
    }

    #[cfg(test)]
    pub(super) fn for_test_with_cached_roots(
        state_home: impl Into<PathBuf>,
        roots: TrustedRootStore,
    ) -> Self {
        let state_home = state_home.into();
        Self {
            cache: PackageTrustCacheStore::in_home_with_roots(&state_home, roots),
            state_home,
            client: http_client(HeaderMap::new(), None),
            endpoints: None,
        }
    }

    pub(crate) fn status(&self, access: &ClientAccess) -> PackageRegistryFetchStatus {
        if self.endpoints.is_none() {
            return PackageRegistryFetchStatus::disabled();
        }
        match self.cache.load_verified_audit(access) {
            Ok(Some(cache)) => PackageRegistryFetchStatus {
                outcome: PackageRegistryFetchOutcome::Ready,
                reason: None,
                cache: Some(cache),
                checked_at: None,
                conditional_request: false,
            },
            Ok(None) => PackageRegistryFetchStatus::unavailable(
                PackageRegistryFetchReason::NoVerifiedCache,
                None,
            ),
            Err(_) => PackageRegistryFetchStatus::unavailable(
                PackageRegistryFetchReason::CacheRejected,
                None,
            ),
        }
    }

    pub(crate) fn discover(&self, access: &ClientAccess) -> RemotePackageCatalog {
        if access.require().is_err() {
            return RemotePackageCatalog::unavailable(PackageRegistryFetchReason::AccessRequired);
        }
        match self.cache.load_verified_catalog(access) {
            Ok(Some(catalog)) => RemotePackageCatalog {
                outcome: PackageRegistryFetchOutcome::Ready,
                reason: None,
                registry_revision: Some(catalog.registry_revision),
                registry_expires_at: Some(catalog.registry_expires_at),
                packages: catalog.packages,
            },
            Ok(None) if self.endpoints.is_none() => RemotePackageCatalog::disabled(),
            Ok(None) => {
                RemotePackageCatalog::unavailable(PackageRegistryFetchReason::NoVerifiedCache)
            }
            Err(_) => RemotePackageCatalog::unavailable(PackageRegistryFetchReason::CacheRejected),
        }
    }

    pub(crate) fn verifies_installed_signature(
        &self,
        package_id: &str,
        agent_id: &str,
        version: &str,
        publisher: &str,
        signature_key_id: &str,
        access: &ClientAccess,
    ) -> bool {
        self.cache
            .verifies_installed_signature(
                package_id,
                agent_id,
                version,
                publisher,
                signature_key_id,
                access,
            )
            .unwrap_or(false)
    }

    pub(crate) async fn refresh(&self, access: &ClientAccess) -> PackageRegistryFetchStatus {
        let checked_at = match access.trusted_server_now() {
            Ok(now) => now,
            Err(_) => {
                return PackageRegistryFetchStatus::unavailable(
                    PackageRegistryFetchReason::AccessRequired,
                    None,
                );
            }
        };
        let Some(endpoints) = &self.endpoints else {
            return PackageRegistryFetchStatus::disabled();
        };
        let validators = match load_validators(&self.state_home) {
            Ok(validators) => validators,
            Err(_) => {
                return self.fallback(
                    access,
                    PackageRegistryFetchReason::CacheRejected,
                    checked_at,
                    false,
                );
            }
        };
        let conditional_request = validators.has_any();

        let trust = match fetch_document(
            &self.client,
            &endpoints.trust_bundle,
            validators.trust.as_ref(),
            TRUST_BUNDLE_RESPONSE_LIMIT,
        )
        .await
        {
            Ok(document) => document,
            Err(reason) => {
                return self.fallback(access, reason, checked_at, conditional_request);
            }
        };
        let registry = match fetch_document(
            &self.client,
            &endpoints.registry,
            validators.registry.as_ref(),
            REGISTRY_RESPONSE_LIMIT,
        )
        .await
        {
            Ok(document) => document,
            Err(reason) => {
                return self.fallback(access, reason, checked_at, conditional_request);
            }
        };

        let cache = match self.cache.accept_conditional_documents(
            trust.document.as_deref(),
            registry.document.as_deref(),
            access,
        ) {
            Ok(cache) => cache,
            Err(_) => {
                return self.fallback(
                    access,
                    PackageRegistryFetchReason::UntrustedResponse,
                    checked_at,
                    conditional_request,
                );
            }
        };
        let next_validators = FetchValidators {
            trust: trust.validators_after(validators.trust),
            registry: registry.validators_after(validators.registry),
        };
        if persist_validators(&self.state_home, &next_validators, cache.verified_at).is_err() {
            return PackageRegistryFetchStatus {
                outcome: PackageRegistryFetchOutcome::LastKnownGood,
                reason: Some(PackageRegistryFetchReason::ValidatorPersistenceFailed),
                cache: Some(cache),
                checked_at: Some(checked_at),
                conditional_request,
            };
        }

        PackageRegistryFetchStatus {
            outcome: if trust.not_modified && registry.not_modified {
                PackageRegistryFetchOutcome::NotModified
            } else {
                PackageRegistryFetchOutcome::Updated
            },
            reason: None,
            cache: Some(cache),
            checked_at: Some(checked_at),
            conditional_request,
        }
    }

    fn fallback(
        &self,
        access: &ClientAccess,
        reason: PackageRegistryFetchReason,
        checked_at: DateTime<Utc>,
        conditional_request: bool,
    ) -> PackageRegistryFetchStatus {
        let cache = self.cache.load_verified_audit(access).ok().flatten();
        PackageRegistryFetchStatus {
            outcome: if cache.is_some() {
                PackageRegistryFetchOutcome::LastKnownGood
            } else {
                PackageRegistryFetchOutcome::Unavailable
            },
            reason: Some(reason),
            cache,
            checked_at: Some(checked_at),
            conditional_request,
        }
    }
}

fn http_client(
    default_headers: HeaderMap,
    dns_override: Option<(String, SocketAddr)>,
) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .default_headers(default_headers)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());
    if let Some((hostname, socket_addr)) = dns_override {
        builder = builder.resolve(&hostname, socket_addr);
    }
    builder
        .build()
        .expect("Agent Package registry HTTP client configuration is valid")
}

#[derive(Clone)]
struct RemotePackageMetadataEndpoints {
    trust_bundle: Url,
    registry: Url,
}

impl RemotePackageMetadataEndpoints {
    fn production(trust: &str, registry: &str) -> Result<Self, ()> {
        let trust_bundle = Url::parse(trust).map_err(|_| ())?;
        let registry = Url::parse(registry).map_err(|_| ())?;
        validate_endpoint(&trust_bundle, false)?;
        validate_endpoint(&registry, false)?;
        if trust_bundle.origin().ascii_serialization() != PRODUCTION_PACKAGE_ORIGIN
            || registry.origin().ascii_serialization() != PRODUCTION_PACKAGE_ORIGIN
        {
            return Err(());
        }
        Ok(Self {
            trust_bundle,
            registry,
        })
    }

    #[cfg(test)]
    fn loopback_test(trust_bundle: Url, registry: Url) -> Result<Self, ()> {
        validate_endpoint(&trust_bundle, true)?;
        validate_endpoint(&registry, true)?;
        if trust_bundle.origin() != registry.origin() {
            return Err(());
        }
        Ok(Self {
            trust_bundle,
            registry,
        })
    }
}

pub(super) fn validate_endpoint(url: &Url, allow_loopback_http: bool) -> Result<(), ()> {
    let scheme_allowed = url.scheme() == "https"
        || (allow_loopback_http
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "::1")));
    if !scheme_allowed
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PackageRegistryFetchOutcome {
    Disabled,
    Ready,
    Updated,
    NotModified,
    LastKnownGood,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PackageRegistryFetchReason {
    NotConfigured,
    AccessRequired,
    NoVerifiedCache,
    TransportFailed,
    HttpStatusRejected,
    ResponseTooLarge,
    InvalidResponse,
    UntrustedResponse,
    CacheRejected,
    ValidatorPersistenceFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageRegistryFetchStatus {
    pub outcome: PackageRegistryFetchOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PackageRegistryFetchReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<PackageTrustCacheAudit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<DateTime<Utc>>,
    pub conditional_request: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemotePackageCatalog {
    pub outcome: PackageRegistryFetchOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PackageRegistryFetchReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_expires_at: Option<DateTime<Utc>>,
    pub packages: Vec<RemotePackageSummary>,
}

impl RemotePackageCatalog {
    fn disabled() -> Self {
        Self {
            outcome: PackageRegistryFetchOutcome::Disabled,
            reason: Some(PackageRegistryFetchReason::NotConfigured),
            registry_revision: None,
            registry_expires_at: None,
            packages: Vec::new(),
        }
    }

    fn unavailable(reason: PackageRegistryFetchReason) -> Self {
        Self {
            outcome: PackageRegistryFetchOutcome::Unavailable,
            reason: Some(reason),
            registry_revision: None,
            registry_expires_at: None,
            packages: Vec::new(),
        }
    }
}

impl PackageRegistryFetchStatus {
    fn disabled() -> Self {
        Self {
            outcome: PackageRegistryFetchOutcome::Disabled,
            reason: Some(PackageRegistryFetchReason::NotConfigured),
            cache: None,
            checked_at: None,
            conditional_request: false,
        }
    }

    fn unavailable(reason: PackageRegistryFetchReason, checked_at: Option<DateTime<Utc>>) -> Self {
        Self {
            outcome: PackageRegistryFetchOutcome::Unavailable,
            reason: Some(reason),
            cache: None,
            checked_at,
            conditional_request: false,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct FetchValidators {
    trust: Option<DocumentValidators>,
    registry: Option<DocumentValidators>,
}

impl FetchValidators {
    fn has_any(&self) -> bool {
        self.trust.as_ref().is_some_and(DocumentValidators::has_any)
            || self
                .registry
                .as_ref()
                .is_some_and(DocumentValidators::has_any)
    }
}

#[derive(Clone, Debug, Default)]
struct DocumentValidators {
    etag: Option<String>,
    last_modified: Option<String>,
}

impl DocumentValidators {
    fn has_any(&self) -> bool {
        self.etag.is_some() || self.last_modified.is_some()
    }
}

struct FetchedDocument {
    document: Option<String>,
    validators: Option<DocumentValidators>,
    not_modified: bool,
}

impl FetchedDocument {
    fn validators_after(&self, previous: Option<DocumentValidators>) -> Option<DocumentValidators> {
        if !self.not_modified {
            return self.validators.clone().filter(DocumentValidators::has_any);
        }
        let mut merged = previous.unwrap_or_default();
        if let Some(received) = &self.validators {
            if received.etag.is_some() {
                merged.etag.clone_from(&received.etag);
            }
            if received.last_modified.is_some() {
                merged.last_modified.clone_from(&received.last_modified);
            }
        }
        merged.has_any().then_some(merged)
    }
}

async fn fetch_document(
    client: &reqwest::Client,
    endpoint: &Url,
    validators: Option<&DocumentValidators>,
    limit: usize,
) -> Result<FetchedDocument, PackageRegistryFetchReason> {
    let mut request = client
        .get(endpoint.clone())
        .header(ACCEPT, "application/json");
    if let Some(validators) = validators {
        if let Some(etag) = &validators.etag {
            request = request.header(
                IF_NONE_MATCH,
                HeaderValue::from_str(etag)
                    .map_err(|_| PackageRegistryFetchReason::CacheRejected)?,
            );
        }
        if let Some(last_modified) = &validators.last_modified {
            request = request.header(
                IF_MODIFIED_SINCE,
                HeaderValue::from_str(last_modified)
                    .map_err(|_| PackageRegistryFetchReason::CacheRejected)?,
            );
        }
    }
    let response = request
        .send()
        .await
        .map_err(|_| PackageRegistryFetchReason::TransportFailed)?;
    if response.url() != endpoint {
        return Err(PackageRegistryFetchReason::HttpStatusRejected);
    }
    let response_validators = response_validators(response.headers())?;
    if response.status() == StatusCode::NOT_MODIFIED {
        return Ok(FetchedDocument {
            document: None,
            validators: response_validators,
            not_modified: true,
        });
    }
    if response.status() != StatusCode::OK {
        return Err(PackageRegistryFetchReason::HttpStatusRejected);
    }
    if !response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return Err(PackageRegistryFetchReason::InvalidResponse);
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > limit as u64)
    {
        return Err(PackageRegistryFetchReason::ResponseTooLarge);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| PackageRegistryFetchReason::TransportFailed)?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(PackageRegistryFetchReason::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    let document =
        String::from_utf8(body).map_err(|_| PackageRegistryFetchReason::InvalidResponse)?;
    if document.is_empty() {
        return Err(PackageRegistryFetchReason::InvalidResponse);
    }
    Ok(FetchedDocument {
        document: Some(document),
        validators: response_validators,
        not_modified: false,
    })
}

fn response_validators(
    headers: &HeaderMap,
) -> Result<Option<DocumentValidators>, PackageRegistryFetchReason> {
    let etag = optional_header(headers, ETAG, validate_etag)?;
    let last_modified = optional_header(headers, LAST_MODIFIED, validate_last_modified)?;
    let validators = DocumentValidators {
        etag,
        last_modified,
    };
    Ok(validators.has_any().then_some(validators))
}

fn optional_header(
    headers: &HeaderMap,
    name: HeaderName,
    validate: fn(&str) -> bool,
) -> Result<Option<String>, PackageRegistryFetchReason> {
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| PackageRegistryFetchReason::InvalidResponse)?;
    if !validate(value) {
        return Err(PackageRegistryFetchReason::InvalidResponse);
    }
    Ok(Some(value.to_owned()))
}

fn validate_etag(value: &str) -> bool {
    let opaque = value.strip_prefix("W/").unwrap_or(value);
    opaque.len() >= 2
        && opaque.len() <= VALIDATOR_LIMIT
        && opaque.starts_with('"')
        && opaque.ends_with('"')
        && opaque[1..opaque.len() - 1]
            .bytes()
            .all(|byte| byte == b'!' || matches!(byte, b'#'..=b'~') || byte >= 0x80)
}

fn validate_last_modified(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= VALIDATOR_LIMIT
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
}

fn load_validators(state_home: &Path) -> anyhow::Result<FetchValidators> {
    let connection = state::open(state_home)?;
    let row = connection
        .query_row(
            "SELECT trust_etag, trust_last_modified, registry_etag, registry_last_modified
             FROM package_registry_fetch_state WHERE singleton_id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((trust_etag, trust_last_modified, registry_etag, registry_last_modified)) = row else {
        return Ok(FetchValidators::default());
    };
    let validators = FetchValidators {
        trust: validators_from_storage(trust_etag, trust_last_modified)?,
        registry: validators_from_storage(registry_etag, registry_last_modified)?,
    };
    Ok(validators)
}

fn validators_from_storage(
    etag: Option<String>,
    last_modified: Option<String>,
) -> anyhow::Result<Option<DocumentValidators>> {
    if etag.as_deref().is_some_and(|value| !validate_etag(value))
        || last_modified
            .as_deref()
            .is_some_and(|value| !validate_last_modified(value))
    {
        anyhow::bail!("Agent Package conditional validator cache is invalid");
    }
    let validators = DocumentValidators {
        etag,
        last_modified,
    };
    Ok(validators.has_any().then_some(validators))
}

fn persist_validators(
    state_home: &Path,
    validators: &FetchValidators,
    checked_at: DateTime<Utc>,
) -> anyhow::Result<()> {
    let mut connection = state::open(state_home)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO package_registry_fetch_state (
           singleton_id, trust_etag, trust_last_modified, registry_etag,
           registry_last_modified, checked_at
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(singleton_id) DO UPDATE SET
           trust_etag = excluded.trust_etag,
           trust_last_modified = excluded.trust_last_modified,
           registry_etag = excluded.registry_etag,
           registry_last_modified = excluded.registry_last_modified,
           checked_at = excluded.checked_at",
        params![
            validators
                .trust
                .as_ref()
                .and_then(|value| value.etag.as_deref()),
            validators
                .trust
                .as_ref()
                .and_then(|value| value.last_modified.as_deref()),
            validators
                .registry
                .as_ref()
                .and_then(|value| value.etag.as_deref()),
            validators
                .registry
                .as_ref()
                .and_then(|value| value.last_modified.as_deref()),
            checked_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use chrono::TimeZone as _;
    use ed25519_dalek::SigningKey;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::package_registry_snapshot::signed_registry_document_for_test;
    use super::super::package_trust::{TrustedRootKey, signed_bundle_document_for_test};
    use super::*;

    const ROOT_KEY_ID: &str = "agentmesh360-root-test-2026";

    #[tokio::test]
    async fn refreshes_then_uses_persisted_conditional_validators() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = SigningKey::from_bytes(&[71_u8; 32]);
        let trust = trust_document(&root);
        let registry = registry_document(&root);
        let responses = vec![
            TestResponse::json("200 OK", &trust, Some("\"trust-v7\"")),
            TestResponse::json("200 OK", &registry, Some("\"registry-v42\"")),
            TestResponse::not_modified(Some("\"trust-v7\"")),
            TestResponse::not_modified(Some("\"registry-v42\"")),
        ];
        let (origin, server) = serve(responses).await;
        let fetcher = fetcher(temp.path(), &root, &origin);
        let access = access();

        let updated = fetcher.refresh(&access).await;
        assert_eq!(updated.outcome, PackageRegistryFetchOutcome::Updated);
        assert_eq!(
            updated.cache.as_ref().map(|cache| cache.registry_revision),
            Some(42)
        );
        assert!(!updated.conditional_request);
        let discovered = fetcher.discover(&access);
        assert_eq!(discovered.outcome, PackageRegistryFetchOutcome::Ready);
        assert_eq!(discovered.registry_revision, Some(42));
        assert_eq!(
            discovered.packages,
            vec![RemotePackageSummary {
                package_id: "job-agent".into(),
                agent_id: "job-agent".into(),
                version: "1.2.0".into(),
                publisher: "agentmesh360".into(),
            }]
        );
        let discovery_json = serde_json::to_string(&discovered).expect("serialize safe discovery");
        for private_field in [
            "releaseManifestUrl",
            "releaseManifestSha256",
            "artifactUrl",
            "artifactSha256",
            "envelopeUrl",
            "envelopeSha256",
            "hostProjectionUrl",
            "hostProjectionSha256",
            "hostBundles",
            "bundleUrl",
            "bundleSha256",
            "rootKeyId",
            "signature",
            "http://",
            "https://",
        ] {
            assert!(!discovery_json.contains(private_field));
        }

        let not_modified = fetcher.refresh(&access).await;
        assert_eq!(
            not_modified.outcome,
            PackageRegistryFetchOutcome::NotModified
        );
        assert_eq!(
            not_modified
                .cache
                .as_ref()
                .map(|cache| cache.registry_revision),
            Some(42)
        );
        assert!(not_modified.conditional_request);
        let requests = server.await.expect("server requests");
        assert_eq!(requests.len(), 4);
        assert!(requests[2].contains("if-none-match: \"trust-v7\""));
        assert!(requests[3].contains("if-none-match: \"registry-v42\""));
        let serialized = serde_json::to_string(&not_modified).expect("status");
        assert!(!serialized.contains("http://"));
        assert!(!serialized.contains(temp.path().to_string_lossy().as_ref()));
        assert!(!serialized.contains("document"));
    }

    #[tokio::test]
    async fn invalid_remote_update_returns_last_known_good_without_replacing_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = SigningKey::from_bytes(&[71_u8; 32]);
        let responses = vec![
            TestResponse::json("200 OK", &trust_document(&root), Some("\"trust-v7\"")),
            TestResponse::json(
                "200 OK",
                &registry_document(&root),
                Some("\"registry-v42\""),
            ),
            TestResponse::json("200 OK", "{}", Some("\"trust-attacker\"")),
            TestResponse::not_modified(Some("\"registry-v42\"")),
        ];
        let (origin, server) = serve(responses).await;
        let fetcher = fetcher(temp.path(), &root, &origin);
        let access = access();
        assert_eq!(
            fetcher.refresh(&access).await.outcome,
            PackageRegistryFetchOutcome::Updated
        );

        let degraded = fetcher.refresh(&access).await;
        assert_eq!(degraded.outcome, PackageRegistryFetchOutcome::LastKnownGood);
        assert_eq!(
            degraded.reason,
            Some(PackageRegistryFetchReason::UntrustedResponse)
        );
        assert_eq!(
            degraded.cache.as_ref().map(|cache| cache.trust_sequence),
            Some(7)
        );
        let _ = server.await.expect("server requests");
        assert_eq!(
            fetcher
                .status(&access)
                .cache
                .map(|cache| cache.registry_revision),
            Some(42)
        );
    }

    #[tokio::test]
    async fn access_and_response_limits_fail_before_trust_mutation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = SigningKey::from_bytes(&[71_u8; 32]);
        let (origin, server) = serve(vec![TestResponse::json(
            "200 OK",
            &"x".repeat(TRUST_BUNDLE_RESPONSE_LIMIT + 1),
            None,
        )])
        .await;
        let oversized_fetcher = fetcher(temp.path(), &root, &origin);
        let current_access = access();
        let oversized = oversized_fetcher.refresh(&current_access).await;
        assert_eq!(oversized.outcome, PackageRegistryFetchOutcome::Unavailable);
        assert_eq!(
            oversized.reason,
            Some(PackageRegistryFetchReason::ResponseTooLarge)
        );
        let _ = server.await.expect("server request");

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        let blocked_fetcher = fetcher(temp.path(), &root, &origin);
        let blocked_access = access();
        blocked_access.invalidate();
        assert_eq!(
            blocked_fetcher.refresh(&blocked_access).await.reason,
            Some(PackageRegistryFetchReason::AccessRequired)
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[test]
    fn production_fetch_is_disabled_until_release_endpoints_and_roots_ship() {
        let temp = tempfile::tempdir().expect("tempdir");
        let fetcher = PackageRegistryFetcher::embedded(temp.path());
        let status = fetcher.status(&access());
        assert_eq!(status.outcome, PackageRegistryFetchOutcome::Disabled);
        assert_eq!(
            status.reason,
            Some(PackageRegistryFetchReason::NotConfigured)
        );
        let catalog = fetcher.discover(&access());
        assert_eq!(catalog.outcome, PackageRegistryFetchOutcome::Disabled);
        assert_eq!(
            catalog.reason,
            Some(PackageRegistryFetchReason::NotConfigured)
        );
        assert!(catalog.packages.is_empty());
    }

    fn fetcher(state_home: &Path, root: &SigningKey, origin: &str) -> PackageRegistryFetcher {
        let roots = TrustedRootStore::with_key(TrustedRootKey {
            key_id: ROOT_KEY_ID.into(),
            public_key: root.verifying_key().to_bytes(),
        });
        PackageRegistryFetcher::for_test(
            state_home,
            roots,
            Url::parse(&format!("{origin}/trust.json")).expect("trust URL"),
            Url::parse(&format!("{origin}/registry.json")).expect("registry URL"),
        )
    }

    fn access() -> ClientAccess {
        ClientAccess::with_trusted_time_for_test(
            Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0)
                .single()
                .expect("trusted time"),
        )
    }

    fn trust_document(root: &SigningKey) -> String {
        signed_bundle_document_for_test(root, ROOT_KEY_ID, 7, "2026-08-01T00:00:00Z", 81)
    }

    fn registry_document(root: &SigningKey) -> String {
        signed_registry_document_for_test(root, ROOT_KEY_ID, 42, 7, '1')
    }

    struct TestResponse {
        status: &'static str,
        body: String,
        etag: Option<String>,
    }

    impl TestResponse {
        fn json(status: &'static str, body: &str, etag: Option<&str>) -> Self {
            Self {
                status,
                body: body.into(),
                etag: etag.map(str::to_owned),
            }
        }

        fn not_modified(etag: Option<&str>) -> Self {
            Self::json("304 Not Modified", "", etag)
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
                let mut buffer = vec![0; 8192];
                let read = stream.read(&mut buffer).await.expect("read");
                requests.push(String::from_utf8_lossy(&buffer[..read]).to_ascii_lowercase());
                let etag = response
                    .etag
                    .map(|etag| format!("ETag: {etag}\r\n"))
                    .unwrap_or_default();
                let message = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.status,
                    etag,
                    response.body.len(),
                    response.body
                );
                let _ = stream.write_all(message.as_bytes()).await;
            }
            requests
        });
        (format!("http://{address}"), task)
    }
}
