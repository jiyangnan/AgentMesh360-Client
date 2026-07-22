use anyhow::{Context, Result};
use xai_grok_sampler::SamplerConfig;

use super::credential_lease::{CredentialLeaseResolver, LeasedSamplingRoute};
use super::credential_vault::CredentialVault;
use super::session_bindings::SessionProviderBinding;
use super::turn_routes::{TurnRouteRecord, TurnRouteStore};

/// Host-side preparation for one product-agent turn.
///
/// The leased config and immutable Binding stay together until the caller's
/// submit function confirms actor acceptance. Only then can the trusted Turn
/// Route store be written.
pub struct BoundTurnSubmission {
    owner_account_id: i64,
    turn_id: String,
    leased_route: LeasedSamplingRoute,
    turn_routes: TurnRouteStore,
}

impl std::fmt::Debug for BoundTurnSubmission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundTurnSubmission")
            .field("owner_account_id", &self.owner_account_id)
            .field("turn_id", &self.turn_id)
            .field("leased_route", &self.leased_route)
            .finish()
    }
}

/// Submission receipt paired with the durable non-secret route audit record.
#[derive(Debug)]
pub struct AcceptedBoundTurn<T> {
    pub accepted: T,
    pub turn_route: TurnRouteRecord,
}

pub struct TurnSubmissionCoordinator {
    turn_routes: TurnRouteStore,
}

impl Default for TurnSubmissionCoordinator {
    fn default() -> Self {
        Self::in_home(super::state::default_state_home())
    }
}

impl TurnSubmissionCoordinator {
    pub fn in_home(state_home: impl Into<std::path::PathBuf>) -> Self {
        Self {
            turn_routes: TurnRouteStore::in_home(state_home),
        }
    }

    pub fn prepare<V: CredentialVault>(
        &self,
        resolver: &CredentialLeaseResolver<V>,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
        turn_id: impl Into<String>,
    ) -> Result<BoundTurnSubmission> {
        let leased_route = resolver.resolve(owner_account_id, session_id, role)?;
        Ok(BoundTurnSubmission {
            owner_account_id,
            turn_id: turn_id.into(),
            leased_route,
            turn_routes: self.turn_routes.clone(),
        })
    }
}

impl BoundTurnSubmission {
    /// Invoke the exact Sampling-actor acceptance operation and persist the
    /// route only if it succeeds. If persistence then fails, `accepted` is
    /// dropped; D1c passes `PendingSamplingRequest`, whose Drop cancels it.
    pub fn submit<T>(
        self,
        submit: impl FnOnce(SamplerConfig) -> Result<T>,
    ) -> Result<AcceptedBoundTurn<T>> {
        let (sampler_config, binding) = self.leased_route.into_parts();
        self.turn_routes
            .validate_submission(self.owner_account_id, &self.turn_id, &binding)?;
        let accepted = submit(sampler_config).context("submit bound turn to Sampling actor")?;
        let turn_route = self
            .turn_routes
            .record_submitted(self.owner_account_id, &self.turn_id, &binding)
            .context("record accepted bound turn route")?;
        Ok(AcceptedBoundTurn {
            accepted,
            turn_route,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;
    use crate::agentmesh360::credential_vault::{
        CredentialRef, MemoryCredentialVault, SecretValue,
    };
    use crate::agentmesh360::model_routing::PreparedRoute;
    use crate::agentmesh360::provider_catalog::{ModelCapability, ProviderClassification};
    use crate::agentmesh360::provider_profiles::{
        ProviderAuthKind, ProviderProfileInput, ProviderProfileStore, ProviderProtocol,
    };
    use crate::agentmesh360::session_bindings::{BindingChangeReason, SessionBindingStore};

    const ACCOUNT_ID: i64 = 41;
    const SECRET: &str = "sentinel-turn-secret-1234";

    fn route(profile_revision: u64, endpoint: &str) -> PreparedRoute {
        PreparedRoute {
            provider_profile_id: "pp_turn".into(),
            provider_preset_id: None,
            provider_display_name: "Turn Provider".into(),
            endpoint_classification: ProviderClassification::Custom,
            endpoint_origin: endpoint.trim_end_matches("/v1").into(),
            protocol: ProviderProtocol::OpenaiResponses,
            base_url: endpoint.into(),
            auth_kind: ProviderAuthKind::BearerApiKey,
            model_id: "turn-model".into(),
            profile_route_revision: profile_revision,
            assignment_id: "ma_turn".into(),
            assignment_revision: profile_revision,
            catalog_revision: 1,
            capability: ModelCapability::unknown(),
            quirks: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn setup() -> (
        tempfile::TempDir,
        CredentialLeaseResolver<MemoryCredentialVault>,
        TurnSubmissionCoordinator,
        SessionBindingStore,
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let credential_ref = CredentialRef::generate();
        let vault = MemoryCredentialVault::default();
        vault
            .put(
                &credential_ref,
                &SecretValue::new(SECRET.into()).expect("secret"),
            )
            .expect("store secret");
        ProviderProfileStore::in_home(temp.path())
            .insert(
                ACCOUNT_ID,
                "pp_turn",
                credential_ref.as_str(),
                "1234",
                &ProviderProfileInput {
                    preset_id: None,
                    display_name: "Turn Provider".into(),
                    protocol: ProviderProtocol::OpenaiResponses,
                    base_url: "https://turn.example/v1".into(),
                    auth_kind: ProviderAuthKind::BearerApiKey,
                    enabled_models: vec!["turn-model".into()],
                }
                .normalized()
                .expect("profile input"),
            )
            .expect("profile");
        let bindings = SessionBindingStore::in_home(temp.path());
        bindings
            .bind_initial(
                ACCOUNT_ID,
                "session-turn",
                "main",
                Some("job-agent"),
                &route(1, "https://turn.example/v1"),
            )
            .expect("binding");
        let resolver = CredentialLeaseResolver::in_home(temp.path(), vault);
        let coordinator = TurnSubmissionCoordinator::in_home(temp.path());
        (temp, resolver, coordinator, bindings)
    }

    fn route_history(temp: &tempfile::TempDir) -> Vec<TurnRouteRecord> {
        TurnRouteStore::in_home(temp.path())
            .list_session(ACCOUNT_ID, "session-turn", "main")
            .expect("route history")
    }

    #[test]
    fn records_only_after_the_submitter_accepts_the_turn() {
        let (temp, resolver, coordinator, _) = setup();
        let called = Rc::new(Cell::new(false));
        let called_by_submitter = Rc::clone(&called);
        let prepared = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-1")
            .expect("prepare");
        assert!(route_history(&temp).is_empty());

        let accepted = prepared
            .submit(move |config| {
                called_by_submitter.set(true);
                assert!(config.api_key.is_none());
                assert!(config.bearer_resolver.is_some());
                Ok("actor-accepted")
            })
            .expect("submit and record");

        assert!(called.get());
        assert_eq!(accepted.accepted, "actor-accepted");
        assert_eq!(accepted.turn_route.turn_id, "turn-1");
        assert_eq!(route_history(&temp).len(), 1);
    }

    #[test]
    fn submitter_failure_never_creates_a_ghost_turn() {
        let (temp, resolver, coordinator, _) = setup();
        let prepared = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-failed")
            .expect("prepare");

        let error = prepared
            .submit::<()>(|_| anyhow::bail!("actor rejected submit"))
            .expect_err("rejected submit must fail");
        assert!(error.to_string().contains("submit bound turn"));
        assert!(route_history(&temp).is_empty());
    }

    #[test]
    fn same_binding_retry_is_idempotent() {
        let (temp, resolver, coordinator, _) = setup();
        let first = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-retry")
            .expect("first prepare")
            .submit(|_| Ok("first"))
            .expect("first submit");
        let second = coordinator
            .prepare(&resolver, ACCOUNT_ID, "session-turn", "main", "turn-retry")
            .expect("retry prepare")
            .submit(|_| Ok("retry"))
            .expect("retry submit");

        assert_eq!(
            first.turn_route.turn_route_id,
            second.turn_route.turn_route_id
        );
        assert_eq!(route_history(&temp).len(), 1);
    }

    #[test]
    fn conflicting_binding_is_rejected_before_submitter_runs() {
        let (temp, resolver, coordinator, bindings) = setup();
        coordinator
            .prepare(
                &resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-conflict",
            )
            .expect("prepare first binding")
            .submit(|_| Ok(()))
            .expect("record first binding");
        bindings
            .append(
                ACCOUNT_ID,
                "session-turn",
                "main",
                Some("job-agent"),
                BindingChangeReason::ExplicitSwitch,
                &route(1, "https://turn.example/v1"),
            )
            .expect("append Binding revision");
        let called = Cell::new(false);

        let error = coordinator
            .prepare(
                &resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-conflict",
            )
            .expect("prepare conflicting binding")
            .submit::<()>(|_| {
                called.set(true);
                Ok(())
            })
            .expect_err("different Binding must not replace a Turn");

        assert!(!called.get());
        assert!(error.to_string().contains("different Binding revision"));
        assert_eq!(route_history(&temp).len(), 1);
    }

    #[test]
    fn preparation_failure_never_calls_the_submitter() {
        let (temp, _resolver, coordinator, _) = setup();
        let empty_resolver =
            CredentialLeaseResolver::in_home(temp.path(), MemoryCredentialVault::default());

        let error = coordinator
            .prepare(
                &empty_resolver,
                ACCOUNT_ID,
                "session-turn",
                "main",
                "turn-missing-secret",
            )
            .expect_err("missing secret must fail before a submission exists");
        assert!(error.to_string().contains("credential is unavailable"));
        assert!(route_history(&temp).is_empty());
    }
}
