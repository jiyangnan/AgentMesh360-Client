use agent_client_protocol as acp;
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use url::Url;
use xai_grok_sampler::AuthScheme;
use xai_grok_sampling_types::ApiBackend;

use super::model_assignments::{ModelAssignmentInput, ModelAssignmentRecord, ModelAssignmentStore};
use super::model_policy::AgentModelPolicy;
use super::provider_catalog::{
    ModelCapability, ProviderCatalog, ProviderClassification, ProviderQuirk,
};
use super::provider_profiles::{ProviderAuthKind, ProviderProfileStore, ProviderProtocol};
use super::registry::AgentRegistry;
use super::session_bindings::{BindingChangeReason, SessionBindingStore, SessionProviderBinding};
use super::turn_routes::{TurnRouteRecord, TurnRouteStore};

pub const PROVIDER_CATALOG_METHOD: &str = "x.agentmesh360/providers/catalog";
pub const ASSIGNMENTS_LIST_METHOD: &str = "x.agentmesh360/model-assignments/list";
pub const ASSIGNMENTS_UPSERT_METHOD: &str = "x.agentmesh360/model-assignments/upsert";
pub const ASSIGNMENTS_DELETE_METHOD: &str = "x.agentmesh360/model-assignments/delete";
pub const BINDING_RESOLVE_METHOD: &str = "x.agentmesh360/session-bindings/resolve";
pub const BINDING_HISTORY_METHOD: &str = "x.agentmesh360/session-bindings/history";
pub const BINDING_SWITCH_METHOD: &str = "x.agentmesh360/session-bindings/switch";
pub const TURN_ROUTES_LIST_METHOD: &str = "x.agentmesh360/turn-routes/list";

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        PROVIDER_CATALOG_METHOD
            | ASSIGNMENTS_LIST_METHOD
            | ASSIGNMENTS_UPSERT_METHOD
            | ASSIGNMENTS_DELETE_METHOD
            | BINDING_RESOLVE_METHOD
            | BINDING_HISTORY_METHOD
            | BINDING_SWITCH_METHOD
            | TURN_ROUTES_LIST_METHOD
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertAssignmentRequest {
    assignment: ModelAssignmentInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteAssignmentRequest {
    assignment_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingLookupRequest {
    session_id: String,
    role: String,
    agent_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BindingSwitchKind {
    ExplicitSwitch,
    CompatibleMigration,
    Rollback,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SwitchBindingRequest {
    session_id: String,
    role: String,
    agent_id: Option<String>,
    kind: BindingSwitchKind,
    target_binding_revision: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogResponse<'a> {
    catalog: &'a ProviderCatalog,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentsResponse {
    assignments: Vec<ModelAssignmentRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentResponse {
    assignment: ModelAssignmentRecord,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAssignmentResponse {
    deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingResponse {
    binding: SessionProviderBinding,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingHistoryResponse {
    bindings: Vec<SessionProviderBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnRoutesResponse {
    turn_routes: Vec<TurnRouteRecord>,
}

pub struct ModelRoutingService {
    catalog: ProviderCatalog,
    assignments: ModelAssignmentStore,
    bindings: SessionBindingStore,
    turn_routes: TurnRouteStore,
    registry: AgentRegistry,
    compiler: RouteCompiler,
}

impl Default for ModelRoutingService {
    fn default() -> Self {
        let state_home = super::state::default_state_home();
        Self::in_home(state_home)
    }
}

impl ModelRoutingService {
    pub fn in_home(state_home: impl AsRef<std::path::Path>) -> Self {
        let state_home = state_home.as_ref();
        Self::in_home_with_registry(state_home, AgentRegistry::in_home(state_home))
    }

    pub(crate) fn in_home_with_registry(
        state_home: impl AsRef<std::path::Path>,
        registry: AgentRegistry,
    ) -> Self {
        let state_home = state_home.as_ref();
        let catalog = ProviderCatalog::builtin();
        Self {
            catalog: catalog.clone(),
            assignments: ModelAssignmentStore::in_home(state_home),
            bindings: SessionBindingStore::in_home(state_home),
            turn_routes: TurnRouteStore::in_home(state_home),
            registry,
            compiler: RouteCompiler::in_home(catalog, state_home),
        }
    }

    #[cfg(test)]
    fn new(catalog: ProviderCatalog, state_home: &std::path::Path) -> Self {
        Self {
            catalog: catalog.clone(),
            assignments: ModelAssignmentStore::in_home(state_home),
            bindings: SessionBindingStore::in_home(state_home),
            turn_routes: TurnRouteStore::in_home(state_home),
            registry: AgentRegistry::in_home(state_home),
            compiler: RouteCompiler::in_home(catalog, state_home),
        }
    }

    pub fn prepare_route(
        &self,
        owner_account_id: i64,
        request: RouteCompileRequest<'_>,
        policy: &AgentModelPolicy,
    ) -> Result<PreparedRoute> {
        self.compiler.compile(owner_account_id, request, policy)
    }

    pub(super) fn ensure_product_binding(
        &self,
        owner_account_id: i64,
        session_id: &str,
        agent_id: &str,
        role: &str,
    ) -> Result<SessionProviderBinding> {
        self.resolve_binding(
            owner_account_id,
            &BindingLookupRequest {
                session_id: session_id.to_owned(),
                role: role.to_owned(),
                agent_id: Some(agent_id.to_owned()),
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn agent_catalog_revision_for_test(&self) -> Result<u64> {
        Ok(self.registry.package_catalog()?.catalog_revision)
    }

    fn resolve_binding(
        &self,
        owner_account_id: i64,
        request: &BindingLookupRequest,
    ) -> Result<SessionProviderBinding> {
        let agent_id = self.require_session_owner(
            owner_account_id,
            &request.session_id,
            request.agent_id.as_deref(),
        )?;
        if let Some(current) =
            self.bindings
                .current(owner_account_id, &request.session_id, &request.role)?
        {
            ensure_agent_identity(&current, agent_id.as_deref())?;
            return Ok(current);
        }
        let route = self.prepare_route(
            owner_account_id,
            RouteCompileRequest {
                role: &request.role,
                agent_id: agent_id.as_deref(),
                session_id: Some(&request.session_id),
            },
            &self.policy_for(agent_id.as_deref())?,
        )?;
        self.bindings.bind_initial(
            owner_account_id,
            &request.session_id,
            &request.role,
            agent_id.as_deref(),
            &route,
        )
    }

    fn binding_history(
        &self,
        owner_account_id: i64,
        request: &BindingLookupRequest,
    ) -> Result<Vec<SessionProviderBinding>> {
        let agent_id = self.require_session_owner(
            owner_account_id,
            &request.session_id,
            request.agent_id.as_deref(),
        )?;
        let history =
            self.bindings
                .history(owner_account_id, &request.session_id, &request.role)?;
        if let Some(current) = history.last() {
            ensure_agent_identity(current, agent_id.as_deref())?;
        }
        Ok(history)
    }

    fn switch_binding(
        &self,
        owner_account_id: i64,
        request: &SwitchBindingRequest,
    ) -> Result<SessionProviderBinding> {
        let agent_id = self.require_session_owner(
            owner_account_id,
            &request.session_id,
            request.agent_id.as_deref(),
        )?;
        let current = self
            .bindings
            .current(owner_account_id, &request.session_id, &request.role)?
            .ok_or_else(|| anyhow!("Session Provider Binding is not initialized"))?;
        ensure_agent_identity(&current, agent_id.as_deref())?;

        let (reason, route) = match request.kind {
            BindingSwitchKind::ExplicitSwitch | BindingSwitchKind::CompatibleMigration => {
                if request.target_binding_revision.is_some() {
                    bail!("targetBindingRevision is only valid for rollback");
                }
                let route = self.prepare_route(
                    owner_account_id,
                    RouteCompileRequest {
                        role: &request.role,
                        agent_id: agent_id.as_deref(),
                        session_id: Some(&request.session_id),
                    },
                    &self.policy_for(agent_id.as_deref())?,
                )?;
                let reason = match request.kind {
                    BindingSwitchKind::ExplicitSwitch => BindingChangeReason::ExplicitSwitch,
                    BindingSwitchKind::CompatibleMigration => {
                        BindingChangeReason::CompatibleMigration
                    }
                    BindingSwitchKind::Rollback => unreachable!(),
                };
                (reason, route)
            }
            BindingSwitchKind::Rollback => {
                let target_revision = request
                    .target_binding_revision
                    .ok_or_else(|| anyhow!("rollback requires targetBindingRevision"))?;
                if target_revision >= current.binding_revision {
                    bail!("rollback target must be an older Binding revision");
                }
                let target = self.bindings.revision(
                    owner_account_id,
                    &request.session_id,
                    &request.role,
                    target_revision,
                )?;
                (BindingChangeReason::Rollback, target.route)
            }
        };
        self.bindings.append(
            owner_account_id,
            &request.session_id,
            &request.role,
            agent_id.as_deref(),
            reason,
            &route,
        )
    }

    fn turn_route_history(
        &self,
        owner_account_id: i64,
        request: &BindingLookupRequest,
    ) -> Result<Vec<TurnRouteRecord>> {
        self.require_session_owner(
            owner_account_id,
            &request.session_id,
            request.agent_id.as_deref(),
        )?;
        self.turn_routes
            .list_session(owner_account_id, &request.session_id, &request.role)
    }

    fn require_session_owner(
        &self,
        owner_account_id: i64,
        session_id: &str,
        requested_agent_id: Option<&str>,
    ) -> Result<Option<String>> {
        match self.registry.main_session_identity(session_id)? {
            Some((Some(actual_owner), actual_agent_id)) if actual_owner == owner_account_id => {
                if requested_agent_id.is_some_and(|requested| requested != actual_agent_id.as_str())
                {
                    bail!("session not found");
                }
                Ok(Some(actual_agent_id))
            }
            Some(_) => bail!("session not found"),
            None => Ok(requested_agent_id.map(str::to_owned)),
        }
    }

    fn policy_for(&self, agent_id: Option<&str>) -> Result<AgentModelPolicy> {
        agent_id
            .map(|agent_id| self.registry.model_policy(agent_id))
            .transpose()
            .map(|policy| policy.unwrap_or_default())
    }
}

fn ensure_agent_identity(
    binding: &SessionProviderBinding,
    requested_agent_id: Option<&str>,
) -> Result<()> {
    if binding.agent_id.as_deref() != requested_agent_id {
        bail!("Session Provider Binding agent identity does not match");
    }
    Ok(())
}

pub fn handle(
    service: &ModelRoutingService,
    owner_account_id: i64,
    args: &acp::ExtRequest,
) -> crate::extensions::ExtResult {
    let result = match args.method.as_ref() {
        PROVIDER_CATALOG_METHOD => serde_json::to_value(CatalogResponse {
            catalog: &service.catalog,
        })
        .map_err(Into::into),
        ASSIGNMENTS_LIST_METHOD => {
            service
                .assignments
                .list(owner_account_id)
                .and_then(|assignments| {
                    serde_json::to_value(AssignmentsResponse { assignments }).map_err(Into::into)
                })
        }
        ASSIGNMENTS_UPSERT_METHOD => {
            let request: UpsertAssignmentRequest = crate::extensions::parse_params(args)?;
            service
                .assignments
                .upsert(owner_account_id, request.assignment)
                .and_then(|assignment| {
                    serde_json::to_value(AssignmentResponse { assignment }).map_err(Into::into)
                })
        }
        ASSIGNMENTS_DELETE_METHOD => {
            let request: DeleteAssignmentRequest = crate::extensions::parse_params(args)?;
            service
                .assignments
                .delete(owner_account_id, &request.assignment_id)
                .and_then(|()| {
                    serde_json::to_value(DeleteAssignmentResponse { deleted: true })
                        .map_err(Into::into)
                })
        }
        BINDING_RESOLVE_METHOD => {
            let request: BindingLookupRequest = crate::extensions::parse_params(args)?;
            service
                .resolve_binding(owner_account_id, &request)
                .and_then(|binding| {
                    serde_json::to_value(BindingResponse { binding }).map_err(Into::into)
                })
        }
        BINDING_HISTORY_METHOD => {
            let request: BindingLookupRequest = crate::extensions::parse_params(args)?;
            service
                .binding_history(owner_account_id, &request)
                .and_then(|bindings| {
                    serde_json::to_value(BindingHistoryResponse { bindings }).map_err(Into::into)
                })
        }
        BINDING_SWITCH_METHOD => {
            let request: SwitchBindingRequest = crate::extensions::parse_params(args)?;
            service
                .switch_binding(owner_account_id, &request)
                .and_then(|binding| {
                    serde_json::to_value(BindingResponse { binding }).map_err(Into::into)
                })
        }
        TURN_ROUTES_LIST_METHOD => {
            let request: BindingLookupRequest = crate::extensions::parse_params(args)?;
            service
                .turn_route_history(owner_account_id, &request)
                .and_then(|turn_routes| {
                    serde_json::to_value(TurnRoutesResponse { turn_routes }).map_err(Into::into)
                })
        }
        other => Err(anyhow!(
            "unknown AgentMesh360 model routing extension method: {other}"
        )),
    };
    crate::extensions::to_ext_response(result)
}

#[derive(Clone, Debug)]
pub struct RouteCompileRequest<'a> {
    pub role: &'a str,
    pub agent_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRoute {
    pub provider_profile_id: String,
    pub provider_preset_id: Option<String>,
    pub provider_display_name: String,
    pub endpoint_classification: ProviderClassification,
    pub endpoint_origin: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub auth_kind: ProviderAuthKind,
    pub model_id: String,
    pub profile_route_revision: u64,
    pub assignment_id: String,
    #[serde(default = "default_assignment_role")]
    pub assignment_role: String,
    pub assignment_revision: u64,
    pub catalog_revision: u64,
    pub capability: ModelCapability,
    pub quirks: Vec<ProviderQuirk>,
    pub warnings: Vec<String>,
}

fn default_assignment_role() -> String {
    "main".into()
}

impl PreparedRoute {
    pub fn api_backend(&self) -> ApiBackend {
        match self.protocol {
            ProviderProtocol::OpenaiResponses => ApiBackend::Responses,
            ProviderProtocol::OpenaiChat => ApiBackend::ChatCompletions,
            ProviderProtocol::AnthropicMessages => ApiBackend::Messages,
        }
    }

    pub fn auth_scheme(&self) -> AuthScheme {
        match self.auth_kind {
            ProviderAuthKind::BearerApiKey => AuthScheme::Bearer,
            ProviderAuthKind::XApiKey => AuthScheme::XApiKey,
        }
    }
}

pub struct RouteCompiler {
    catalog: ProviderCatalog,
    profiles: ProviderProfileStore,
    assignments: ModelAssignmentStore,
}

impl RouteCompiler {
    fn in_home(catalog: ProviderCatalog, state_home: &std::path::Path) -> Self {
        Self {
            catalog,
            profiles: ProviderProfileStore::in_home(state_home),
            assignments: ModelAssignmentStore::in_home(state_home),
        }
    }

    pub fn compile(
        &self,
        owner_account_id: i64,
        request: RouteCompileRequest<'_>,
        policy: &AgentModelPolicy,
    ) -> Result<PreparedRoute> {
        let assignment = self.assignments.resolve_with_main_fallback(
            owner_account_id,
            request.role,
            request.agent_id,
            request.session_id,
        )?;
        let profile = self
            .profiles
            .get(owner_account_id, &assignment.provider_profile_id)?;
        if !profile
            .enabled_models
            .iter()
            .any(|model| model == &assignment.model_id)
        {
            bail!("assigned model is not enabled by the Provider Profile");
        }

        let mut warnings = Vec::new();
        if assignment.role != request.role {
            warnings.push(format!(
                "role {} uses fallback assignment role {}",
                request.role, assignment.role
            ));
        }
        let preset = profile
            .preset_id
            .as_deref()
            .and_then(|preset_id| self.catalog.provider(preset_id));
        if profile.preset_id.is_some() && preset.is_none() {
            warnings.push("provider preset is unavailable; using conservative capabilities".into());
        }
        let preset_matches_route = preset.is_some_and(|preset| {
            preset.protocol == profile.protocol && preset.auth_kind == profile.auth_kind
        });
        if preset.is_some() && !preset_matches_route {
            warnings.push(
                "profile protocol or authentication differs from its preset; quirks disabled"
                    .into(),
            );
        }

        let capability = if preset_matches_route {
            preset
                .and_then(|preset| {
                    preset
                        .models
                        .iter()
                        .find(|model| model.model_id == assignment.model_id)
                })
                .map(|model| model.capability.clone())
                .unwrap_or_else(|| {
                    warnings.push(
                        "model capability is not verified; using conservative unknown values"
                            .into(),
                    );
                    ModelCapability::unknown()
                })
        } else {
            ModelCapability::unknown()
        };
        let evaluation = policy.evaluate(&capability);
        if !evaluation.is_compatible() {
            bail!(
                "assigned model does not satisfy Agent policy: {}",
                evaluation.blockers.join(", ")
            );
        }
        warnings.extend(evaluation.unmet_preferences);

        let endpoint_origin = endpoint_origin(&profile.base_url)?;
        let endpoint_classification = preset
            .filter(|preset| {
                preset
                    .allowed_endpoint_origins
                    .iter()
                    .any(|allowed| allowed == &endpoint_origin)
            })
            .map_or(ProviderClassification::Custom, |preset| {
                preset.classification
            });
        let quirks = if preset_matches_route {
            preset
                .map(|preset| preset.quirks.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        Ok(PreparedRoute {
            provider_profile_id: profile.profile_id,
            provider_preset_id: profile.preset_id,
            provider_display_name: profile.display_name,
            endpoint_classification,
            endpoint_origin,
            protocol: profile.protocol,
            base_url: profile.base_url,
            auth_kind: profile.auth_kind,
            model_id: assignment.model_id,
            profile_route_revision: profile.route_revision,
            assignment_id: assignment.assignment_id,
            assignment_role: assignment.role,
            assignment_revision: assignment.assignment_revision,
            catalog_revision: self.catalog.catalog_revision,
            capability,
            quirks,
            warnings,
        })
    }
}

fn endpoint_origin(base_url: &str) -> Result<String> {
    let url = Url::parse(base_url)?;
    if url.host_str().is_none() {
        bail!("Provider endpoint host is unavailable");
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::agentmesh360::model_assignments::AssignmentScopeKind;
    use crate::agentmesh360::model_policy::CapabilityRequirement;
    use crate::agentmesh360::provider_catalog::CatalogLoadStatus;
    use crate::agentmesh360::provider_profiles::ProviderProfileInput;

    const TEST_CATALOG: &str = r#"{
      "schemaVersion": 1,
      "catalogRevision": 9,
      "providers": [{
        "presetId": "verified",
        "displayName": "Verified Provider",
        "classification": "official",
        "protocol": "openai_responses",
        "defaultBaseUrl": "https://models.example/v1",
        "authKind": "bearer_api_key",
        "allowedEndpointOrigins": ["https://models.example"],
        "quirks": [],
        "models": [{
          "modelId": "verified-model",
          "displayName": "Verified Model",
          "capability": {
            "contextWindow": 128000,
            "maxOutputTokens": 8192,
            "tools": "supported",
            "parallelToolCalls": "unknown",
            "vision": "unsupported",
            "structuredOutput": "supported",
            "reasoning": "unknown",
            "streaming": "supported",
            "source": "catalog"
          }
        }]
      }]
    }"#;

    fn setup() -> (
        tempfile::TempDir,
        ProviderCatalog,
        ProviderProfileStore,
        ModelAssignmentStore,
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let (catalog, status) = ProviderCatalog::from_trusted_document_or_builtin(TEST_CATALOG);
        assert_eq!(status, CatalogLoadStatus::TrustedDocument);
        let profiles = ProviderProfileStore::in_home(temp.path());
        let assignments = ModelAssignmentStore::in_home(temp.path());
        (temp, catalog, profiles, assignments)
    }

    fn insert_profile(profiles: &ProviderProfileStore, base_url: &str) {
        profiles
            .insert(
                17,
                "pp_verified",
                "credential://vault/h_00000000000000000000000000000001",
                "1234",
                &ProviderProfileInput {
                    preset_id: Some("verified".into()),
                    display_name: "Verified".into(),
                    protocol: ProviderProtocol::OpenaiResponses,
                    base_url: base_url.into(),
                    auth_kind: ProviderAuthKind::BearerApiKey,
                    enabled_models: vec!["verified-model".into()],
                }
                .normalized()
                .expect("valid profile"),
            )
            .expect("insert profile");
    }

    fn insert_assignment(assignments: &ModelAssignmentStore) {
        assignments
            .upsert(
                17,
                ModelAssignmentInput {
                    scope_kind: AssignmentScopeKind::Global,
                    scope_id: None,
                    role: "main".into(),
                    provider_profile_id: "pp_verified".into(),
                    model_id: "verified-model".into(),
                },
            )
            .expect("insert assignment");
    }

    #[test]
    fn compiles_a_non_secret_route_to_existing_grok_backend_types() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://models.example/v1");
        insert_assignment(&assignments);
        let compiler = RouteCompiler::in_home(catalog, temp.path());
        let policy = AgentModelPolicy {
            tools: CapabilityRequirement::Required,
            structured_output: CapabilityRequirement::Required,
            streaming: CapabilityRequirement::Required,
            min_context_window: Some(100_000),
            ..AgentModelPolicy::default()
        };

        let route = compiler
            .compile(
                17,
                RouteCompileRequest {
                    role: "main",
                    agent_id: Some("job-agent"),
                    session_id: None,
                },
                &policy,
            )
            .expect("compile route");

        assert_eq!(route.api_backend(), ApiBackend::Responses);
        assert_eq!(route.auth_scheme(), AuthScheme::Bearer);
        assert_eq!(
            route.endpoint_classification,
            ProviderClassification::Official
        );
        assert_eq!(route.catalog_revision, 9);
        let json = serde_json::to_string(&route).expect("serialize route");
        assert!(!json.contains("credential"));
        assert!(!json.contains("1234"));
        assert!(!json.contains("apiKey"));
    }

    #[test]
    fn auxiliary_route_records_main_assignment_fallback_without_changing_requested_role() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://models.example/v1");
        insert_assignment(&assignments);
        let compiler = RouteCompiler::in_home(catalog, temp.path());

        let route = compiler
            .compile(
                17,
                RouteCompileRequest {
                    role: "vision",
                    agent_id: Some("job-agent"),
                    session_id: Some("session-a"),
                },
                &AgentModelPolicy::default(),
            )
            .expect("compile auxiliary fallback route");

        assert_eq!(route.assignment_role, "main");
        assert_eq!(route.model_id, "verified-model");
        assert!(
            route
                .warnings
                .iter()
                .any(|warning| warning.contains("vision uses fallback assignment role main"))
        );
        let mut legacy = serde_json::to_value(&route).expect("serialize route");
        legacy
            .as_object_mut()
            .expect("route object")
            .remove("assignmentRole");
        assert_eq!(
            serde_json::from_value::<PreparedRoute>(legacy)
                .expect("legacy route without assignmentRole")
                .assignment_role,
            "main"
        );
    }

    #[test]
    fn rejects_required_unknown_capability_before_sampling() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://models.example/v1");
        insert_assignment(&assignments);
        let compiler = RouteCompiler::in_home(catalog, temp.path());
        let policy = AgentModelPolicy {
            vision: CapabilityRequirement::Required,
            ..AgentModelPolicy::default()
        };

        let error = compiler
            .compile(
                17,
                RouteCompileRequest {
                    role: "main",
                    agent_id: None,
                    session_id: None,
                },
                &policy,
            )
            .expect_err("vision is unsupported");

        assert!(error.to_string().contains("does not satisfy Agent policy"));
    }

    #[test]
    fn custom_endpoint_is_not_mislabeled_as_official() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://gateway.example/v1");
        insert_assignment(&assignments);
        let compiler = RouteCompiler::in_home(catalog, temp.path());

        let route = compiler
            .compile(
                17,
                RouteCompileRequest {
                    role: "main",
                    agent_id: None,
                    session_id: None,
                },
                &AgentModelPolicy::default(),
            )
            .expect("compile custom endpoint");

        assert_eq!(
            route.endpoint_classification,
            ProviderClassification::Custom
        );
        assert_eq!(route.endpoint_origin, "https://gateway.example");
    }

    #[test]
    fn routing_management_responses_do_not_expose_account_or_secret_fields() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://models.example/v1");
        let service = ModelRoutingService::new(catalog, temp.path());
        let assignment = assignments
            .upsert(
                17,
                ModelAssignmentInput {
                    scope_kind: AssignmentScopeKind::Global,
                    scope_id: None,
                    role: "main".into(),
                    provider_profile_id: "pp_verified".into(),
                    model_id: "verified-model".into(),
                },
            )
            .expect("assignment");
        let response = serde_json::to_string(&AssignmentResponse { assignment })
            .expect("serialize assignment response");

        assert!(!response.contains("ownerAccountId"));
        assert!(!response.contains("credential"));
        assert_eq!(service.catalog.catalog_revision, 9);
        let route = service
            .prepare_route(
                17,
                RouteCompileRequest {
                    role: "main",
                    agent_id: None,
                    session_id: None,
                },
                &AgentModelPolicy::default(),
            )
            .expect("service prepares route");
        assert_eq!(route.model_id, "verified-model");

        let raw = serde_json::value::to_raw_value(&serde_json::json!({
            "assignmentId": "missing"
        }))
        .expect("raw request");
        let request = acp::ExtRequest::new(ASSIGNMENTS_DELETE_METHOD, Arc::from(raw));
        let response = handle(&service, 18, &request).expect("extension response");
        assert!(response.0.get().contains("model assignment not found"));
    }

    #[test]
    fn binding_freezes_route_until_explicit_switch_and_survives_profile_deletion() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://models.example/v1");
        insert_assignment(&assignments);
        let service = ModelRoutingService::new(catalog, temp.path());
        let lookup = BindingLookupRequest {
            session_id: "session-a".into(),
            role: "main".into(),
            agent_id: Some("job-agent".into()),
        };

        let first = service
            .resolve_binding(17, &lookup)
            .expect("initial binding");
        profiles
            .update(
                17,
                "pp_verified",
                &ProviderProfileInput {
                    preset_id: Some("verified".into()),
                    display_name: "Verified".into(),
                    protocol: ProviderProtocol::OpenaiResponses,
                    base_url: "https://gateway.example/v1".into(),
                    auth_kind: ProviderAuthKind::BearerApiKey,
                    enabled_models: vec!["verified-model".into()],
                }
                .normalized()
                .expect("updated profile"),
            )
            .expect("update profile");

        let unchanged = service
            .resolve_binding(17, &lookup)
            .expect("existing binding");
        assert_eq!(unchanged, first);
        let switched = service
            .switch_binding(
                17,
                &SwitchBindingRequest {
                    session_id: lookup.session_id.clone(),
                    role: lookup.role.clone(),
                    agent_id: lookup.agent_id.clone(),
                    kind: BindingSwitchKind::ExplicitSwitch,
                    target_binding_revision: None,
                },
            )
            .expect("explicit switch");
        assert_eq!(switched.binding_revision, 2);
        assert_eq!(switched.route.endpoint_origin, "https://gateway.example");
        assert_eq!(first.route.endpoint_origin, "https://models.example");

        profiles.delete(17, "pp_verified").expect("delete profile");
        assert_eq!(
            service
                .binding_history(17, &lookup)
                .expect("preserved history")
                .len(),
            2
        );
        assert_eq!(
            service
                .resolve_binding(17, &lookup)
                .expect("preserved current"),
            switched
        );
        let switch_error = service
            .switch_binding(
                17,
                &SwitchBindingRequest {
                    session_id: lookup.session_id.clone(),
                    role: lookup.role.clone(),
                    agent_id: lookup.agent_id.clone(),
                    kind: BindingSwitchKind::ExplicitSwitch,
                    target_binding_revision: None,
                },
            )
            .expect_err("deleted profile cannot compile a new route");
        assert!(switch_error.to_string().contains("no model assignment"));

        let rollback = service
            .switch_binding(
                17,
                &SwitchBindingRequest {
                    session_id: lookup.session_id.clone(),
                    role: lookup.role.clone(),
                    agent_id: lookup.agent_id.clone(),
                    kind: BindingSwitchKind::Rollback,
                    target_binding_revision: Some(1),
                },
            )
            .expect("append rollback snapshot");
        assert_eq!(rollback.binding_revision, 3);
        assert_eq!(rollback.change_reason, BindingChangeReason::Rollback);
        assert_eq!(rollback.route, first.route);
    }

    #[test]
    fn binding_fails_closed_for_unknown_product_agent_policy() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://models.example/v1");
        insert_assignment(&assignments);
        let service = ModelRoutingService::new(catalog, temp.path());

        let error = service
            .resolve_binding(
                17,
                &BindingLookupRequest {
                    session_id: "non-product-session".into(),
                    role: "main".into(),
                    agent_id: Some("unknown-agent".into()),
                },
            )
            .expect_err("unknown product Agent policy must fail closed");

        assert!(
            error
                .to_string()
                .contains("unknown AgentMesh360 product agent")
        );
    }

    #[test]
    fn binding_rejects_another_accounts_product_session() {
        let (temp, catalog, profiles, assignments) = setup();
        insert_profile(&profiles, "https://models.example/v1");
        insert_assignment(&assignments);
        let registry = AgentRegistry::in_home(temp.path());
        registry
            .claim_legacy_and_seed(17)
            .expect("seed product agents");
        let product_agent = registry
            .prepare_activation(17, "job-agent")
            .expect("prepare product agent");
        let session_id = product_agent.main_session_id.expect("main session");
        let service = ModelRoutingService::new(catalog, temp.path());
        let request = BindingLookupRequest {
            session_id,
            role: "main".into(),
            agent_id: Some("job-agent".into()),
        };

        let error = service
            .resolve_binding(18, &request)
            .expect_err("other account must not bind product session");
        assert_eq!(error.to_string(), "session not found");
    }
}
