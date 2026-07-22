use std::fmt;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use xai_grok_sampler::{BearerResolver, SamplerConfig, SamplingClient, SharedBearerResolver};

use super::credential_vault::{CredentialRef, CredentialVault, SecretValue, SystemCredentialVault};
use super::provider_profiles::{ProviderProfileRecord, ProviderProfileStore};
use super::session_bindings::{SessionBindingStore, SessionProviderBinding};

/// Host-owned, short-lived authority to use one Provider credential.
///
/// This type deliberately implements neither `Clone` nor `Serialize`. The
/// credential remains in zeroizing memory and reaches the existing Grok
/// sampler only through its non-serializable per-request resolver hook.
pub struct CredentialLease {
    provider_profile_id: String,
    profile_route_revision: u64,
    credential: Arc<LeaseCredential>,
}

impl fmt::Debug for CredentialLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialLease")
            .field("provider_profile_id", &self.provider_profile_id)
            .field("profile_route_revision", &self.profile_route_revision)
            .field("credential_present", &true)
            .finish()
    }
}

struct LeaseCredential {
    secret: SecretValue,
}

impl fmt::Debug for LeaseCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LeaseCredential([REDACTED])")
    }
}

impl BearerResolver for LeaseCredential {
    fn current_bearer(&self) -> Option<String> {
        Some(
            std::str::from_utf8(self.secret.as_bytes())
                .expect("SecretValue is validated UTF-8")
                .to_owned(),
        )
    }
}

/// A non-serializable bridge from an immutable Binding to Grok Sampling.
///
/// `SamplerConfig::api_key` stays empty so serde cannot persist the leased
/// credential. `bearer_resolver` is skipped by serde and is consumed by the
/// existing `SamplingClient` immediately before each request.
pub struct LeasedSamplingRoute {
    binding: SessionProviderBinding,
    sampler_config: SamplerConfig,
}

impl fmt::Debug for LeasedSamplingRoute {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LeasedSamplingRoute")
            .field("session_id", &self.binding.session_id)
            .field("role", &self.binding.role)
            .field("binding_revision", &self.binding.binding_revision)
            .field(
                "provider_profile_id",
                &self.binding.route.provider_profile_id,
            )
            .field("model_id", &self.binding.route.model_id)
            .field("protocol", &self.binding.route.protocol)
            .field("credential_present", &true)
            .finish()
    }
}

impl LeasedSamplingRoute {
    /// Constructing a `SamplingClient` computes headers but performs no network I/O.
    pub fn into_client(self) -> Result<(SamplingClient, SessionProviderBinding)> {
        let client = SamplingClient::new(self.sampler_config)
            .context("prepare existing Grok Sampling client")?;
        Ok((client, self.binding))
    }

    pub(super) fn into_parts(self) -> (SamplerConfig, SessionProviderBinding) {
        (self.sampler_config, self.binding)
    }

    #[cfg(test)]
    fn sampler_config(&self) -> &SamplerConfig {
        &self.sampler_config
    }
}

pub struct CredentialLeaseResolver<V> {
    profiles: ProviderProfileStore,
    bindings: SessionBindingStore,
    vault: V,
}

impl Default for CredentialLeaseResolver<SystemCredentialVault> {
    fn default() -> Self {
        let state_home = super::state::default_state_home();
        Self::in_home(&state_home, SystemCredentialVault)
    }
}

impl<V: CredentialVault> CredentialLeaseResolver<V> {
    pub fn in_home(state_home: &std::path::Path, vault: V) -> Self {
        Self {
            profiles: ProviderProfileStore::in_home(state_home),
            bindings: SessionBindingStore::in_home(state_home),
            vault,
        }
    }

    /// Resolve the current immutable Binding and project it into Grok's
    /// existing three-protocol sampler without performing a network request.
    pub fn resolve(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
    ) -> Result<LeasedSamplingRoute> {
        let binding = self
            .bindings
            .current(owner_account_id, session_id, role)?
            .ok_or_else(|| anyhow::anyhow!("Session Provider Binding is not initialized"))?;
        if binding.owner_account_id != owner_account_id {
            bail!("Session Provider Binding account does not match");
        }

        let profile = self
            .profiles
            .get(owner_account_id, &binding.route.provider_profile_id)
            .context("resolve bound Provider Profile")?;
        validate_profile_revision(&binding, &profile)?;
        let lease = self.lease(&profile)?;
        project(binding, lease)
    }

    fn lease(&self, profile: &ProviderProfileRecord) -> Result<CredentialLease> {
        if !profile.credential_configured {
            bail!("bound Provider credential is not configured");
        }
        let credential_ref = CredentialRef::parse(profile.credential_ref.clone())
            .context("bound Provider credential handle is invalid")?;
        let secret = self
            .vault
            .get(&credential_ref)
            .context("bound Provider credential is unavailable")?;
        Ok(CredentialLease {
            provider_profile_id: profile.profile_id.clone(),
            profile_route_revision: profile.route_revision,
            credential: Arc::new(LeaseCredential { secret }),
        })
    }
}

fn validate_profile_revision(
    binding: &SessionProviderBinding,
    profile: &ProviderProfileRecord,
) -> Result<()> {
    let route = &binding.route;
    if profile.owner_account_id != binding.owner_account_id
        || profile.profile_id != route.provider_profile_id
    {
        bail!("bound Provider Profile ownership does not match");
    }
    if profile.route_revision < route.profile_route_revision {
        bail!("bound Provider route revision is unavailable");
    }
    if profile.route_revision == route.profile_route_revision
        && (profile.protocol != route.protocol
            || profile.base_url != route.base_url
            || profile.auth_kind != route.auth_kind)
    {
        bail!("bound Provider route does not match its Profile revision");
    }
    Ok(())
}

fn project(binding: SessionProviderBinding, lease: CredentialLease) -> Result<LeasedSamplingRoute> {
    if lease.provider_profile_id != binding.route.provider_profile_id
        || lease.profile_route_revision < binding.route.profile_route_revision
    {
        bail!("Credential Lease does not match the bound Provider route");
    }
    let max_completion_tokens = binding
        .route
        .capability
        .max_output_tokens
        .map(u32::try_from)
        .transpose()
        .context("bound model max output tokens exceed Sampling limits")?;
    let bearer_resolver: SharedBearerResolver = lease.credential;
    let sampler_config = SamplerConfig {
        api_key: None,
        base_url: binding.route.base_url.clone(),
        model: binding.route.model_id.clone(),
        max_completion_tokens,
        api_backend: binding.route.api_backend(),
        auth_scheme: binding.route.auth_scheme(),
        context_window: binding.route.capability.context_window.unwrap_or(0),
        bearer_resolver: Some(bearer_resolver),
        ..SamplerConfig::default()
    };
    Ok(LeasedSamplingRoute {
        binding,
        sampler_config,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentmesh360::credential_vault::{MemoryCredentialVault, SecretValue};
    use crate::agentmesh360::model_routing::PreparedRoute;
    use crate::agentmesh360::provider_catalog::{
        CapabilitySource, CapabilityStatus, ModelCapability, ProviderClassification,
    };
    use crate::agentmesh360::provider_profiles::{
        ProviderAuthKind, ProviderProfileInput, ProviderProtocol,
    };
    use xai_grok_sampling_types::ApiBackend;

    const SECRET: &str = "sentinel-lease-secret-1234";

    fn capability() -> ModelCapability {
        ModelCapability {
            context_window: Some(128_000),
            max_output_tokens: Some(8_192),
            tools: CapabilityStatus::Supported,
            parallel_tool_calls: CapabilityStatus::Unknown,
            vision: CapabilityStatus::Unknown,
            structured_output: CapabilityStatus::Supported,
            reasoning: CapabilityStatus::Unknown,
            streaming: CapabilityStatus::Supported,
            source: CapabilitySource::Catalog,
        }
    }

    fn add_route(
        state_home: &std::path::Path,
        vault: &MemoryCredentialVault,
        suffix: &str,
        protocol: ProviderProtocol,
        auth_kind: ProviderAuthKind,
    ) {
        let credential_ref = CredentialRef::generate();
        vault
            .put(
                &credential_ref,
                &SecretValue::new(SECRET.into()).expect("secret"),
            )
            .expect("store credential");
        let profile_id = format!("pp_{suffix}");
        ProviderProfileStore::in_home(state_home)
            .insert(
                41,
                &profile_id,
                credential_ref.as_str(),
                "1234",
                &ProviderProfileInput {
                    preset_id: None,
                    display_name: format!("Provider {suffix}"),
                    protocol,
                    base_url: format!("https://{suffix}.example/v1"),
                    auth_kind,
                    enabled_models: vec![format!("model-{suffix}")],
                }
                .normalized()
                .expect("profile input"),
            )
            .expect("profile");
        SessionBindingStore::in_home(state_home)
            .bind_initial(
                41,
                &format!("session-{suffix}"),
                "main",
                Some("job-agent"),
                &PreparedRoute {
                    provider_profile_id: profile_id,
                    provider_preset_id: None,
                    provider_display_name: format!("Provider {suffix}"),
                    endpoint_classification: ProviderClassification::Custom,
                    endpoint_origin: format!("https://{suffix}.example"),
                    protocol,
                    base_url: format!("https://{suffix}.example/v1"),
                    auth_kind,
                    model_id: format!("model-{suffix}"),
                    profile_route_revision: 1,
                    assignment_id: format!("ma_{suffix}"),
                    assignment_role: "main".into(),
                    assignment_revision: 1,
                    catalog_revision: 1,
                    capability: capability(),
                    quirks: Vec::new(),
                    warnings: Vec::new(),
                },
            )
            .expect("binding");
    }

    #[test]
    fn projects_all_existing_protocols_without_serializing_the_lease() {
        let temp = tempfile::tempdir().expect("tempdir");
        let vault = MemoryCredentialVault::default();
        for (suffix, protocol, auth_kind) in [
            (
                "responses",
                ProviderProtocol::OpenaiResponses,
                ProviderAuthKind::BearerApiKey,
            ),
            (
                "chat",
                ProviderProtocol::OpenaiChat,
                ProviderAuthKind::BearerApiKey,
            ),
            (
                "messages",
                ProviderProtocol::AnthropicMessages,
                ProviderAuthKind::XApiKey,
            ),
        ] {
            add_route(temp.path(), &vault, suffix, protocol, auth_kind);
        }
        let resolver = CredentialLeaseResolver::in_home(temp.path(), vault);

        for (suffix, expected_backend) in [
            ("responses", ApiBackend::Responses),
            ("chat", ApiBackend::ChatCompletions),
            ("messages", ApiBackend::Messages),
        ] {
            let leased = resolver
                .resolve(41, &format!("session-{suffix}"), "main")
                .expect("resolve leased route");
            let config = leased.sampler_config();
            assert_eq!(config.api_backend, expected_backend);
            assert_eq!(config.model, format!("model-{suffix}"));
            assert_eq!(config.context_window, 128_000);
            assert_eq!(config.max_completion_tokens, Some(8_192));
            assert!(config.api_key.is_none());
            assert_eq!(
                config
                    .bearer_resolver
                    .as_ref()
                    .and_then(|resolver| resolver.current_bearer())
                    .as_deref(),
                Some(SECRET)
            );
            let serialized = serde_json::to_string(config).expect("serialize sampler config");
            let debug = format!("{leased:?} {config:?}");
            assert!(!serialized.contains(SECRET));
            assert!(!debug.contains(SECRET));

            let (client, binding) = leased.into_client().expect("construct sampling client");
            assert_eq!(client.api_backend(), expected_backend);
            assert_eq!(binding.session_id, format!("session-{suffix}"));
        }
    }

    #[test]
    fn fails_closed_when_the_bound_credential_is_missing_or_account_differs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let populated_vault = MemoryCredentialVault::default();
        add_route(
            temp.path(),
            &populated_vault,
            "missing",
            ProviderProtocol::OpenaiResponses,
            ProviderAuthKind::BearerApiKey,
        );
        let resolver =
            CredentialLeaseResolver::in_home(temp.path(), MemoryCredentialVault::default());

        let missing = resolver
            .resolve(41, "session-missing", "main")
            .expect_err("missing Vault item must fail closed");
        assert!(missing.to_string().contains("credential is unavailable"));
        assert!(
            resolver
                .resolve(42, "session-missing", "main")
                .expect_err("other account cannot use the Binding")
                .to_string()
                .contains("not initialized")
        );
        assert!(!format!("{missing:?}").contains(SECRET));
    }

    #[test]
    fn rejects_an_impossible_profile_revision_without_reading_the_secret() {
        let temp = tempfile::tempdir().expect("tempdir");
        let vault = MemoryCredentialVault::default();
        add_route(
            temp.path(),
            &vault,
            "revision",
            ProviderProtocol::OpenaiResponses,
            ProviderAuthKind::BearerApiKey,
        );
        let conn = crate::agentmesh360::state::open(temp.path()).expect("state database");
        let route_json: String = conn
            .query_row(
                "SELECT prepared_route_json FROM session_provider_bindings",
                [],
                |row| row.get(0),
            )
            .expect("route json");
        let mut route: PreparedRoute = serde_json::from_str(&route_json).expect("route");
        route.profile_route_revision = 2;
        let changed_json = serde_json::to_string(&route).expect("changed route");
        let changed_hash = blake3::hash(changed_json.as_bytes()).to_hex().to_string();
        conn.execute(
            "UPDATE session_provider_bindings SET prepared_route_json = ?1, \
             snapshot_hash = ?2, profile_route_revision = 2",
            rusqlite::params![changed_json, changed_hash],
        )
        .expect("tamper test revision");
        let resolver = CredentialLeaseResolver::in_home(temp.path(), vault);

        assert!(
            resolver
                .resolve(41, "session-revision", "main")
                .expect_err("future Profile revision must fail closed")
                .to_string()
                .contains("route revision is unavailable")
        );
    }

    #[test]
    fn a_newer_profile_revision_does_not_silently_change_the_bound_route() {
        let temp = tempfile::tempdir().expect("tempdir");
        let vault = MemoryCredentialVault::default();
        add_route(
            temp.path(),
            &vault,
            "frozen",
            ProviderProtocol::OpenaiResponses,
            ProviderAuthKind::BearerApiKey,
        );
        ProviderProfileStore::in_home(temp.path())
            .update(
                41,
                "pp_frozen",
                &ProviderProfileInput {
                    preset_id: None,
                    display_name: "Updated Provider".into(),
                    protocol: ProviderProtocol::OpenaiChat,
                    base_url: "https://new-endpoint.example/v1".into(),
                    auth_kind: ProviderAuthKind::BearerApiKey,
                    enabled_models: vec!["new-model".into()],
                }
                .normalized()
                .expect("updated profile"),
            )
            .expect("update profile revision");
        let resolver = CredentialLeaseResolver::in_home(temp.path(), vault);

        let leased = resolver
            .resolve(41, "session-frozen", "main")
            .expect("existing Binding keeps its frozen route");
        assert_eq!(leased.sampler_config().api_backend, ApiBackend::Responses);
        assert_eq!(
            leased.sampler_config().base_url,
            "https://frozen.example/v1"
        );
        assert_eq!(leased.sampler_config().model, "model-frozen");
    }
}
