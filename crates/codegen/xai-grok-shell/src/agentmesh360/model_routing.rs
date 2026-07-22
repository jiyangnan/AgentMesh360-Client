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

pub const PROVIDER_CATALOG_METHOD: &str = "x.agentmesh360/providers/catalog";
pub const ASSIGNMENTS_LIST_METHOD: &str = "x.agentmesh360/model-assignments/list";
pub const ASSIGNMENTS_UPSERT_METHOD: &str = "x.agentmesh360/model-assignments/upsert";
pub const ASSIGNMENTS_DELETE_METHOD: &str = "x.agentmesh360/model-assignments/delete";

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        PROVIDER_CATALOG_METHOD
            | ASSIGNMENTS_LIST_METHOD
            | ASSIGNMENTS_UPSERT_METHOD
            | ASSIGNMENTS_DELETE_METHOD
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

pub struct ModelRoutingService {
    catalog: ProviderCatalog,
    assignments: ModelAssignmentStore,
    compiler: RouteCompiler,
}

impl Default for ModelRoutingService {
    fn default() -> Self {
        let catalog = ProviderCatalog::builtin();
        let state_home = super::state::default_state_home();
        Self {
            catalog: catalog.clone(),
            assignments: ModelAssignmentStore::in_home(&state_home),
            compiler: RouteCompiler::in_home(catalog, &state_home),
        }
    }
}

impl ModelRoutingService {
    #[cfg(test)]
    fn new(catalog: ProviderCatalog, state_home: &std::path::Path) -> Self {
        Self {
            catalog: catalog.clone(),
            assignments: ModelAssignmentStore::in_home(state_home),
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
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
    pub assignment_revision: u64,
    pub catalog_revision: u64,
    pub capability: ModelCapability,
    pub quirks: Vec<ProviderQuirk>,
    pub warnings: Vec<String>,
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
        let assignment = self.assignments.resolve(
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
}
