//! AgentMesh360's persistent first-party product-agent layer.
//!
//! Grok Build remains the execution harness and the source of truth for session
//! transcripts, tools, permissions, memory, and subagents. This module adds the
//! stable product identity that a desktop client needs: one catalog entry and one
//! deterministic main conversation per activated product agent.

mod access;
mod agent_overlays;
mod agent_packages;
mod background_activities;
mod credential_lease;
mod credential_vault;
mod dictation;
mod input_capabilities;
mod model_assignments;
mod model_policy;
mod model_routing;
mod package_artifact;
pub mod package_authoring;
mod package_canary;
mod package_delivery;
mod package_downloader;
mod package_installer;
mod package_management;
mod package_registry_fetcher;
mod package_registry_snapshot;
mod package_release;
pub mod package_release_authoring;
mod package_skill_export;
mod package_trust;
mod package_trust_cache;
mod provider_catalog;
mod provider_probes;
mod provider_profiles;
mod providers;
pub mod registry;
mod session_bindings;
mod session_plan;
mod state;
mod turn_routes;
pub(crate) mod turn_submission;
mod workspace_artifacts;
mod workspace_project_state;

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use agent_client_protocol as acp;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent::MvpAgent;
use crate::agent::mvp_agent::LocalRef;
use crate::agent::roster::RosterActivity;
use registry::{AgentRegistry, ProductAgentRecord};

pub const ACCOUNT_BOOTSTRAP_METHOD: &str = "x.agentmesh360/account/bootstrap";
pub const AGENTS_LIST_METHOD: &str = "x.agentmesh360/agents/list";
pub const AGENTS_ACTIVATE_METHOD: &str = "x.agentmesh360/agents/activate";
pub const AGENT_ARTIFACTS_LIST_METHOD: &str = "x.agentmesh360/agents/artifacts/list";
pub const AGENT_BACKGROUND_ACTIVITIES_LIST_METHOD: &str =
    "x.agentmesh360/agents/background-activities/list";
pub const AGENT_PROJECT_STATE_GET_METHOD: &str = "x.agentmesh360/agents/project-state/get";
pub const AGENT_SESSION_PLAN_GET_METHOD: &str = "x.agentmesh360/agents/session-plan/get";
pub const AGENT_INPUT_CAPABILITIES_GET_METHOD: &str = input_capabilities::GET_METHOD;
pub const AGENT_PACKAGES_CATALOG_METHOD: &str = "x.agentmesh360/agent-packages/catalog";
pub const AGENT_PACKAGES_STATUS_METHOD: &str = "x.agentmesh360/agent-packages/status";
pub use package_management::{
    APPROVE_METHOD as AGENT_PACKAGES_APPROVE_METHOD,
    DOWNLOAD_METHOD as AGENT_PACKAGES_DOWNLOAD_METHOD,
    RECONCILE_METHOD as AGENT_PACKAGES_RECONCILE_METHOD,
    REMOTE_CATALOG_METHOD as AGENT_PACKAGES_REMOTE_CATALOG_METHOD,
    REMOTE_REFRESH_METHOD as AGENT_PACKAGES_REMOTE_REFRESH_METHOD,
    ROLLBACK_METHOD as AGENT_PACKAGES_ROLLBACK_METHOD,
};

pub(crate) struct AgentMesh360Runtime {
    registry: AgentRegistry,
    providers: providers::ProviderService<credential_vault::RuntimeCredentialVault>,
    provider_probes:
        provider_probes::ProviderProbeService<credential_vault::RuntimeCredentialVault>,
    model_routing: model_routing::ModelRoutingService,
    package_delivery: package_delivery::PackageDeliveryService,
    package_registry_fetcher: package_registry_fetcher::PackageRegistryFetcher,
    access: access::ClientAccess,
    state_home: PathBuf,
    credential_vault: credential_vault::RuntimeCredentialVault,
    dictation: dictation::DictationService,
    pinned_sessions: RefCell<HashSet<acp::SessionId>>,
    applied_agent_definition_revisions: RefCell<HashMap<String, AppliedAgentDefinitionRevision>>,
    restore_started: Cell<bool>,
    access_generation: Cell<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AppliedAgentDefinitionRevision {
    package_version: String,
    definition_sha256: String,
    agent_md_revision: u64,
    user_md_revision: u64,
}

impl AppliedAgentDefinitionRevision {
    fn from_definition(
        package_version: impl Into<String>,
        overlay_revisions: (u64, u64),
        definition: &xai_grok_agent::AgentDefinition,
    ) -> Result<Self> {
        let definition = serde_json::to_vec(&definition.to_json_value())
            .context("serialize Agent runtime definition")?;
        Ok(Self {
            package_version: package_version.into(),
            definition_sha256: format!("{:x}", Sha256::digest(definition)),
            agent_md_revision: overlay_revisions.0,
            user_md_revision: overlay_revisions.1,
        })
    }
}

impl Default for AgentMesh360Runtime {
    fn default() -> Self {
        let state_home = state::default_state_home();
        let credential_vault = credential_vault::RuntimeCredentialVault::default();
        Self::new(
            state_home,
            access::ClientAccess::default(),
            credential_vault,
        )
    }
}

impl AgentMesh360Runtime {
    fn new(
        state_home: PathBuf,
        access: access::ClientAccess,
        credential_vault: credential_vault::RuntimeCredentialVault,
    ) -> Self {
        let registry = AgentRegistry::in_home(&state_home);
        let model_routing = model_routing::ModelRoutingService::in_home_with_registry(
            &state_home,
            registry.clone(),
        );
        let package_delivery =
            package_delivery::PackageDeliveryService::with_registry(registry.clone());
        Self {
            registry,
            providers: providers::ProviderService::new(
                provider_profiles::ProviderProfileStore::in_home(&state_home),
                credential_vault.clone(),
            ),
            provider_probes: provider_probes::ProviderProbeService::in_home(
                &state_home,
                credential_vault.clone(),
            ),
            model_routing,
            package_delivery,
            package_registry_fetcher: package_registry_fetcher::PackageRegistryFetcher::embedded(
                &state_home,
            ),
            access,
            state_home,
            credential_vault,
            dictation: dictation::DictationService::default(),
            pinned_sessions: RefCell::default(),
            applied_agent_definition_revisions: RefCell::default(),
            restore_started: Cell::default(),
            access_generation: Cell::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_host_test(
        state_home: impl Into<PathBuf>,
        core_base_url: impl Into<String>,
    ) -> Self {
        Self::new(
            state_home.into(),
            access::ClientAccess::new(core_base_url),
            credential_vault::RuntimeCredentialVault::Memory(
                credential_vault::MemoryCredentialVault::default(),
            ),
        )
    }

    #[cfg(test)]
    pub(crate) fn remove_credential_for_host_test(
        &self,
        owner_account_id: i64,
        profile_id: &str,
    ) -> Result<()> {
        use credential_vault::CredentialVault as _;

        let profile = provider_profiles::ProviderProfileStore::in_home(&self.state_home)
            .get(owner_account_id, profile_id)?;
        let credential_ref = credential_vault::CredentialRef::parse(profile.credential_ref)?;
        self.credential_vault.delete(&credential_ref)?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn bootstrap_for_host_test(&self, access_token: &str) -> Result<()> {
        self.access
            .bootstrap(access_token)
            .await
            .map(|_| ())
            .map_err(anyhow::Error::new)
    }

    #[cfg(test)]
    pub(crate) fn invalidate_access_for_host_test(&self) {
        self.access.invalidate();
    }

    #[cfg(test)]
    pub(crate) fn configure_product_route_for_host_test(
        &self,
        owner_account_id: i64,
        agent_id: &str,
        base_url: &str,
        model_id: &str,
        api_key: &str,
    ) -> Result<(
        String,
        turn_submission::AgentMeshSessionRouteContext,
        String,
    )> {
        let profile = self.providers.create_for_host_test(
            owner_account_id,
            provider_profiles::ProviderProfileInput {
                preset_id: Some("compatible-openai-responses".into()),
                display_name: "Host route test".into(),
                protocol: provider_profiles::ProviderProtocol::OpenaiResponses,
                base_url: base_url.into(),
                auth_kind: provider_profiles::ProviderAuthKind::BearerApiKey,
                enabled_models: vec![model_id.into()],
            },
            api_key.into(),
        )?;
        let profile_id = profile.profile_id;
        model_assignments::ModelAssignmentStore::in_home(&self.state_home).upsert(
            owner_account_id,
            model_assignments::ModelAssignmentInput {
                scope_kind: model_assignments::AssignmentScopeKind::Agent,
                scope_id: Some(agent_id.into()),
                role: "main".into(),
                provider_profile_id: profile_id.clone(),
                model_id: model_id.into(),
            },
        )?;
        let record = self
            .registry
            .prepare_activation(owner_account_id, agent_id)?;
        let session_id = record
            .main_session_id
            .ok_or_else(|| anyhow::anyhow!("test product Agent has no Main Session"))?;
        let context = self
            .session_route_context(&acp::SessionId::new(session_id.clone()))?
            .ok_or_else(|| anyhow::anyhow!("test product Session has no route context"))?;
        Ok((session_id, context, profile_id))
    }

    #[cfg(test)]
    pub(crate) fn configure_role_assignment_for_host_test(
        &self,
        owner_account_id: i64,
        agent_id: &str,
        role: &str,
        base_url: &str,
        model_id: &str,
        api_key: &str,
    ) -> Result<String> {
        let profile = self.providers.create_for_host_test(
            owner_account_id,
            provider_profiles::ProviderProfileInput {
                preset_id: Some("compatible-openai-responses".into()),
                display_name: format!("Host {role} route test"),
                protocol: provider_profiles::ProviderProtocol::OpenaiResponses,
                base_url: base_url.into(),
                auth_kind: provider_profiles::ProviderAuthKind::BearerApiKey,
                enabled_models: vec![model_id.into()],
            },
            api_key.into(),
        )?;
        let profile_id = profile.profile_id;
        model_assignments::ModelAssignmentStore::in_home(&self.state_home).upsert(
            owner_account_id,
            model_assignments::ModelAssignmentInput {
                scope_kind: model_assignments::AssignmentScopeKind::Agent,
                scope_id: Some(agent_id.into()),
                role: role.into(),
                provider_profile_id: profile_id.clone(),
                model_id: model_id.into(),
            },
        )?;
        Ok(profile_id)
    }

    #[cfg(test)]
    pub(crate) fn turn_routes_for_host_test(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
    ) -> Result<Vec<turn_routes::TurnRouteRecord>> {
        turn_routes::TurnRouteStore::in_home(&self.state_home).list_session(
            owner_account_id,
            session_id,
            role,
        )
    }

    pub(crate) fn registry(&self) -> &AgentRegistry {
        &self.registry
    }

    pub(crate) fn refresh_package_catalog(&self) -> Result<()> {
        self.registry.refresh_package_catalog().map(|_| ())
    }

    pub(crate) fn package_delivery(&self) -> &package_delivery::PackageDeliveryService {
        &self.package_delivery
    }

    pub(crate) fn pin(&self, session_id: acp::SessionId) {
        self.pinned_sessions.borrow_mut().insert(session_id);
    }

    pub(crate) fn is_pinned(&self, session_id: &acp::SessionId) -> bool {
        self.pinned_sessions.borrow().contains(session_id)
    }

    fn suspend_residency(&self) -> bool {
        let had_pins = !self.pinned_sessions.borrow().is_empty();
        self.pinned_sessions.borrow_mut().clear();
        self.applied_agent_definition_revisions.borrow_mut().clear();
        let had_restore = self.restore_started.replace(false);
        had_pins || had_restore
    }

    fn mark_agent_definition_applied(
        &self,
        session_id: &acp::SessionId,
        revision: AppliedAgentDefinitionRevision,
    ) {
        self.applied_agent_definition_revisions
            .borrow_mut()
            .insert(session_id.0.to_string(), revision);
    }

    fn applied_agent_definition_revision(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<AppliedAgentDefinitionRevision> {
        self.applied_agent_definition_revisions
            .borrow()
            .get(session_id.0.as_ref())
            .cloned()
    }

    fn record_activation_definition_state(
        &self,
        session_id: &acp::SessionId,
        revision: AppliedAgentDefinitionRevision,
        resumed: bool,
    ) {
        if resumed {
            // A top-level Grok session deliberately keeps the System message
            // persisted in its conversation. Loading it with a newer Package
            // profile therefore does not prove that the new profile is active.
            // Leave the revision unknown so the next Prompt rebuilds the
            // harness before Sampling while preserving the conversation.
            self.applied_agent_definition_revisions
                .borrow_mut()
                .remove(session_id.0.as_ref());
        } else {
            self.mark_agent_definition_applied(session_id, revision);
        }
    }

    fn next_access_generation(&self) -> u64 {
        let next = self.access_generation.get().wrapping_add(1);
        self.access_generation.set(next);
        next
    }

    pub(crate) fn session_route_context(
        &self,
        session_id: &acp::SessionId,
    ) -> Result<Option<turn_submission::AgentMeshSessionRouteContext>> {
        let Some((owner_account_id, agent_id)) =
            self.registry.main_session_identity(session_id.0.as_ref())?
        else {
            return Ok(None);
        };
        let Some(owner_account_id) = owner_account_id else {
            return Ok(None);
        };
        if self.access.current_account_id() != Some(owner_account_id) {
            bail!("product Session account access is unavailable");
        }
        Ok(Some(turn_submission::AgentMeshSessionRouteContext::new(
            owner_account_id,
            agent_id,
            self.access.guard(owner_account_id),
            self.state_home.clone(),
            self.credential_vault.clone(),
            self.registry.clone(),
        )))
    }
}

pub(crate) use turn_submission::ProductTurnRoute;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapRequest {
    access_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateRequest {
    agent_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentListResponse {
    agents: Vec<ProductAgentRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCustomizationGetRequest {
    agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCustomizationUpsertRequest {
    agent_id: String,
    kind: agent_overlays::AgentOverlayKind,
    content: String,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCustomizationClearRequest {
    agent_id: String,
    kind: agent_overlays::AgentOverlayKind,
    expected_revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPackageCatalogResponse<'a> {
    catalog: &'a agent_packages::AgentPackageCatalog,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPackageStatusResponse {
    catalog_generation: u64,
    catalog_revision: Option<u64>,
    remote_registry: package_registry_fetcher::PackageRegistryFetchStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_refresh_issue: Option<package_installer::PackageStatusIssue>,
    packages: Vec<package_installer::InstalledPackageStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivateResponse {
    agent: ProductAgentRecord,
    resumed: bool,
}

pub(crate) async fn handle(
    agent: &MvpAgent,
    args: &acp::ExtRequest,
) -> crate::extensions::ExtResult {
    if args.method.as_ref() != ACCOUNT_BOOTSTRAP_METHOD {
        require_runtime_access(agent)?;
    }
    let result = match args.method.as_ref() {
        ACCOUNT_BOOTSTRAP_METHOD => {
            let request: BootstrapRequest = crate::extensions::parse_params(args)?;
            let access_generation = agent.agentmesh360.next_access_generation();
            let previous_account_id = agent.agentmesh360.access.current_account_id();
            match agent
                .agentmesh360
                .access
                .bootstrap(&request.access_token)
                .await
            {
                Ok(response) => {
                    if agent.agentmesh360.access.is_granted() {
                        let owner_account_id = response.account.account_id;
                        if previous_account_id != Some(owner_account_id) {
                            suspend_product_agents(agent, true);
                        }
                        if let Err(error) = agent
                            .agentmesh360
                            .registry()
                            .claim_legacy_and_seed(owner_account_id)
                        {
                            agent.agentmesh360.access.invalidate();
                            suspend_product_agents(agent, true);
                            tracing::error!(
                                %error,
                                owner_account_id,
                                "failed to initialize account-scoped AgentMesh360 agents"
                            );
                            return Err(acp::Error::internal_error()
                                .data("failed to initialize AgentMesh360 account state"));
                        }
                        spawn_restore_activated_agents(agent);
                        spawn_access_expiry(agent, access_generation);
                        spawn_package_registry_refresh(agent);
                    } else {
                        suspend_product_agents(agent, true);
                    }
                    serde_json::to_value(response).map_err(Into::into)
                }
                Err(error) => {
                    suspend_product_agents(agent, true);
                    return Err(error.to_acp_error());
                }
            }
        }
        AGENTS_LIST_METHOD => list_agents(agent).map(|agents| {
            serde_json::to_value(AgentListResponse { agents })
                .expect("AgentListResponse is serializable")
        }),
        AGENT_PACKAGES_CATALOG_METHOD => package_catalog(agent),
        AGENT_PACKAGES_STATUS_METHOD => package_status(agent),
        AGENTS_ACTIVATE_METHOD => {
            let request: ActivateRequest = crate::extensions::parse_params(args)?;
            activate(agent, &request.agent_id)
                .await
                .and_then(|response| serde_json::to_value(response).map_err(Into::into))
        }
        agent_overlays::AGENT_CUSTOMIZATION_GET_METHOD => {
            let request: AgentCustomizationGetRequest = crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            agent_overlays::AgentOverlayStore::in_home(&agent.agentmesh360.state_home)
                .snapshot(
                    agent.agentmesh360.registry(),
                    owner_account_id,
                    &request.agent_id,
                )
                .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
        }
        agent_overlays::AGENT_CUSTOMIZATION_UPSERT_METHOD => {
            let request: AgentCustomizationUpsertRequest = crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            agent_overlays::AgentOverlayStore::in_home(&agent.agentmesh360.state_home)
                .upsert(
                    agent.agentmesh360.registry(),
                    owner_account_id,
                    &request.agent_id,
                    request.kind,
                    &request.content,
                    request.expected_revision,
                )
                .and_then(|record| serde_json::to_value(record).map_err(Into::into))
        }
        agent_overlays::AGENT_CUSTOMIZATION_CLEAR_METHOD => {
            let request: AgentCustomizationClearRequest = crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            agent_overlays::AgentOverlayStore::in_home(&agent.agentmesh360.state_home)
                .clear(
                    agent.agentmesh360.registry(),
                    owner_account_id,
                    &request.agent_id,
                    request.kind,
                    request.expected_revision,
                )
                .and_then(|record| serde_json::to_value(record).map_err(Into::into))
        }
        AGENT_ARTIFACTS_LIST_METHOD => {
            let request: workspace_artifacts::WorkspaceArtifactListRequest =
                crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            workspace_artifacts::list(
                agent.agentmesh360.registry(),
                owner_account_id,
                &request.agent_id,
            )
            .and_then(|response| serde_json::to_value(response).map_err(Into::into))
        }
        AGENT_PROJECT_STATE_GET_METHOD => {
            let request: workspace_project_state::WorkspaceProjectStateRequest =
                crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            workspace_project_state::get(
                agent.agentmesh360.registry(),
                owner_account_id,
                &request.agent_id,
            )
            .and_then(|response| serde_json::to_value(response).map_err(Into::into))
        }
        AGENT_BACKGROUND_ACTIVITIES_LIST_METHOD => {
            let request: background_activities::BackgroundActivityListRequest =
                crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            background_activities::list(
                agent,
                agent.agentmesh360.registry(),
                owner_account_id,
                &request.agent_id,
            )
            .await
            .and_then(|response| serde_json::to_value(response).map_err(Into::into))
        }
        AGENT_SESSION_PLAN_GET_METHOD => {
            let request: session_plan::SessionPlanRequest = crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            session_plan::get(
                agent,
                agent.agentmesh360.registry(),
                owner_account_id,
                &request.agent_id,
            )
            .await
            .and_then(|response| serde_json::to_value(response).map_err(Into::into))
        }
        AGENT_INPUT_CAPABILITIES_GET_METHOD => {
            let request: input_capabilities::InputCapabilitiesRequest =
                crate::extensions::parse_params(args)?;
            let owner_account_id = current_account_id(agent)?;
            input_capabilities::get(agent, owner_account_id, &request)
                .and_then(|response| serde_json::to_value(response).map_err(Into::into))
        }
        method if package_management::handles(method) => {
            return package_management::handle(
                &agent.agentmesh360.package_delivery,
                &agent.agentmesh360.package_registry_fetcher,
                &agent.agentmesh360.access,
                args,
            )
            .await;
        }
        method if model_routing::handles(method) => {
            let owner_account_id = agent
                .agentmesh360
                .access
                .current_account_id()
                .ok_or_else(|| anyhow!("AgentMesh360 account access is unavailable"))?;
            return model_routing::handle(
                &agent.agentmesh360.model_routing,
                owner_account_id,
                args,
            );
        }
        method if provider_probes::handles(method) => {
            let owner_account_id = agent
                .agentmesh360
                .access
                .current_account_id()
                .ok_or_else(|| anyhow!("AgentMesh360 account access is unavailable"))?;
            return provider_probes::handle(
                &agent.agentmesh360.provider_probes,
                owner_account_id,
                args,
                &|| {
                    agent
                        .agentmesh360
                        .access
                        .require()
                        .map_err(|_| anyhow!("AgentMesh360 subscription access is unavailable"))
                },
            )
            .await;
        }
        method if dictation::handles(method) => {
            return dictation::handle(agent, args).await;
        }
        method if method.starts_with("x.agentmesh360/providers/") => {
            let owner_account_id = agent
                .agentmesh360
                .access
                .current_account_id()
                .ok_or_else(|| anyhow!("AgentMesh360 account access is unavailable"))?;
            return providers::handle(&agent.agentmesh360.providers, owner_account_id, args);
        }
        other => Err(anyhow!("unknown AgentMesh360 extension method: {other}")),
    };
    crate::extensions::to_ext_response(result)
}

fn spawn_access_expiry(agent: &MvpAgent, access_generation: u64) {
    let Some(delay) = agent.agentmesh360.access.remaining_validity() else {
        return;
    };
    let agent_ref = LocalRef::new(agent);
    tokio::task::spawn_local(async move {
        tokio::time::sleep(delay).await;
        let agent = agent_ref.get();
        if agent.agentmesh360.access_generation.get() != access_generation {
            return;
        }
        if agent.agentmesh360.access.require().is_err() {
            suspend_product_agents(agent, true);
        }
    });
}

fn spawn_package_registry_refresh(agent: &MvpAgent) {
    if matches!(
        agent
            .agentmesh360
            .package_registry_fetcher
            .status(&agent.agentmesh360.access)
            .outcome,
        package_registry_fetcher::PackageRegistryFetchOutcome::Disabled
    ) {
        return;
    }
    let agent_ref = LocalRef::new(agent);
    tokio::task::spawn_local(async move {
        let agent = agent_ref.get();
        let status = agent
            .agentmesh360
            .package_registry_fetcher
            .refresh(&agent.agentmesh360.access)
            .await;
        if matches!(
            status.outcome,
            package_registry_fetcher::PackageRegistryFetchOutcome::Unavailable
        ) {
            tracing::warn!(
                reason = ?status.reason,
                "Agent Package remote registry is unavailable"
            );
        }
    });
}

fn suspend_product_agents(agent: &MvpAgent, force_notify: bool) {
    let dictation_changed = agent.agentmesh360.dictation.cancel_all();
    let residency_changed = agent.agentmesh360.suspend_residency();
    if !force_notify && !residency_changed && !dictation_changed {
        return;
    }
    let removed = agent
        .agentmesh360
        .registry()
        .all_main_session_ids()
        .map(|ids| ids.into_iter().collect())
        .unwrap_or_default();
    agent.emit_roster_changed(Vec::new(), removed);
}

fn require_runtime_access(agent: &MvpAgent) -> Result<(), acp::Error> {
    agent.agentmesh360.access.require().inspect_err(|_| {
        suspend_product_agents(agent, false);
    })
}

pub(crate) fn require_product_session_access(
    agent: &MvpAgent,
    session_id: &acp::SessionId,
) -> Result<(), acp::Error> {
    let owner_account_id = agent
        .agentmesh360
        .registry()
        .main_session_owner(session_id.0.as_ref())
        .map_err(|_| {
            acp::Error::internal_error().data("failed to verify AgentMesh360 session identity")
        })?;
    let Some(owner_account_id) = owner_account_id else {
        return Ok(());
    };

    require_runtime_access(agent)?;
    let current_account_id = agent
        .agentmesh360
        .access
        .current_account_id()
        .ok_or_else(|| acp::Error::auth_required().data("AgentMesh360 access is unavailable"))?;
    if owner_account_id != Some(current_account_id) {
        return Err(acp::Error::invalid_params().data("session not found"));
    }
    Ok(())
}

pub(crate) async fn ensure_product_agent_overlays_applied(
    agent: &MvpAgent,
    session_id: &acp::SessionId,
) -> Result<(), acp::Error> {
    let identity = agent
        .agentmesh360
        .registry()
        .main_session_identity(session_id.0.as_ref())
        .map_err(|_| {
            acp::Error::internal_error().data("failed to read Agent customization identity")
        })?;
    let Some((Some(owner_account_id), agent_id)) = identity else {
        return Ok(());
    };
    if agent.agentmesh360.access.current_account_id() != Some(owner_account_id) {
        return Err(acp::Error::invalid_params().data("session not found"));
    }
    let package_version = agent
        .agentmesh360
        .registry()
        .get(owner_account_id, &agent_id)
        .map(|record| record.version)
        .map_err(|_| acp::Error::internal_error().data("failed to read Agent Package revision"))?;
    let overlays = agent_overlays::AgentOverlayStore::in_home(&agent.agentmesh360.state_home);
    let definition = agent
        .agentmesh360
        .registry()
        .agent_definition(&agent_id)
        .and_then(|definition| {
            overlays.apply_to_definition(owner_account_id, &agent_id, definition)
        })
        .map_err(|_| acp::Error::internal_error().data("failed to prepare Agent customization"))?;
    let (definition, overlay_revisions) = definition;
    let revision = AppliedAgentDefinitionRevision::from_definition(
        package_version,
        overlay_revisions,
        &definition,
    )
    .map_err(|_| {
        acp::Error::internal_error().data("failed to fingerprint Agent runtime definition")
    })?;
    if agent
        .agentmesh360
        .applied_agent_definition_revision(session_id)
        == Some(revision.clone())
    {
        return Ok(());
    }
    let cmd_tx = agent
        .sessions
        .borrow()
        .get(session_id)
        .map(|handle| handle.cmd_tx.clone())
        .ok_or_else(|| acp::Error::invalid_params().data("unknown session id"))?;
    let (busy_responds_to, busy_response) = tokio::sync::oneshot::channel();
    cmd_tx
        .send(crate::session::SessionCommand::IsBusy {
            respond_to: busy_responds_to,
        })
        .map_err(|_| acp::Error::internal_error().data("Agent customization actor closed"))?;
    if busy_response.await.unwrap_or(true) {
        return Err(acp::Error::invalid_params().data(
            "Agent customization is waiting for the current reply to finish; retry this message",
        ));
    }
    let (responds_to, response) = tokio::sync::oneshot::channel();
    cmd_tx
        .send(crate::session::SessionCommand::RebuildAgentForDefinition {
            definition,
            responds_to,
        })
        .map_err(|_| acp::Error::internal_error().data("failed to apply Agent customization"))?;
    response
        .await
        .map_err(|_| acp::Error::internal_error().data("Agent customization actor closed"))??;
    agent
        .agentmesh360
        .mark_agent_definition_applied(session_id, revision);
    Ok(())
}

pub(crate) fn hidden_product_session_ids(agent: &MvpAgent) -> Result<HashSet<String>, acp::Error> {
    let all_product_sessions = agent
        .agentmesh360
        .registry()
        .all_main_session_ids()
        .map_err(|_| {
            acp::Error::internal_error().data("failed to protect AgentMesh360 session history")
        })?;
    let Some(owner_account_id) = agent.agentmesh360.access.current_account_id() else {
        suspend_product_agents(agent, false);
        return Ok(all_product_sessions);
    };
    let visible_sessions = agent
        .agentmesh360
        .registry()
        .main_session_ids(owner_account_id)
        .map_err(|_| {
            acp::Error::internal_error().data("failed to read AgentMesh360 account sessions")
        })?;
    Ok(all_product_sessions
        .difference(&visible_sessions)
        .cloned()
        .collect())
}

fn list_agents(agent: &MvpAgent) -> Result<Vec<ProductAgentRecord>> {
    let owner_account_id = current_account_id(agent)?;
    let mut records = agent.agentmesh360.registry().list(owner_account_id)?;
    for record in &mut records {
        refresh_runtime_view(agent, record);
    }
    Ok(records)
}

fn package_catalog(agent: &MvpAgent) -> Result<serde_json::Value> {
    let catalog = agent
        .agentmesh360
        .registry()
        .package_catalog()
        .map_err(|_| anyhow!("Agent Package Catalog is unavailable"))?;
    serde_json::to_value(AgentPackageCatalogResponse {
        catalog: catalog.as_ref(),
    })
    .map_err(Into::into)
}

fn package_status(agent: &MvpAgent) -> Result<serde_json::Value> {
    use package_installer::{InstalledPackageStatus, PackageStatusKind};

    let health = agent.agentmesh360.registry().package_catalog_health();
    let builtins = agent_packages::AgentPackageCatalog::builtin()
        .map_err(|_| anyhow!("Built-in Agent Package Catalog is unavailable"))?;
    let mut packages = builtins
        .packages
        .into_iter()
        .map(|package| InstalledPackageStatus {
            kind: PackageStatusKind::BuiltIn,
            package_id: package.package_id,
            agent_id: Some(package.agent.agent_id),
            version: Some(package.version),
            slot: None,
            issue: None,
        })
        .collect::<Vec<_>>();
    match package_installer::PackageInstallService::in_home(&agent.agentmesh360.state_home)
        .inspect_status()
    {
        Ok(installed) => packages.extend(installed),
        Err(error) => {
            let issue = package_installer::classify_package_error(&error);
            tracing::error!(%error, "failed to inspect local Agent Package status");
            packages.push(InstalledPackageStatus {
                kind: PackageStatusKind::Invalid,
                package_id: "status-inventory".into(),
                agent_id: None,
                version: None,
                slot: None,
                issue: Some(issue),
            });
        }
    }
    if let Some(issue) = &health.last_issue {
        packages.push(InstalledPackageStatus {
            kind: PackageStatusKind::Invalid,
            package_id: "runtime-catalog".into(),
            agent_id: None,
            version: None,
            slot: None,
            issue: Some(issue.clone()),
        });
    }
    serde_json::to_value(AgentPackageStatusResponse {
        catalog_generation: health.generation,
        catalog_revision: health.catalog_revision,
        remote_registry: agent
            .agentmesh360
            .package_registry_fetcher
            .status(&agent.agentmesh360.access),
        last_refresh_issue: health.last_issue,
        packages,
    })
    .map_err(Into::into)
}

async fn activate(agent: &MvpAgent, agent_id: &str) -> Result<ActivateResponse> {
    let owner_account_id = current_account_id(agent)?;
    let record = agent
        .agentmesh360
        .registry()
        .prepare_activation(owner_account_id, agent_id)?;
    let session_id = record
        .main_session_id
        .as_deref()
        .map(acp::SessionId::new)
        .ok_or_else(|| anyhow!("activation did not allocate a main session"))?;

    if agent.sessions.borrow().contains_key(&session_id) {
        agent.agentmesh360.pin(session_id);
        agent
            .agentmesh360
            .registry()
            .mark_runtime(owner_account_id, agent_id, "resident", None)?;
        let mut agent_record = agent
            .agentmesh360
            .registry()
            .get(owner_account_id, agent_id)?;
        refresh_runtime_view(agent, &mut agent_record);
        return Ok(ActivateResponse {
            agent: agent_record,
            resumed: true,
        });
    }

    let workspace_dir = record
        .workspace_dir
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("activation did not allocate a workspace"))?;
    let profile = agent.agentmesh360.registry().agent_definition(agent_id)?;
    let (profile, overlay_revisions) =
        agent_overlays::AgentOverlayStore::in_home(&agent.agentmesh360.state_home)
            .apply_to_definition(owner_account_id, agent_id, profile)?;
    let definition_revision = AppliedAgentDefinitionRevision::from_definition(
        record.version.clone(),
        overlay_revisions,
        &profile,
    )?;
    let mut meta = acp::Meta::new();
    meta.insert("agentProfile".into(), profile.to_json_value());
    meta.insert("agentmesh360AgentId".into(), agent_id.into());
    meta.insert("agentmesh360AccountId".into(), owner_account_id.into());
    meta.insert(
        "clientIdentifier".into(),
        "agentmesh360-product-agent".into(),
    );

    let workspace_cwd = workspace_dir.to_string_lossy().into_owned();
    let session_exists_in_workspace =
        crate::session::session_exists_for_cwd(session_id.0.as_ref(), &workspace_cwd);
    if !session_exists_in_workspace
        && let Some(other_cwd) =
            crate::session::resolve_local_session_any_cwd(session_id.0.as_ref())
    {
        let error = format!(
            "Agent Session workspace conflict: session {} belongs to {}, expected {}",
            session_id.0, other_cwd, workspace_cwd
        );
        let _ = agent.agentmesh360.registry().mark_runtime(
            owner_account_id,
            agent_id,
            "error",
            Some(&error),
        );
        return Err(anyhow!(error));
    }
    let persisted_cwd = session_exists_in_workspace.then_some(workspace_cwd);
    let resumed = persisted_cwd.is_some();
    let session_result = if let Some(cwd) = persisted_cwd {
        let request = acp::LoadSessionRequest::new(session_id.clone(), cwd).meta(meta);
        acp::Agent::load_session(agent, request)
            .await
            .map(|_| session_id.clone())
    } else {
        meta.insert("sessionId".into(), session_id.0.as_ref().into());
        let request = acp::NewSessionRequest::new(workspace_dir).meta(meta);
        acp::Agent::new_session(agent, request)
            .await
            .map(|response| response.session_id)
    };

    match session_result {
        Ok(actual_session_id) if actual_session_id == session_id => {
            agent.agentmesh360.record_activation_definition_state(
                &session_id,
                definition_revision,
                resumed,
            );
            agent.agentmesh360.pin(session_id);
            agent.agentmesh360.registry().mark_runtime(
                owner_account_id,
                agent_id,
                "resident",
                None,
            )?;
            let mut agent_record = agent
                .agentmesh360
                .registry()
                .get(owner_account_id, agent_id)?;
            refresh_runtime_view(agent, &mut agent_record);
            Ok(ActivateResponse {
                agent: agent_record,
                resumed,
            })
        }
        Ok(actual_session_id) => {
            let error = format!(
                "Grok session identity mismatch: expected {}, received {}",
                session_id.0, actual_session_id.0
            );
            let _ = agent.agentmesh360.registry().mark_runtime(
                owner_account_id,
                agent_id,
                "error",
                Some(&error),
            );
            Err(anyhow!(error))
        }
        Err(error) => {
            let message = error.to_string();
            let _ = agent.agentmesh360.registry().mark_runtime(
                owner_account_id,
                agent_id,
                "error",
                Some(&message),
            );
            Err(anyhow!(error).context(format!("activate {agent_id}")))
        }
    }
}

fn refresh_runtime_view(agent: &MvpAgent, record: &mut ProductAgentRecord) {
    if record.desired_state != "running" {
        record.runtime_state = "available".into();
        return;
    }
    let Some(session_id) = record.main_session_id.as_deref().map(acp::SessionId::new) else {
        record.runtime_state = "error".into();
        return;
    };
    record.runtime_state = if agent.sessions.borrow().contains_key(&session_id) {
        activity_name(agent.resident_activity(&session_id)).into()
    } else if record
        .workspace_dir
        .as_deref()
        .is_some_and(|workspace_dir| {
            crate::session::session_exists_for_cwd(session_id.0.as_ref(), workspace_dir)
        })
    {
        "dormant".into()
    } else if record.runtime_state == "error" {
        "error".into()
    } else {
        "starting".into()
    };
}

fn activity_name(activity: RosterActivity) -> &'static str {
    match activity {
        RosterActivity::Working => "working",
        RosterActivity::Idle => "resident",
        RosterActivity::NeedsInput => "needs_input",
        RosterActivity::Dormant => "dormant",
        RosterActivity::Completed => "completed",
        RosterActivity::Dead => "error",
    }
}

pub(crate) fn spawn_restore_activated_agents(agent: &MvpAgent) {
    if cfg!(test) || agent.agentmesh360.restore_started.replace(true) {
        return;
    }
    let agent_ref = LocalRef::new(agent);
    tokio::task::spawn_local(async move {
        let agent = agent_ref.get();
        let owner_account_id = match current_account_id(agent) {
            Ok(owner_account_id) => owner_account_id,
            Err(error) => {
                tracing::error!(%error, "cannot restore AgentMesh360 agents without account access");
                return;
            }
        };
        let records = match agent.agentmesh360.registry().list(owner_account_id) {
            Ok(records) => records,
            Err(error) => {
                tracing::error!(%error, "failed to read persistent AgentMesh360 agents at startup");
                return;
            }
        };
        for record in records
            .into_iter()
            .filter(|record| record.desired_state == "running")
        {
            if let Err(error) = activate(agent, &record.agent_id).await {
                tracing::error!(agent_id = %record.agent_id, %error, "failed to restore persistent product agent");
            }
        }
    });
}

fn current_account_id(agent: &MvpAgent) -> Result<i64> {
    agent
        .agentmesh360
        .access
        .current_account_id()
        .ok_or_else(|| anyhow!("AgentMesh360 account access is unavailable"))
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use agent_client_protocol::Agent as _;
    use axum::Router;
    use axum::http::HeaderMap;
    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use chrono::TimeZone as _;
    use ed25519_dalek::SigningKey;
    use futures_util::stream;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use uuid::Uuid;
    use xai_acp_lib::AcpAgentGatewaySender as GatewaySender;

    use super::*;
    use crate::agent::config::Config;
    use crate::auth::{AuthManager, GrokComConfig};

    const ACTIVE_BOOTSTRAP: &str = r#"{
        "schema_version":1,
        "server_time":"2026-07-22T00:00:00Z",
        "account":{"id":1,"email":"u@example.com","account_id":41,"display_name":null,"avatar_url":null},
        "subscription":{"status":"active","source":"monthly_pass","plan":"monthly_pass","period_start":"2026-07-01 00:00:00","period_end":"2026-08-31 00:00:00","auto_renews":false},
        "credits":{"balance":0,"source":"monthly_pass","expires_at":"2026-08-31 00:00:00"},
        "access":{"can_enter_client":true,"reason":"active_subscription"}
    }"#;

    fn ext_request(method: &str, params: serde_json::Value) -> acp::ExtRequest {
        acp::ExtRequest::new(
            method,
            Arc::from(serde_json::value::to_raw_value(&params).expect("request params")),
        )
    }

    fn ext_result(response: acp::ExtResponse) -> serde_json::Value {
        let envelope = ext_envelope(response);
        match envelope.get("result") {
            Some(result) if !result.is_null() => result.clone(),
            _ => panic!("extension response has no successful result: {envelope}"),
        }
    }

    fn ext_envelope(response: acp::ExtResponse) -> serde_json::Value {
        serde_json::from_str(response.0.get()).expect("extension response")
    }

    fn summarize_provider_requests(requests: &[(String, String)]) -> String {
        requests
            .iter()
            .enumerate()
            .map(|(index, (authorization, body))| {
                let parsed = serde_json::from_str::<serde_json::Value>(body).unwrap_or_default();
                let input_tail = parsed["input"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .rev()
                            .take(3)
                            .rev()
                            .cloned()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                format!(
                    "#{index} auth={authorization:?} model={} input_tail={}",
                    parsed["model"],
                    serde_json::Value::Array(input_tail)
                )
            })
            .collect::<Vec<_>>()
            .join(" | ")
    }

    #[test]
    fn resumed_product_session_requires_definition_rebuild_before_next_prompt() {
        let state_home = tempfile::tempdir().expect("state home");
        let runtime = AgentMesh360Runtime::for_host_test(state_home.path(), "http://127.0.0.1:9");
        let session_id = acp::SessionId::new("job-main-session");
        let mut legacy_definition = xai_grok_agent::AgentDefinition::default_grok_build();
        legacy_definition.prompt_body = Some("legacy generic profile".into());
        let old =
            AppliedAgentDefinitionRevision::from_definition("0.4.8", (0, 0), &legacy_definition)
                .expect("legacy definition revision");
        runtime.record_activation_definition_state(&session_id, old.clone(), false);
        assert_eq!(
            runtime.applied_agent_definition_revision(&session_id),
            Some(old)
        );

        let mut upgraded_definition = legacy_definition.clone();
        upgraded_definition.prompt_body = Some("state-driven onboarding profile".into());
        let upgraded =
            AppliedAgentDefinitionRevision::from_definition("0.5.6", (0, 0), &upgraded_definition)
                .expect("upgraded definition revision");
        assert_ne!(
            runtime.applied_agent_definition_revision(&session_id),
            Some(upgraded.clone()),
            "a Package version change must invalidate the applied runtime definition"
        );

        runtime.record_activation_definition_state(&session_id, upgraded, true);
        assert_eq!(
            runtime.applied_agent_definition_revision(&session_id),
            None,
            "loading a persisted top-level conversation cannot mark its new Package prompt applied"
        );
    }

    #[test]
    fn definition_revision_tracks_every_product_agent_definition() {
        let catalog = agent_packages::AgentPackageCatalog::builtin().expect("built-in packages");
        let lecturecast = catalog
            .package_for_agent("lecturecast-agent")
            .expect("LectureCast Agent package");
        let definition = lecturecast
            .agent_definition()
            .expect("LectureCast Agent definition");
        let baseline = AppliedAgentDefinitionRevision::from_definition(
            lecturecast.version.clone(),
            (0, 0),
            &definition,
        )
        .expect("baseline definition revision");
        assert_eq!(
            baseline,
            AppliedAgentDefinitionRevision::from_definition(
                lecturecast.version.clone(),
                (0, 0),
                &definition,
            )
            .expect("stable definition revision"),
            "the same Package definition must not rebuild its resident harness repeatedly"
        );

        let mut prompt_upgrade = definition.clone();
        prompt_upgrade.prompt_body = Some(format!(
            "{}\n\nFuture Package-owned workflow marker.",
            prompt_upgrade.prompt_body.as_deref().unwrap_or_default()
        ));
        assert_ne!(
            baseline,
            AppliedAgentDefinitionRevision::from_definition(
                lecturecast.version.clone(),
                (0, 0),
                &prompt_upgrade,
            )
            .expect("prompt-upgraded definition revision"),
            "a non-Job Agent Package prompt change must rebuild that Agent's harness"
        );
        assert_ne!(
            baseline,
            AppliedAgentDefinitionRevision::from_definition("0.4.1", (0, 0), &definition,)
                .expect("version-upgraded definition revision"),
            "a Package version change must invalidate the resident definition"
        );
        assert_ne!(
            baseline,
            AppliedAgentDefinitionRevision::from_definition(
                lecturecast.version.clone(),
                (1, 0),
                &definition,
            )
            .expect("overlay-upgraded definition revision"),
            "an Agent customization revision must invalidate the resident definition"
        );
    }

    async fn serve_bootstrap_once() -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Core mock");
        let address = listener.local_addr().expect("Core mock address");
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept Core request");
            let mut request = vec![0; 4096];
            let read = stream.read(&mut request).await.expect("read Core request");
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ACTIVE_BOOTSTRAP}",
                ACTIVE_BOOTSTRAP.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write Core response");
            request
        });
        (format!("http://{address}"), task)
    }

    async fn serve_bootstrap_sequence(
        bodies: Vec<String>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Core mock sequence");
        let address = listener.local_addr().expect("Core mock sequence address");
        let task = tokio::spawn(async move {
            let mut requests = Vec::with_capacity(bodies.len());
            for body in bodies {
                let (mut stream, _) = listener.accept().await.expect("accept Core request");
                let mut request = vec![0; 4096];
                let read = stream.read(&mut request).await.expect("read Core request");
                requests.push(String::from_utf8_lossy(&request[..read]).to_string());
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("write Core response");
            }
            requests
        });
        (format!("http://{address}"), task)
    }

    async fn serve_provider_requests() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Provider mock");
        let address = listener.local_addr().expect("Provider mock address");
        let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/responses",
            post({
                let request_tx = request_tx.clone();
                move |headers: HeaderMap, body: String| {
                    let request_tx = request_tx.clone();
                    async move {
                        let authorization = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        let response = if body
                            .contains("Your task is to produce a faithful, concise summary")
                        {
                            format!(
                                "<summary>\n1. Primary Request and Intent: retain the current product Agent task.\n{}\n</summary>",
                                "The session remains recoverable after compaction. ".repeat(12)
                            )
                        } else {
                            "host-e2e-ok".to_string()
                        };
                        let _ = request_tx.send((authorization, body));
                        let events = xai_grok_test_support::sse::responses_api_events_exact(
                            &response,
                            "model-main",
                        )
                        .into_iter()
                        .map(Ok::<_, Infallible>);
                        Sse::new(stream::iter(events))
                    }
                }
            }),
        );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}/v1"), request_rx, task)
    }

    async fn serve_job_onboarding_provider_requests(
        version_command: String,
        upgrade_command: String,
        doctor_command: String,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Job onboarding Provider mock");
        let address = listener
            .local_addr()
            .expect("Job onboarding Provider mock address");
        let attempts = Arc::new(AtomicUsize::new(0));
        let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/responses",
            post({
                let request_tx = request_tx.clone();
                let attempts = Arc::clone(&attempts);
                move |headers: HeaderMap, body: String| {
                    let request_tx = request_tx.clone();
                    let attempts = Arc::clone(&attempts);
                    let version_command = version_command.clone();
                    let upgrade_command = upgrade_command.clone();
                    let doctor_command = doctor_command.clone();
                    async move {
                        let authorization = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        let model = serde_json::from_str::<serde_json::Value>(&body)
                            .ok()
                            .and_then(|value| value["model"].as_str().map(ToOwned::to_owned))
                            .unwrap_or_else(|| "model-main".to_string());
                        let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                        let _ = request_tx.send((authorization, body.clone()));
                        match attempt {
                            1 => {
                                assert!(body.contains("call_jobagent_version"));
                                assert!(body.contains("jobagent 0.5.5"));
                            }
                            3 => {
                                assert!(body.contains("call_jobagent_version_current"));
                                assert!(body.contains("jobagent 0.5.6"));
                            }
                            4 => {
                                assert!(body.contains("call_jobagent_upgrade"));
                                assert!(body.contains("client_command_resumed"));
                                assert!(body.contains("fixture-upgrade-ready"));
                            }
                            5 => {
                                assert!(body.contains("call_jobagent_doctor"));
                                assert!(body.contains("fixture-upload-resume"));
                            }
                            _ => {}
                        }
                        let events = match attempt {
                            0 | 2 => xai_grok_test_support::sse::responses_api_reasoning_then_tool_call_events(
                                    "Resolve and verify the installed Job Agent CLI first.",
                                    if attempt == 0 {
                                        "call_jobagent_version"
                                    } else {
                                        "call_jobagent_version_current"
                                    },
                                    "run_terminal_command",
                                    &serde_json::json!({
                                        "command": version_command,
                                        "description": "Verify the isolated Job Agent CLI fixture.",
                                        "background": false
                                    })
                                    .to_string(),
                                    &model,
                                )
                                .into_iter()
                                .map(|event| match event.event {
                                    Some(name) => Event::default().event(name).data(event.data),
                                    None => Event::default().data(event.data),
                                })
                                .collect(),
                            1 => xai_grok_test_support::sse::responses_api_events_exact(
                                    "检测到 Job Agent CLI 0.5.5，低于最低要求 0.5.6。我已停止状态探针和猎聘操作；请先完成官方更新，再在这个持久会话继续。",
                                    &model,
                                ),
                            3 => xai_grok_test_support::sse::responses_api_reasoning_then_tool_call_events(
                                    "The CLI version is current; verify upgrade and command recovery state.",
                                    "call_jobagent_upgrade",
                                    "run_terminal_command",
                                    &serde_json::json!({
                                        "command": upgrade_command,
                                        "description": "Verify isolated Job Agent upgrade readiness.",
                                        "background": false
                                    })
                                    .to_string(),
                                    &model,
                                )
                                .into_iter()
                                .map(|event| match event.event {
                                    Some(name) => Event::default().event(name).data(event.data),
                                    None => Event::default().data(event.data),
                                })
                                .collect(),
                            4 => xai_grok_test_support::sse::responses_api_reasoning_then_tool_call_events(
                                    "The version and recovery state are current; read authoritative Job Agent state.",
                                    "call_jobagent_doctor",
                                    "run_terminal_command",
                                    &serde_json::json!({
                                        "command": doctor_command,
                                        "description": "Read the isolated Job Agent state fixture.",
                                        "background": false
                                    })
                                    .to_string(),
                                    &model,
                                )
                                .into_iter()
                                .map(|event| match event.event {
                                    Some(name) => Event::default().event(name).data(event.data),
                                    None => Event::default().data(event.data),
                                })
                                .collect(),
                            _ => xai_grok_test_support::sse::responses_api_events_exact(
                                    "账号已经验证。下一步请上传 PDF、DOCX、TXT 或 Markdown 简历；我会先分析，不会自动投递。",
                                    &model,
                                ),
                        };
                        Sse::new(stream::iter(
                            events.into_iter().map(Ok::<_, Infallible>),
                        ))
                    }
                }
            }),
        );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}/v1"), request_rx, task)
    }

    async fn serve_subagent_route_provider_requests() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind subagent route Provider mock");
        let address = listener
            .local_addr()
            .expect("subagent route Provider mock address");
        let main_attempts = Arc::new(AtomicUsize::new(0));
        let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/responses",
            post({
                let request_tx = request_tx.clone();
                let main_attempts = Arc::clone(&main_attempts);
                move |headers: HeaderMap, body: String| {
                    let request_tx = request_tx.clone();
                    let main_attempts = Arc::clone(&main_attempts);
                    async move {
                        let authorization = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        let model = serde_json::from_str::<serde_json::Value>(&body)
                            .ok()
                            .and_then(|value| {
                                value["model"].as_str().map(ToOwned::to_owned)
                            })
                            .unwrap_or_else(|| "unknown-model".to_string());
                        let _ = request_tx.send((authorization.clone(), body));
                        let events = if authorization == "Bearer sentinel-subagent-secret" {
                            xai_grok_test_support::sse::responses_api_events_exact(
                                "child-provider-ok",
                                &model,
                            )
                        } else if main_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                            xai_grok_test_support::sse::responses_api_reasoning_then_tool_call_events(
                                "Delegate this bounded verification.",
                                "call_agentmesh_subagent",
                                "spawn_subagent",
                                r#"{"prompt":"Return child-provider-ok without using tools.","description":"verify product route","subagent_type":"general-purpose","background":false}"#,
                                &model,
                            )
                            .into_iter()
                            .map(|event| match event.event {
                                Some(name) => Event::default().event(name).data(event.data),
                                None => Event::default().data(event.data),
                            })
                            .collect()
                        } else {
                            xai_grok_test_support::sse::responses_api_events_exact(
                                "parent-observed-child-ok",
                                &model,
                            )
                        };
                        Sse::new(stream::iter(
                            events.into_iter().map(Ok::<_, Infallible>),
                        ))
                    }
                }
            }),
        );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}/v1"), request_rx, task)
    }

    async fn serve_compaction_provider_requests() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind compaction Provider mock");
        let address = listener
            .local_addr()
            .expect("compaction Provider mock address");
        let compaction_attempts = Arc::new(AtomicUsize::new(0));
        let (request_tx, request_rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/responses",
            post({
                let request_tx = request_tx.clone();
                let compaction_attempts = Arc::clone(&compaction_attempts);
                move |headers: HeaderMap, body: String| {
                    let request_tx = request_tx.clone();
                    let compaction_attempts = Arc::clone(&compaction_attempts);
                    async move {
                        let authorization = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        let model = serde_json::from_str::<serde_json::Value>(&body)
                            .ok()
                            .and_then(|value| {
                                value["model"].as_str().map(ToOwned::to_owned)
                            })
                            .unwrap_or_else(|| "unknown-model".to_string());
                        let is_compaction =
                            body.contains("Your task is to produce a faithful, concise summary");
                        let response = if is_compaction {
                            let attempt = compaction_attempts.fetch_add(1, Ordering::SeqCst);
                            if attempt == 0 {
                                "<summary>too short</summary>".to_string()
                            } else {
                                format!(
                                    "<summary>\n1. Primary Request and Intent: preserve the product Agent conversation.\n{}\n</summary>",
                                    "The compacted state remains bound to the selected Provider and model. "
                                        .repeat(12)
                                )
                            }
                        } else {
                            "host-main-before-compaction".to_string()
                        };
                        let _ = request_tx.send((authorization, body));
                        let events =
                            xai_grok_test_support::sse::responses_api_events_exact(&response, &model)
                                .into_iter()
                                .map(Ok::<_, Infallible>);
                        Sse::new(stream::iter(events))
                    }
                }
            }),
        );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}/v1"), request_rx, task)
    }

    #[derive(Clone, Copy)]
    struct HostTestClient;

    #[async_trait::async_trait(?Send)]
    impl acp::Client for HostTestClient {
        async fn request_permission(
            &self,
            request: acp::RequestPermissionRequest,
        ) -> acp::Result<acp::RequestPermissionResponse> {
            let outcome = request
                .options
                .iter()
                .find(|option| option.kind == acp::PermissionOptionKind::AllowOnce)
                .or(request.options.first())
                .map(|option| {
                    acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                        option.option_id.clone(),
                    ))
                })
                .unwrap_or(acp::RequestPermissionOutcome::Cancelled);
            Ok(acp::RequestPermissionResponse::new(outcome))
        }

        async fn session_notification(
            &self,
            _notification: acp::SessionNotification,
        ) -> acp::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone)]
    struct RecordingHostTestClient {
        notification_tx: tokio::sync::mpsc::UnboundedSender<acp::SessionNotification>,
    }

    #[async_trait::async_trait(?Send)]
    impl acp::Client for RecordingHostTestClient {
        async fn request_permission(
            &self,
            request: acp::RequestPermissionRequest,
        ) -> acp::Result<acp::RequestPermissionResponse> {
            let outcome = request
                .options
                .iter()
                .find(|option| option.kind == acp::PermissionOptionKind::AllowOnce)
                .or(request.options.first())
                .map(|option| {
                    acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                        option.option_id.clone(),
                    ))
                })
                .unwrap_or(acp::RequestPermissionOutcome::Cancelled);
            Ok(acp::RequestPermissionResponse::new(outcome))
        }

        async fn session_notification(
            &self,
            notification: acp::SessionNotification,
        ) -> acp::Result<()> {
            let _ = self.notification_tx.send(notification);
            Ok(())
        }
    }

    fn drive_gateway(
        mut receiver: tokio::sync::mpsc::UnboundedReceiver<xai_acp_lib::AcpClientMessage>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::task::spawn_local(async move {
            while let Some(message) = receiver.recv().await {
                message.route_to_client(HostTestClient, |future| {
                    tokio::task::spawn_local(future);
                });
            }
        })
    }

    fn drive_recording_gateway(
        mut receiver: tokio::sync::mpsc::UnboundedReceiver<xai_acp_lib::AcpClientMessage>,
    ) -> (
        tokio::task::JoinHandle<()>,
        tokio::sync::mpsc::UnboundedReceiver<acp::SessionNotification>,
    ) {
        let (notification_tx, notification_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = RecordingHostTestClient { notification_tx };
        let task = tokio::task::spawn_local(async move {
            while let Some(message) = receiver.recv().await {
                let client = client.clone();
                message.route_to_client(client, |future| {
                    tokio::task::spawn_local(future);
                });
            }
        });
        (task, notification_rx)
    }

    fn build_host_test_agent(
        state_home: &std::path::Path,
        core_base_url: String,
    ) -> (
        MvpAgent,
        tokio::sync::mpsc::UnboundedReceiver<xai_acp_lib::AcpClientMessage>,
    ) {
        let auth_home = tempfile::tempdir().expect("auth home");
        let auth_manager = Arc::new(AuthManager::new(auth_home.path(), GrokComConfig::default()));
        let (gateway_tx, gateway_rx) = tokio::sync::mpsc::unbounded_channel();
        let gateway = GatewaySender::new(gateway_tx);
        let mut agent =
            MvpAgent::new(gateway, &Config::default(), auth_manager, None).expect("test agent");
        agent.agentmesh360 = AgentMesh360Runtime::for_host_test(state_home, core_base_url);
        (agent, gateway_rx)
    }

    fn build_host_test_agent_with_package_delivery(
        state_home: &std::path::Path,
        core_base_url: String,
        roots: package_trust::TrustedRootStore,
        transport_origin: url::Url,
    ) -> (
        MvpAgent,
        tokio::sync::mpsc::UnboundedReceiver<xai_acp_lib::AcpClientMessage>,
    ) {
        let (mut agent, gateway_rx) = build_host_test_agent(state_home, core_base_url);
        agent.agentmesh360.package_registry_fetcher =
            package_registry_fetcher::PackageRegistryFetcher::for_test_with_cached_roots(
                state_home,
                roots.clone(),
            );
        agent.agentmesh360.package_delivery =
            package_delivery::PackageDeliveryService::for_test_with_registry(
                agent.agentmesh360.registry.clone(),
                roots,
                transport_origin,
            );
        (agent, gateway_rx)
    }

    async fn serve_package_artifacts(
        fixture: &package_artifact::DownloadArtifactFixture,
        release_document: &[u8],
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Package artifact mock");
        let address = listener
            .local_addr()
            .expect("Package artifact mock address");
        let responses = [
            ("application/json", release_document.to_vec()),
            ("application/json", fixture.envelope.as_bytes().to_vec()),
            ("application/octet-stream", fixture.artifact.clone()),
        ];
        let task = tokio::spawn(async move {
            let mut requests = Vec::with_capacity(responses.len());
            for (content_type, body) in responses {
                let (mut stream, _) = listener.accept().await.expect("accept Package request");
                let mut request = vec![0; 8192];
                let read = stream
                    .read(&mut request)
                    .await
                    .expect("read Package request");
                requests.push(String::from_utf8_lossy(&request[..read]).to_string());
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(headers.as_bytes())
                    .await
                    .expect("write Package headers");
                stream.write_all(&body).await.expect("write Package body");
            }
            requests
        });
        (format!("http://{address}"), task)
    }

    fn package_roots(root: &SigningKey) -> package_trust::TrustedRootStore {
        package_trust::TrustedRootStore::with_key(package_trust::TrustedRootKey {
            key_id: "agentmesh360-root-host-test-2026".into(),
            public_key: root.verifying_key().to_bytes(),
        })
    }

    fn seed_host_remote_package(
        state_home: &std::path::Path,
        root: &SigningKey,
        fixture: &package_artifact::DownloadArtifactFixture,
        release_document: &[u8],
    ) {
        let root_key_id = "agentmesh360-root-host-test-2026";
        let release_url = format!(
            "{}/com.agentmesh360.job-agent-0.5.6.agent-release.v1.json",
            package_registry_fetcher::PRODUCTION_PACKAGE_ORIGIN
        );
        let artifact_url = format!(
            "{}/com.agentmesh360.job-agent-0.5.6.ampkg.tar.zst",
            package_registry_fetcher::PRODUCTION_PACKAGE_ORIGIN
        );
        let envelope_url = format!(
            "{}/com.agentmesh360.job-agent-0.5.6.signature.v1.json",
            package_registry_fetcher::PRODUCTION_PACKAGE_ORIGIN
        );
        let trust = package_trust::signed_bundle_document_for_test(
            root,
            root_key_id,
            7,
            "2026-08-01T00:00:00Z",
            7,
        );
        let registry = package_registry_snapshot::signed_registry_release_record_document_for_test(
            root,
            root_key_id,
            42,
            7,
            "com.agentmesh360.job-agent",
            "job-agent",
            "0.5.6",
            &release_url,
            &package_authoring::sha256_hex(release_document),
            &artifact_url,
            &fixture.artifact_sha256,
            &envelope_url,
            &fixture.envelope_sha256,
        );
        let access = access::ClientAccess::with_trusted_time_for_test(
            chrono::Utc
                .with_ymd_and_hms(2026, 7, 22, 0, 0, 0)
                .single()
                .expect("trusted Package time"),
        );
        package_trust_cache::PackageTrustCacheStore::in_home_with_roots(
            state_home,
            package_roots(root),
        )
        .accept_documents(&trust, &registry, &access)
        .expect("seed Host Package registry");
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn package_status_is_subscription_gated_read_only_and_path_redacted() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let (agent, _gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);

                let denied = handle(
                    &agent,
                    &ext_request(AGENT_PACKAGES_STATUS_METHOD, serde_json::json!({})),
                )
                .await
                .expect_err("status requires subscription access");
                assert_eq!(denied.code, acp::Error::auth_required().code);

                handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "sentinel-bootstrap-token"}),
                    ),
                )
                .await
                .expect("bootstrap response");
                let _ = core.await.expect("Core request task");

                let status = handle(
                    &agent,
                    &ext_request(AGENT_PACKAGES_STATUS_METHOD, serde_json::json!({})),
                )
                .await
                .map(ext_result)
                .expect("read-only Package status");
                assert_eq!(status["catalogGeneration"], 1);
                assert!(status["catalogRevision"].as_u64().is_some());
                assert_eq!(status["remoteRegistry"]["outcome"], "disabled");
                assert_eq!(status["remoteRegistry"]["reason"], "not_configured");
                let packages = status["packages"].as_array().expect("Package statuses");
                assert_eq!(
                    packages
                        .iter()
                        .filter(|package| package["kind"] == "built_in")
                        .count(),
                    3
                );
                let json = serde_json::to_string(&status).expect("serialize status");
                assert!(!json.contains(&state_home.path().display().to_string()));
                assert!(!json.contains("relativePath"));
                assert!(!json.contains("artifactSha256"));
                assert!(!json.contains("signatureKeyId"));

                agent
                    .agentmesh360
                    .refresh_package_catalog()
                    .expect("Host-private explicit refresh");
                assert_eq!(
                    agent
                        .agentmesh360
                        .registry()
                        .package_catalog_health()
                        .generation,
                    2
                );

                std::fs::remove_dir_all(state_home.path()).expect("remove state directory");
                std::fs::write(state_home.path(), b"not a directory")
                    .expect("replace state directory with a file");
                let degraded = handle(
                    &agent,
                    &ext_request(AGENT_PACKAGES_STATUS_METHOD, serde_json::json!({})),
                )
                .await
                .map(ext_result)
                .expect("status degrades to a redacted inventory issue");
                assert!(degraded["packages"].as_array().is_some_and(|packages| {
                    packages.iter().any(|package| {
                        package["kind"] == "invalid"
                            && package["packageId"] == "status-inventory"
                            && package["issue"]["code"] == "package_validation_failed"
                    })
                }));
                let degraded_json =
                    serde_json::to_string(&degraded).expect("serialize degraded status");
                assert!(!degraded_json.contains(&state_home.path().display().to_string()));
                assert!(!degraded_json.contains("not a directory"));
                std::fs::remove_file(state_home.path()).expect("remove blocking state file");
                std::fs::create_dir(state_home.path()).expect("restore temp directory");
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn package_management_acp_is_subscription_gated_strict_and_production_disabled() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let (agent, _gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);
                let management_requests = [
                    (AGENT_PACKAGES_REMOTE_CATALOG_METHOD, serde_json::json!({})),
                    (AGENT_PACKAGES_REMOTE_REFRESH_METHOD, serde_json::json!({})),
                    (
                        AGENT_PACKAGES_DOWNLOAD_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                    (
                        AGENT_PACKAGES_APPROVE_METHOD,
                        serde_json::json!({"approvalId": Uuid::now_v7().to_string()}),
                    ),
                    (
                        AGENT_PACKAGES_ROLLBACK_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                    (
                        AGENT_PACKAGES_RECONCILE_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                ];
                for (method, params) in &management_requests {
                    let error = handle(&agent, &ext_request(method, params.clone()))
                        .await
                        .expect_err("Package management requires subscription");
                    assert_eq!(error.code, acp::Error::auth_required().code);
                }

                handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "sentinel-bootstrap-token"}),
                    ),
                )
                .await
                .expect("bootstrap response");
                let _ = core.await.expect("Core request task");

                let remote = handle(
                    &agent,
                    &ext_request(AGENT_PACKAGES_REMOTE_REFRESH_METHOD, serde_json::json!({})),
                )
                .await
                .map(ext_result)
                .expect("production-disabled remote refresh");
                assert_eq!(remote["outcome"], "disabled");
                assert_eq!(remote["reason"], "not_configured");

                let remote_catalog = handle(
                    &agent,
                    &ext_request(AGENT_PACKAGES_REMOTE_CATALOG_METHOD, serde_json::json!({})),
                )
                .await
                .map(ext_result)
                .expect("production-disabled remote catalog");
                assert_eq!(remote_catalog["outcome"], "disabled");
                assert_eq!(remote_catalog["reason"], "not_configured");
                assert_eq!(remote_catalog["packages"], serde_json::json!([]));

                let forbidden_requests = [
                    (
                        AGENT_PACKAGES_REMOTE_CATALOG_METHOD,
                        serde_json::json!({"url": "https://attacker.invalid/catalog"}),
                    ),
                    (
                        AGENT_PACKAGES_REMOTE_REFRESH_METHOD,
                        serde_json::json!({"url": "https://attacker.invalid/registry"}),
                    ),
                    (
                        AGENT_PACKAGES_DOWNLOAD_METHOD,
                        serde_json::json!({
                            "packageId": "com.agentmesh360.job-agent",
                            "url": "https://attacker.invalid/package"
                        }),
                    ),
                    (
                        AGENT_PACKAGES_APPROVE_METHOD,
                        serde_json::json!({
                            "approvalId": Uuid::now_v7().to_string(),
                            "permissionsApproved": true
                        }),
                    ),
                    (
                        AGENT_PACKAGES_ROLLBACK_METHOD,
                        serde_json::json!({
                            "packageId": "com.agentmesh360.job-agent",
                            "path": state_home.path()
                        }),
                    ),
                    (
                        AGENT_PACKAGES_RECONCILE_METHOD,
                        serde_json::json!({
                            "packageId": "com.agentmesh360.job-agent",
                            "digest": "a".repeat(64)
                        }),
                    ),
                ];
                for (method, params) in forbidden_requests {
                    let error = handle(&agent, &ext_request(method, params))
                        .await
                        .expect_err("Package management rejects caller-supplied authority");
                    assert_eq!(error.code, acp::Error::invalid_params().code);
                }
                let invalid_id = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_DOWNLOAD_METHOD,
                        serde_json::json!({"packageId": "../../outside"}),
                    ),
                )
                .await
                .expect_err("invalid Package identifier");
                assert_eq!(invalid_id.code, acp::Error::invalid_params().code);
                let oversized_id = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_DOWNLOAD_METHOD,
                        serde_json::json!({"packageId": "a".repeat(129)}),
                    ),
                )
                .await
                .expect_err("oversized Package identifier");
                assert_eq!(oversized_id.code, acp::Error::invalid_params().code);

                let download_error = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_DOWNLOAD_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("redacted disabled delivery error");
                assert!(download_error["result"].is_null());
                assert_eq!(download_error["error"]["code"], "package_delivery_failed");
                let approve_error = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_APPROVE_METHOD,
                        serde_json::json!({"approvalId": Uuid::now_v7().to_string()}),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("redacted approval error");
                assert_eq!(
                    approve_error["error"]["code"],
                    "package_approval_unavailable"
                );
                let rollback_error = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_ROLLBACK_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("redacted rollback error");
                assert_eq!(
                    rollback_error["error"]["code"],
                    "package_rollback_unavailable"
                );
                let reconcile_error = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_RECONCILE_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("redacted reconciliation error");
                assert_eq!(
                    reconcile_error["error"]["code"],
                    "package_reconciliation_unavailable"
                );
                let serialized = serde_json::to_string(&serde_json::json!([
                    download_error,
                    approve_error,
                    rollback_error,
                    reconcile_error
                ]))
                .expect("serialize Package errors");
                for sensitive in [
                    state_home.path().display().to_string(),
                    "packages.agentmesh360.com".into(),
                    "relativePath".into(),
                    "sha256".into(),
                    "accountId".into(),
                    "accessToken".into(),
                ] {
                    assert!(!serialized.contains(&sensitive));
                }
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn package_management_acp_preserves_cross_account_approval_and_refreshes_runtime() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let fixture = package_artifact::download_artifact_fixture_for_test();
                let release = package_release::release_document_for_download_test(
                    "com.agentmesh360.job-agent",
                    "job-agent",
                    "0.5.6",
                    &fixture.artifact_sha256,
                    &fixture.envelope_sha256,
                    &fixture.file_manifest_sha256,
                    &fixture.signature_key_id,
                );
                let root = SigningKey::from_bytes(&[91_u8; 32]);
                seed_host_remote_package(state_home.path(), &root, &fixture, &release);
                let (transport_origin, packages) =
                    serve_package_artifacts(&fixture, &release).await;
                let account_42 = ACTIVE_BOOTSTRAP
                    .replace("\"id\":1", "\"id\":2")
                    .replace("u@example.com", "other@example.com")
                    .replace("\"account_id\":41", "\"account_id\":42");
                let (core_base_url, core) = serve_bootstrap_sequence(vec![
                    ACTIVE_BOOTSTRAP.to_owned(),
                    account_42,
                    ACTIVE_BOOTSTRAP.to_owned(),
                ])
                .await;
                let (agent, _gateway_rx) = build_host_test_agent_with_package_delivery(
                    state_home.path(),
                    core_base_url,
                    package_roots(&root),
                    url::Url::parse(&transport_origin).expect("Package transport origin"),
                );

                let first_bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "account-41-token"}),
                    ),
                )
                .await
                .map(ext_result)
                .expect("account 41 bootstrap");
                assert_eq!(first_bootstrap["account"]["accountId"], 41);
                let remote_catalog = handle(
                    &agent,
                    &ext_request(AGENT_PACKAGES_REMOTE_CATALOG_METHOD, serde_json::json!({})),
                )
                .await
                .map(ext_result)
                .expect("discover signed Package through Host ACP");
                assert_eq!(remote_catalog["outcome"], "ready");
                assert_eq!(remote_catalog["registryRevision"], 42);
                assert_eq!(remote_catalog["registryExpiresAt"], "2026-08-01T00:00:00Z");
                assert_eq!(
                    remote_catalog["packages"],
                    serde_json::json!([{
                        "packageId": "com.agentmesh360.job-agent",
                        "agentId": "job-agent",
                        "version": "0.5.6",
                        "publisher": "agentmesh360"
                    }])
                );
                let remote_catalog_json = serde_json::to_string(&remote_catalog)
                    .expect("serialize remote Package catalog");
                for sensitive in [
                    "packages.agentmesh360.com",
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
                    "signature",
                    "rootKeyId",
                    state_home.path().to_str().expect("state path"),
                ] {
                    assert!(!remote_catalog_json.contains(sensitive));
                }
                let challenge = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_DOWNLOAD_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                )
                .await
                .map(ext_result)
                .expect("download Package through Host ACP");
                assert_eq!(challenge["status"], "approval_required");
                let approval_id = challenge["approval"]["approvalId"]
                    .as_str()
                    .expect("approval ID")
                    .to_owned();
                let challenge_json =
                    serde_json::to_string(&challenge).expect("serialize approval challenge");
                for sensitive in [
                    "packages.agentmesh360.com",
                    "relativePath",
                    "sha256",
                    state_home.path().to_str().expect("state path"),
                    "accountId",
                ] {
                    assert!(!challenge_json.contains(sensitive));
                }

                let second_bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "account-42-token"}),
                    ),
                )
                .await
                .map(ext_result)
                .expect("account 42 bootstrap");
                assert_eq!(second_bootstrap["account"]["accountId"], 42);
                let wrong_account = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_APPROVE_METHOD,
                        serde_json::json!({"approvalId": approval_id}),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("wrong account approval response");
                assert!(wrong_account["result"].is_null());
                assert_eq!(
                    wrong_account["error"]["code"],
                    "package_approval_unavailable"
                );

                let restored_bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "account-41-token-restored"}),
                    ),
                )
                .await
                .map(ext_result)
                .expect("restore account 41");
                assert_eq!(restored_bootstrap["account"]["accountId"], 41);
                let installed = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_APPROVE_METHOD,
                        serde_json::json!({"approvalId": approval_id}),
                    ),
                )
                .await
                .map(ext_result)
                .expect("owner account installs Package");
                assert_eq!(installed["packageId"], "com.agentmesh360.job-agent");
                assert_eq!(installed["version"], "0.5.6");
                assert_eq!(installed["runtimeVisibility"]["status"], "visible");
                assert_eq!(
                    agent
                        .agentmesh360
                        .registry()
                        .package_catalog_health()
                        .generation,
                    2
                );

                let replay = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_APPROVE_METHOD,
                        serde_json::json!({"approvalId": approval_id}),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("approval replay response");
                assert_eq!(replay["error"]["code"], "package_approval_unavailable");
                let reconciled = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_RECONCILE_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                )
                .await
                .map(ext_result)
                .expect("reconcile Package through Host ACP");
                assert_eq!(reconciled["runtimeVisibility"]["status"], "visible");
                let rollback = handle(
                    &agent,
                    &ext_request(
                        AGENT_PACKAGES_ROLLBACK_METHOD,
                        serde_json::json!({"packageId": "com.agentmesh360.job-agent"}),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("rollback without Previous response");
                assert_eq!(rollback["error"]["code"], "package_rollback_unavailable");
                let status = handle(
                    &agent,
                    &ext_request(AGENT_PACKAGES_STATUS_METHOD, serde_json::json!({})),
                )
                .await
                .map(ext_result)
                .expect("Package status after ACP install");
                assert!(status["packages"].as_array().is_some_and(|packages| {
                    packages.iter().any(|package| {
                        package["kind"] == "installed_active"
                            && package["packageId"] == "com.agentmesh360.job-agent"
                            && package["version"] == "0.5.6"
                    })
                }));
                let response_json = serde_json::to_string(&serde_json::json!([
                    wrong_account,
                    installed,
                    replay,
                    reconciled,
                    rollback,
                    status
                ]))
                .expect("serialize Package management responses");
                for sensitive in [
                    state_home.path().to_str().expect("state path"),
                    "relativePath",
                    "artifactSha256",
                    "signatureKeyId",
                    "account-41-token",
                    "account-42-token",
                ] {
                    assert!(!response_json.contains(sensitive));
                }
                assert_eq!(packages.await.expect("Package artifact server").len(), 3);
                assert_eq!(core.await.expect("Core server").len(), 3);
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn host_test_runtime_shares_memory_vault_across_acp_and_prompt_routing() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let (agent, _gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);

                let bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "sentinel-bootstrap-token"}),
                    ),
                )
                .await
                .expect("bootstrap response");
                let bootstrap = ext_result(bootstrap);
                assert_eq!(bootstrap["access"]["canEnterClient"], true);
                assert_eq!(bootstrap["credits"]["balance"], 0);
                let core_request = core.await.expect("Core request task");
                assert!(core_request.contains("authorization: Bearer sentinel-bootstrap-token"));

                let provider = handle(
                    &agent,
                    &ext_request(
                        providers::PROVIDERS_CREATE_METHOD,
                        serde_json::json!({
                            "profile": {
                                "presetId": "local-openai-chat",
                                "displayName": "Host E2E Local",
                                "protocol": "openai_chat",
                                "baseUrl": "http://127.0.0.1:11434/v1",
                                "authKind": "bearer_api_key",
                                "enabledModels": ["model-main"]
                            },
                            "apiKey": "sentinel-provider-secret-1234"
                        }),
                    ),
                )
                .await
                .expect("create Provider response");
                let provider = ext_result(provider);
                let profile_id = provider["profile"]["profileId"]
                    .as_str()
                    .expect("profile id")
                    .to_owned();
                assert!(
                    !provider
                        .to_string()
                        .contains("sentinel-provider-secret-1234")
                );

                handle(
                    &agent,
                    &ext_request(
                        model_routing::ASSIGNMENTS_UPSERT_METHOD,
                        serde_json::json!({
                            "assignment": {
                                "scopeKind": "agent",
                                "scopeId": "job-agent",
                                "role": "main",
                                "providerProfileId": profile_id,
                                "modelId": "model-main"
                            }
                        }),
                    ),
                )
                .await
                .expect("upsert Assignment");

                let record = agent
                    .agentmesh360
                    .registry()
                    .prepare_activation(41, "job-agent")
                    .expect("prepare product Agent");
                let session_id = record.main_session_id.expect("main Session");
                let route_context = agent
                    .agentmesh360
                    .session_route_context(&acp::SessionId::new(session_id.clone()))
                    .expect("route context lookup")
                    .expect("product Session route context");
                let mut route = route_context
                    .prepare_turn(&session_id, "turn-host-shared-vault")
                    .expect("prepare bound turn using ACP-created credential");
                route
                    .submit(|config| {
                        assert!(config.api_key.is_none());
                        assert!(config.bearer_resolver.is_some());
                        Ok(())
                    })
                    .expect("accept bound turn");
                let mut vision_route = route_context
                    .prepare_turn_for_role(&session_id, "vision", "turn-host-shared-vault-vision")
                    .expect("prepare auxiliary role with main Assignment fallback");
                vision_route
                    .submit(|config| {
                        assert_eq!(config.model, "model-main");
                        Ok(())
                    })
                    .expect("accept auxiliary bound turn");
                let child_session_id = "child-main-fallback";
                let delegated = route_context.delegate_for_role("subagent");
                assert_eq!(delegated.default_role_for_test(), "subagent");
                let mut subagent_route = delegated
                    .prepare_turn(child_session_id, "turn-host-shared-vault-subagent")
                    .expect("prepare delegated subagent role with main Assignment fallback");
                subagent_route
                    .submit(|config| {
                        assert_eq!(config.model, "model-main");
                        assert!(config.api_key.is_none());
                        assert!(config.bearer_resolver.is_some());
                        Ok(())
                    })
                    .expect("accept delegated subagent bound turn");

                let history = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "main",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("Turn Route history response");
                let history = ext_result(history);
                assert_eq!(history["turnRoutes"].as_array().map(Vec::len), Some(1));
                assert!(
                    !history
                        .to_string()
                        .contains("sentinel-provider-secret-1234")
                );
                assert!(!format!("{route:?}").contains("sentinel-provider-secret-1234"));

                let vision_binding = handle(
                    &agent,
                    &ext_request(
                        model_routing::BINDING_RESOLVE_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "vision",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("vision Binding response");
                let vision_binding = ext_result(vision_binding);
                assert_eq!(vision_binding["binding"]["role"], "vision");
                assert_eq!(vision_binding["binding"]["route"]["assignmentRole"], "main");
                assert!(!format!("{vision_route:?}").contains("sentinel-provider-secret-1234"));

                let subagent_binding = handle(
                    &agent,
                    &ext_request(
                        model_routing::BINDING_RESOLVE_METHOD,
                        serde_json::json!({
                            "sessionId": child_session_id,
                            "role": "subagent",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("subagent Binding response");
                let subagent_binding = ext_result(subagent_binding);
                assert_eq!(subagent_binding["binding"]["role"], "subagent");
                assert_eq!(
                    subagent_binding["binding"]["route"]["assignmentRole"],
                    "main"
                );
                let child_routes = agent
                    .agentmesh360
                    .turn_routes_for_host_test(41, child_session_id, "subagent")
                    .expect("delegated subagent Turn Routes");
                assert_eq!(child_routes.len(), 1);
                assert_eq!(child_routes[0].model_id, "model-main");
                assert!(!format!("{subagent_route:?}").contains("sentinel-provider-secret-1234"));
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn delegated_subagent_route_failures_create_no_ghost_turn_routes() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let runtime = AgentMesh360Runtime::for_host_test(state_home.path(), core_base_url);
                runtime
                    .bootstrap_for_host_test("sentinel-bootstrap-token")
                    .await
                    .expect("bootstrap product access");
                let _ = core.await.expect("Core request task");

                let record = runtime
                    .registry
                    .prepare_activation(41, "job-agent")
                    .expect("prepare product Agent");
                let parent_session_id = record.main_session_id.expect("Main Session");
                let missing_assignment_context = runtime
                    .session_route_context(&acp::SessionId::new(parent_session_id.clone()))
                    .expect("route context lookup")
                    .expect("product route context")
                    .delegate_for_role("subagent");
                assert!(
                    missing_assignment_context
                        .prepare_turn("child-missing-assignment", "turn-missing-assignment")
                        .is_err()
                );
                assert!(
                    runtime
                        .turn_routes_for_host_test(41, "child-missing-assignment", "subagent")
                        .expect("missing Assignment routes")
                        .is_empty()
                );

                runtime
                    .configure_product_route_for_host_test(
                        41,
                        "job-agent",
                        "http://127.0.0.1:9/v1",
                        "model-main",
                        "sentinel-main-failure-secret",
                    )
                    .expect("configure main fallback route");
                let subagent_profile_id = runtime
                    .configure_role_assignment_for_host_test(
                        41,
                        "job-agent",
                        "subagent",
                        "http://127.0.0.1:9/v1",
                        "model-subagent",
                        "sentinel-subagent-failure-secret",
                    )
                    .expect("configure subagent route");
                runtime
                    .remove_credential_for_host_test(41, &subagent_profile_id)
                    .expect("remove subagent Vault credential");
                let delegated = runtime
                    .session_route_context(&acp::SessionId::new(parent_session_id.clone()))
                    .expect("route context lookup")
                    .expect("product route context")
                    .delegate_for_role("subagent");
                assert!(
                    delegated
                        .prepare_turn("child-missing-vault", "turn-missing-vault")
                        .is_err()
                );
                assert!(
                    runtime
                        .turn_routes_for_host_test(41, "child-missing-vault", "subagent")
                        .expect("missing Vault routes")
                        .is_empty()
                );

                runtime.invalidate_access_for_host_test();
                assert!(
                    runtime
                        .session_route_context(&acp::SessionId::new(parent_session_id))
                        .is_err(),
                    "an account-unavailable product parent must not degrade to an ordinary session"
                );
                assert!(
                    delegated
                        .prepare_turn("child-expired-access", "turn-expired-access")
                        .is_err()
                );
                assert!(
                    runtime
                        .turn_routes_for_host_test(41, "child-expired-access", "subagent")
                        .expect("expired access routes")
                        .is_empty()
                );
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn host_parent_prompt_spawns_subagent_through_delegated_provider_route() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let (provider_base_url, mut provider_requests, provider_task) =
                    serve_subagent_route_provider_requests().await;
                let (agent, gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);
                let gateway_task = drive_gateway(gateway_rx);

                agent
                    .initialize(
                        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                            .client_capabilities(
                                acp::ClientCapabilities::new()
                                    .fs(acp::FileSystemCapabilities::new())
                                    .terminal(false),
                            )
                            .meta(
                                serde_json::json!({
                                    "startupHints": {
                                        "nonInteractive": true,
                                        "skipGitStatus": true,
                                        "skipProjectLayout": true
                                    },
                                    "clientType": "agentmesh360-subagent-route-test",
                                    "clientVersion": "0.0.0-test"
                                })
                                .as_object()
                                .cloned(),
                            ),
                    )
                    .await
                    .expect("initialize Host ACP agent");
                agent
                    .agentmesh360
                    .bootstrap_for_host_test("sentinel-bootstrap-token")
                    .await
                    .expect("bootstrap product access");
                let _ = core.await.expect("Core request task");

                agent
                    .agentmesh360
                    .configure_product_route_for_host_test(
                        41,
                        "job-agent",
                        &provider_base_url,
                        "model-main",
                        "sentinel-main-secret",
                    )
                    .expect("configure main product route");
                agent
                    .agentmesh360
                    .configure_role_assignment_for_host_test(
                        41,
                        "job-agent",
                        "subagent",
                        &provider_base_url,
                        "model-subagent",
                        "sentinel-subagent-secret",
                    )
                    .expect("configure dedicated subagent Assignment");

                let activation = handle(
                    &agent,
                    &ext_request(
                        AGENTS_ACTIVATE_METHOD,
                        serde_json::json!({"agentId": "job-agent"}),
                    ),
                )
                .await
                .expect("activate Job Agent");
                let activation = ext_result(activation);
                let parent_session_id = activation["agent"]["mainSessionId"]
                    .as_str()
                    .expect("activation Main Session")
                    .to_owned();

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        acp::SessionId::new(parent_session_id.clone()),
                        vec![acp::ContentBlock::from(
                            "Delegate one bounded verification and report the result.",
                        )],
                    )),
                )
                .await
                .expect("product subagent Prompt timed out")
                .expect("product subagent Prompt response");

                let mut captured = Vec::new();
                for _ in 0..3 {
                    let next =
                        tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                            .await;
                    match next {
                        Ok(Some(request)) => captured.push(request),
                        Ok(None) => panic!(
                            "Provider request channel closed after {} requests: {}",
                            captured.len(),
                            summarize_provider_requests(&captured)
                        ),
                        Err(_) => panic!(
                            "Provider request timed out after {} requests: {}",
                            captured.len(),
                            summarize_provider_requests(&captured)
                        ),
                    }
                }
                assert_eq!(captured[0].0, "Bearer sentinel-main-secret");
                assert_eq!(
                    captured[1].0,
                    "Bearer sentinel-subagent-secret",
                    "{}",
                    summarize_provider_requests(&captured)
                );
                assert_eq!(captured[2].0, "Bearer sentinel-main-secret");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&captured[0].1)
                        .expect("parent request JSON")["model"],
                    "model-main"
                );
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&captured[1].1)
                        .expect("subagent request JSON")["model"],
                    "model-subagent"
                );
                assert!(
                    captured[2].1.contains("child-provider-ok"),
                    "the parent continuation must receive the child result"
                );
                assert!(
                    tokio::time::timeout(Duration::from_millis(200), provider_requests.recv())
                        .await
                        .is_err(),
                    "subagent execution must not call an unbound fallback Provider"
                );

                let parent_routes = agent
                    .agentmesh360
                    .turn_routes_for_host_test(41, &parent_session_id, "main")
                    .expect("parent main Turn Routes");
                assert_eq!(parent_routes.len(), 1);
                assert_eq!(parent_routes[0].model_id, "model-main");

                let conn = state::open(state_home.path()).expect("open Host state");
                let mut statement = conn
                    .prepare(
                        "SELECT session_id, turn_id, model_id, endpoint_origin \
                         FROM turn_route_records WHERE owner_account_id = 41 \
                         AND role = 'subagent' ORDER BY rowid",
                    )
                    .expect("prepare delegated route query");
                let child_routes = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })
                    .expect("query delegated Turn Routes")
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .expect("collect delegated Turn Routes");
                assert_eq!(child_routes.len(), 1);
                assert_ne!(child_routes[0].0, parent_session_id);
                assert!(!child_routes[0].1.starts_with("subagent-bootstrap:"));
                assert_eq!(child_routes[0].2, "model-subagent");
                assert_eq!(
                    child_routes[0].3,
                    url::Url::parse(&provider_base_url)
                        .expect("Provider base URL")
                        .origin()
                        .ascii_serialization()
                );

                provider_task.abort();
                gateway_task.abort();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn host_job_agent_version_gate_and_package_upgrade_resume_in_same_session() {
        tokio::task::LocalSet::new()
            .run_until(async {
                use std::os::unix::fs::PermissionsExt as _;

                let state_home = tempfile::tempdir().expect("state home");
                let fixture_bin = state_home.path().join("fixture-bin");
                std::fs::create_dir_all(&fixture_bin).expect("create fixture bin");
                let fixture_marker = state_home.path().join("jobagent-command-order");
                let fixture_version = state_home.path().join("jobagent-version");
                let fixture_jobagent = fixture_bin.join("jobagent");
                std::fs::write(&fixture_version, "jobagent 0.5.5\n")
                    .expect("write outdated Job Agent version fixture");
                let fixture_upgrade = serde_json::json!({
                    "ok": true,
                    "event": "client_command_resumed",
                    "next_suggested": "fixture-upgrade-ready"
                });
                let fixture_state = serde_json::json!({
                    "environment_healthy": true,
                    "cloud_access": {"usable": true, "paid_pass_required": false},
                    "workflow": {
                        "ready": false,
                        "profile": null,
                        "round": null,
                        "next_suggested": "fixture-upload-resume"
                    },
                    "next_suggested": "fixture-upload-resume"
                });
                std::fs::write(
                    &fixture_jobagent,
                    format!(
                        "#!/bin/sh\n\
                         if [ \"$1\" = --version ]; then\n\
                           /usr/bin/printf 'version\\n' >> '{}';\n\
                           /bin/cat '{}';\n\
                           exit 0;\n\
                         fi\n\
                         if [ \"$1\" = upgrade-check ]; then\n\
                           /usr/bin/printf 'upgrade\\n' >> '{}';\n\
                           /usr/bin/printf '%s\\n' '{}';\n\
                           exit 0;\n\
                         fi\n\
                         if [ \"$1\" != doctor ] || [ \"$2\" != env ]; then\n\
                           /usr/bin/printf 'unexpected:%s %s\\n' \"$1\" \"$2\" >> '{}';\n\
                           exit 64;\n\
                         fi\n\
                         /usr/bin/printf 'doctor\\n' >> '{}'\n\
                         /usr/bin/printf '%s\\n' '{}'\n",
                        fixture_marker.display(),
                        fixture_version.display(),
                        fixture_marker.display(),
                        fixture_upgrade,
                        fixture_marker.display(),
                        fixture_marker.display(),
                        fixture_state
                    ),
                )
                .expect("write isolated jobagent fixture");
                std::fs::set_permissions(&fixture_jobagent, std::fs::Permissions::from_mode(0o755))
                    .expect("make isolated jobagent fixture executable");
                let version_command = format!("'{}' --version", fixture_jobagent.display());
                let upgrade_command = format!("'{}' upgrade-check", fixture_jobagent.display());
                let doctor_command = format!("'{}' doctor env", fixture_jobagent.display());

                let (core_base_url, core) = serve_bootstrap_once().await;
                let (provider_base_url, mut provider_requests, provider_task) =
                    serve_job_onboarding_provider_requests(
                        version_command.clone(),
                        upgrade_command.clone(),
                        doctor_command.clone(),
                    )
                    .await;
                let (agent, gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);
                let (gateway_task, mut notifications) = drive_recording_gateway(gateway_rx);
                agent
                    .initialize(
                        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                            .client_capabilities(
                                acp::ClientCapabilities::new()
                                    .fs(acp::FileSystemCapabilities::new())
                                    .terminal(false),
                            )
                            .meta(
                                serde_json::json!({
                                    "startupHints": {
                                        "nonInteractive": true,
                                        "skipGitStatus": true,
                                        "skipProjectLayout": true
                                    },
                                    "clientType": "agentmesh360-host-test",
                                    "clientVersion": "0.0.0-test"
                                })
                                .as_object()
                                .cloned(),
                            ),
                    )
                    .await
                    .expect("initialize Host ACP agent");

                let bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "sentinel-bootstrap-token"}),
                    ),
                )
                .await
                .expect("bootstrap response");
                assert_eq!(ext_result(bootstrap)["access"]["canEnterClient"], true);
                let _ = core.await.expect("Core request task");

                let provider = handle(
                    &agent,
                    &ext_request(
                        providers::PROVIDERS_CREATE_METHOD,
                        serde_json::json!({
                            "profile": {
                                "presetId": "compatible-openai-responses",
                                "displayName": "Job Onboarding Mock",
                                "protocol": "openai_responses",
                                "baseUrl": provider_base_url,
                                "authKind": "bearer_api_key",
                                "enabledModels": ["model-main"]
                            },
                            "apiKey": "sentinel-job-onboarding-secret"
                        }),
                    ),
                )
                .await
                .expect("create Provider response");
                let profile_id = ext_result(provider)["profile"]["profileId"]
                    .as_str()
                    .expect("profile id")
                    .to_owned();
                handle(
                    &agent,
                    &ext_request(
                        model_routing::ASSIGNMENTS_UPSERT_METHOD,
                        serde_json::json!({
                            "assignment": {
                                "scopeKind": "agent",
                                "scopeId": "job-agent",
                                "role": "main",
                                "providerProfileId": profile_id,
                                "modelId": "model-main"
                            }
                        }),
                    ),
                )
                .await
                .expect("upsert Assignment");
                let activation = handle(
                    &agent,
                    &ext_request(
                        AGENTS_ACTIVATE_METHOD,
                        serde_json::json!({"agentId": "job-agent"}),
                    ),
                )
                .await
                .expect("activate Job Agent");
                let session_id = ext_result(activation)["agent"]["mainSessionId"]
                    .as_str()
                    .expect("Job Agent Main Session")
                    .to_owned();

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        acp::SessionId::new(session_id.clone()),
                        vec![acp::ContentBlock::from("你好，你是谁？")],
                    )),
                )
                .await
                .expect("outdated Job Agent Prompt timed out")
                .expect("outdated Job Agent Prompt response");
                let mut outdated_reply = String::new();
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !outdated_reply.contains("官方更新") {
                        let notification = notifications
                            .recv()
                            .await
                            .expect("outdated Job Agent notification channel closed");
                        if let acp::SessionUpdate::AgentMessageChunk(chunk) = notification.update {
                            if let acp::ContentBlock::Text(text) = chunk.content {
                                outdated_reply.push_str(&text.text);
                            }
                        }
                    }
                })
                .await
                .expect("outdated Job Agent warning was not delivered to the client");
                assert!(outdated_reply.contains("0.5.5"));
                assert!(outdated_reply.contains("最低要求 0.5.6"));
                assert!(outdated_reply.contains("停止状态探针和猎聘操作"));
                let first = tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                    .await
                    .expect("outdated initial Provider request timed out")
                    .expect("outdated initial Provider request");
                let second = tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                    .await
                    .expect("outdated version-result Provider request timed out")
                    .expect("outdated version-result Provider request");
                for (authorization, _) in [&first, &second] {
                    assert_eq!(authorization, "Bearer sentinel-job-onboarding-secret");
                }
                assert_eq!(
                    std::fs::read_to_string(&fixture_marker).ok().as_deref(),
                    Some("version\n"),
                    "an outdated CLI must block upgrade-check, doctor and all platform commands"
                );
                assert!(first.1.contains("<resolved-jobagent> doctor env"));
                assert!(first.1.contains("not a general chat assistant"));
                assert!(first.1.contains("jobagent 0.5.6"));
                assert!(first.1.contains("<resolved-jobagent> upgrade-check"));
                assert!(first.1.contains("liepin_city_code_not_found"));
                assert!(second.1.contains("call_jobagent_version"));
                assert!(second.1.contains(&version_command));

                let resident_session_id = acp::SessionId::new(session_id.clone());
                let before = agent
                    .agentmesh360
                    .registry()
                    .get(41, "job-agent")
                    .expect("activated Job Agent before Package upgrade");
                let before_workspace = before.workspace_dir.clone();
                let mut legacy_definition = agent
                    .agentmesh360
                    .registry()
                    .agent_definition("job-agent")
                    .expect("current Job Agent definition");
                legacy_definition.prompt_body = Some("LEGACY_JOB_AGENT_0_4_8".into());
                let legacy_revision = AppliedAgentDefinitionRevision::from_definition(
                    "0.4.8",
                    (0, 0),
                    &legacy_definition,
                )
                .expect("legacy 0.4.8 Job Agent revision");
                let resident_cmd_tx = agent
                    .sessions
                    .borrow()
                    .get(&resident_session_id)
                    .expect("resident Job Agent session")
                    .cmd_tx
                    .clone();
                let (legacy_responds_to, legacy_response) = tokio::sync::oneshot::channel();
                resident_cmd_tx
                    .send(crate::session::SessionCommand::RebuildAgentForDefinition {
                        definition: legacy_definition,
                        responds_to: legacy_responds_to,
                    })
                    .expect("request legacy 0.4.8 Harness fixture");
                legacy_response
                    .await
                    .expect("legacy Harness actor response")
                    .expect("install legacy 0.4.8 Harness fixture");
                agent
                    .agentmesh360
                    .mark_agent_definition_applied(&resident_session_id, legacy_revision);
                std::fs::write(&fixture_version, "jobagent 0.5.6\n")
                    .expect("promote isolated Job Agent fixture to 0.5.6");

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        resident_session_id.clone(),
                        vec![acp::ContentBlock::from(
                            "更新完成，请在同一个会话继续刚才的工作。",
                        )],
                    )),
                )
                .await
                .expect("upgraded persistent Job Agent Prompt timed out")
                .expect("upgraded persistent Job Agent Prompt response");
                let mut visible_reply = String::new();
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !visible_reply.contains("不会自动投递") {
                        let notification = notifications
                            .recv()
                            .await
                            .expect("upgraded Job Agent notification channel closed");
                        if let acp::SessionUpdate::AgentMessageChunk(chunk) = notification.update {
                            if let acp::ContentBlock::Text(text) = chunk.content {
                                visible_reply.push_str(&text.text);
                            }
                        }
                    }
                })
                .await
                .expect("upgraded Job Agent reply was not delivered to the client");
                assert!(visible_reply.contains("PDF、DOCX、TXT 或 Markdown 简历"));
                assert!(visible_reply.contains("不会自动投递"));
                for generic_copy in ["我可以帮你做这些事情", "建立职业档案", "你想做什么"]
                {
                    assert!(
                        !visible_reply.contains(generic_copy),
                        "upgraded Job Agent reply regressed to a generic menu: {visible_reply}"
                    );
                }

                let third = tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                    .await
                    .expect("upgraded initial Provider request timed out")
                    .expect("upgraded initial Provider request");
                let fourth = tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                    .await
                    .expect("current version-result Provider request timed out")
                    .expect("current version-result Provider request");
                let fifth = tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                    .await
                    .expect("upgrade-result Provider request timed out")
                    .expect("upgrade-result Provider request");
                let sixth = tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                    .await
                    .expect("doctor-result Provider request timed out")
                    .expect("doctor-result Provider request");
                for (authorization, _) in [&third, &fourth, &fifth, &sixth] {
                    assert_eq!(authorization, "Bearer sentinel-job-onboarding-secret");
                }
                assert_eq!(
                    std::fs::read_to_string(&fixture_marker).ok().as_deref(),
                    Some("version\nversion\nupgrade\ndoctor\n")
                );
                assert!(third.1.contains("jobagent 0.5.6"));
                assert!(third.1.contains("liepin_city_code_not_found"));
                assert!(!third.1.contains("LEGACY_JOB_AGENT_0_4_8"));
                assert!(third.1.contains("低于最低要求 0.5.6"));
                assert!(fourth.1.contains("call_jobagent_version_current"));
                assert!(fourth.1.contains(&version_command));
                assert!(fifth.1.contains("call_jobagent_upgrade"));
                assert!(fifth.1.contains(&upgrade_command));
                assert!(fifth.1.contains("client_command_resumed"));
                assert!(sixth.1.contains("call_jobagent_doctor"));
                assert!(sixth.1.contains(&doctor_command));
                assert!(sixth.1.contains("fixture-upload-resume"));
                let after = agent
                    .agentmesh360
                    .registry()
                    .get(41, "job-agent")
                    .expect("activated Job Agent after Package upgrade");
                assert_eq!(after.main_session_id.as_deref(), Some(session_id.as_str()));
                assert_eq!(after.workspace_dir, before_workspace);
                assert!(
                    tokio::time::timeout(Duration::from_millis(200), provider_requests.recv())
                        .await
                        .is_err(),
                    "version recovery must not create an unbounded Provider loop"
                );

                provider_task.abort();
                gateway_task.abort();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn host_acp_flow_activates_product_agent_and_routes_real_prompt() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let (provider_base_url, mut provider_requests, provider_task) =
                    serve_provider_requests().await;
                let (agent, gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);
                let gateway_task = drive_gateway(gateway_rx);

                agent
                    .initialize(
                        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                            .client_capabilities(
                                acp::ClientCapabilities::new()
                                    .fs(acp::FileSystemCapabilities::new())
                                    .terminal(false),
                            )
                            .meta(
                                serde_json::json!({
                                    "startupHints": {
                                        "nonInteractive": true,
                                        "skipGitStatus": true,
                                        "skipProjectLayout": true
                                    },
                                    "clientType": "agentmesh360-host-test",
                                    "clientVersion": "0.0.0-test"
                                })
                                .as_object()
                                .cloned(),
                            ),
                    )
                    .await
                    .expect("initialize Host ACP agent");

                let ordinary_workspace = state_home.path().join("ordinary-session");
                std::fs::create_dir_all(&ordinary_workspace).expect("ordinary workspace");
                let ordinary_error = agent
                    .new_session(acp::NewSessionRequest::new(ordinary_workspace))
                    .await
                    .expect_err("ordinary Grok Session still requires Grok authentication");
                assert_eq!(ordinary_error.code, acp::Error::auth_required().code);

                let bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "sentinel-bootstrap-token"}),
                    ),
                )
                .await
                .expect("bootstrap response");
                assert_eq!(ext_result(bootstrap)["access"]["canEnterClient"], true);
                let _ = core.await.expect("Core request task");

                let provider = handle(
                    &agent,
                    &ext_request(
                        providers::PROVIDERS_CREATE_METHOD,
                        serde_json::json!({
                            "profile": {
                                "presetId": "compatible-openai-responses",
                                "displayName": "Host Prompt Mock",
                                "protocol": "openai_responses",
                                "baseUrl": provider_base_url,
                                "authKind": "bearer_api_key",
                                "enabledModels": ["model-main"]
                            },
                            "apiKey": "sentinel-provider-secret-5678"
                        }),
                    ),
                )
                .await
                .expect("create Provider response");
                let provider = ext_result(provider);
                let profile_id = provider["profile"]["profileId"]
                    .as_str()
                    .expect("profile id")
                    .to_owned();
                assert!(
                    !provider
                        .to_string()
                        .contains("sentinel-provider-secret-5678")
                );

                handle(
                    &agent,
                    &ext_request(
                        model_routing::ASSIGNMENTS_UPSERT_METHOD,
                        serde_json::json!({
                            "assignment": {
                                "scopeKind": "agent",
                                "scopeId": "job-agent",
                                "role": "main",
                                "providerProfileId": profile_id,
                                "modelId": "model-main"
                            }
                        }),
                    ),
                )
                .await
                .expect("upsert Assignment");

                let activation = handle(
                    &agent,
                    &ext_request(
                        AGENTS_ACTIVATE_METHOD,
                        serde_json::json!({"agentId": "job-agent"}),
                    ),
                )
                .await
                .expect("activate Job Agent");
                let activation_wire: serde_json::Value =
                    serde_json::from_str(activation.0.get()).expect("activation response JSON");
                if activation_wire["result"].is_null() {
                    let record = agent
                        .agentmesh360
                        .registry()
                        .get(41, "job-agent")
                        .expect("failed Agent record");
                    panic!(
                        "Agent activation failed: response={activation_wire}, last_error={:?}",
                        record.last_error
                    );
                }
                let activation = ext_result(activation);
                let session_id = activation["agent"]["mainSessionId"]
                    .as_str()
                    .unwrap_or_else(|| panic!("activation has no Main Session: {activation}"))
                    .to_owned();
                assert_eq!(activation["agent"]["runtimeState"], "resident");

                use base64::Engine as _;
                use image::{ImageBuffer, Rgba};
                let image: ImageBuffer<Rgba<u8>, Vec<u8>> =
                    ImageBuffer::from_pixel(32, 32, Rgba([128, 64, 32, 255]));
                let mut image_bytes = Vec::new();
                image
                    .write_to(
                        &mut std::io::Cursor::new(&mut image_bytes),
                        image::ImageFormat::Png,
                    )
                    .expect("encode Host E2E image");
                let image = acp::ImageContent::new(
                    base64::engine::general_purpose::STANDARD.encode(image_bytes),
                    "image/png",
                );

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        acp::SessionId::new(session_id.clone()),
                        vec![
                            acp::ContentBlock::from("Describe the image, then return the marker."),
                            acp::ContentBlock::Image(image),
                        ],
                    )),
                )
                .await
                .expect("product Prompt timed out")
                .expect("product Prompt response");

                let (main_authorization, main_request_body) =
                    tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                        .await
                        .expect("main Provider request timed out")
                        .expect("main Provider request capture");
                assert_eq!(main_authorization, "Bearer sentinel-provider-secret-5678");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&main_request_body)
                        .expect("main Provider request JSON")["model"],
                    "model-main"
                );
                for runtime_contract in [
                    "not a general chat assistant",
                    "jobagent 0.5.6",
                    "<resolved-jobagent> doctor env",
                    "<resolved-jobagent> upgrade-check",
                    "jobagent resume analyze --file <resume-path>",
                    "liepin_city_code_not_found",
                    "not as `no_candidates`",
                    "Do not answer a first greeting with a generic capability menu",
                ] {
                    assert!(
                        main_request_body.contains(runtime_contract),
                        "the real Sampling request is missing Job Agent onboarding: {runtime_contract}"
                    );
                }
                assert!(
                    main_request_body.contains("data:image/png;base64,"),
                    "the active Grok template must keep image data on the bound main request"
                );
                assert!(
                    tokio::time::timeout(Duration::from_millis(200), provider_requests.recv())
                        .await
                        .is_err(),
                    "the current non-Cursor template must not issue a separate vision request"
                );

                // Simulate an already-resident main session that was created by
                // the previous Job Agent Package. The Package upgrade must swap
                // only the harness definition: the stable session id and prior
                // conversation stay intact.
                let resident_session_id = acp::SessionId::new(session_id.clone());
                let mut legacy_definition = agent
                    .agentmesh360
                    .registry()
                    .agent_definition("job-agent")
                    .expect("current Job Agent definition");
                legacy_definition.prompt_body =
                    Some("LEGACY_GENERIC_JOB_AGENT_PROMPT".to_string());
                let legacy_revision = AppliedAgentDefinitionRevision::from_definition(
                    "0.4.8",
                    (0, 0),
                    &legacy_definition,
                )
                .expect("legacy Job Agent definition revision");
                let resident_cmd_tx = agent
                    .sessions
                    .borrow()
                    .get(&resident_session_id)
                    .expect("resident Job Agent session")
                    .cmd_tx
                    .clone();
                let (legacy_responds_to, legacy_response) = tokio::sync::oneshot::channel();
                resident_cmd_tx
                    .send(crate::session::SessionCommand::RebuildAgentForDefinition {
                        definition: legacy_definition,
                        responds_to: legacy_responds_to,
                    })
                    .expect("request legacy harness fixture");
                legacy_response
                    .await
                    .expect("legacy harness actor response")
                    .expect("install legacy harness fixture");
                agent
                    .agentmesh360
                    .mark_agent_definition_applied(&resident_session_id, legacy_revision);

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        resident_session_id.clone(),
                        vec![acp::ContentBlock::from(
                            "Continue the existing Job Agent work without restarting.",
                        )],
                    )),
                )
                .await
                .expect("upgraded resident product Prompt timed out")
                .expect("upgraded resident product Prompt response");
                let (upgraded_authorization, upgraded_request_body) =
                    tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                        .await
                        .expect("upgraded resident Provider request timed out")
                        .expect("upgraded resident Provider request capture");
                assert_eq!(
                    upgraded_authorization,
                    "Bearer sentinel-provider-secret-5678"
                );
                assert!(upgraded_request_body.contains("<resolved-jobagent> doctor env"));
                assert!(upgraded_request_body.contains("jobagent 0.5.6"));
                assert!(upgraded_request_body.contains("liepin_city_code_not_found"));
                assert!(upgraded_request_body.contains(
                    "Do not answer a first greeting with a generic capability menu"
                ));
                assert!(
                    !upgraded_request_body.contains("LEGACY_GENERIC_JOB_AGENT_PROMPT"),
                    "the next resident turn must not keep the previous Package System prompt"
                );
                assert!(
                    upgraded_request_body.contains("Describe the image, then return the marker."),
                    "upgrading the harness must preserve prior user history"
                );
                assert!(
                    upgraded_request_body.contains("host-e2e-ok"),
                    "upgrading the harness must preserve prior assistant history"
                );

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        acp::SessionId::new(session_id.clone()),
                        vec![acp::ContentBlock::from("/compact")],
                    )),
                )
                .await
                .expect("fallback product compaction timed out")
                .expect("fallback product compaction response");
                let (compaction_authorization, compaction_body) =
                    tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                        .await
                        .expect("fallback compaction Provider request timed out")
                        .expect("fallback compaction Provider request capture");
                assert_eq!(
                    compaction_authorization,
                    "Bearer sentinel-provider-secret-5678"
                );
                assert!(
                    compaction_body.contains("Your task is to produce a faithful, concise summary")
                );
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&compaction_body)
                        .expect("compaction Provider request JSON")["model"],
                    "model-main"
                );

                let routes = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "main",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("Turn Route history response");
                let routes = ext_result(routes);
                assert_eq!(routes["turnRoutes"].as_array().map(Vec::len), Some(2));
                assert_eq!(routes["turnRoutes"][0]["modelId"], "model-main");
                assert_eq!(routes["turnRoutes"][1]["modelId"], "model-main");
                assert!(!routes.to_string().contains("sentinel-provider-secret-5678"));

                let vision_routes = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "vision",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("vision Turn Route history response");
                let vision_routes = ext_result(vision_routes);
                assert_eq!(
                    vision_routes["turnRoutes"].as_array().map(Vec::len),
                    Some(0),
                    "the inactive Cursor transcription path must not create a ghost route"
                );

                let compaction_routes = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "compaction",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("compaction fallback Turn Route history response");
                let compaction_routes = ext_result(compaction_routes);
                assert_eq!(
                    compaction_routes["turnRoutes"].as_array().map(Vec::len),
                    Some(1)
                );
                assert_eq!(compaction_routes["turnRoutes"][0]["modelId"], "model-main");
                let compaction_binding = handle(
                    &agent,
                    &ext_request(
                        model_routing::BINDING_RESOLVE_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "compaction",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("compaction fallback Binding response");
                assert_eq!(
                    ext_result(compaction_binding)["binding"]["route"]["assignmentRole"],
                    "main"
                );

                provider_task.abort();
                gateway_task.abort();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn host_product_compaction_uses_bound_role_and_reuses_turn_route() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let (provider_base_url, mut provider_requests, provider_task) =
                    serve_compaction_provider_requests().await;
                let (agent, gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);
                let gateway_task = drive_gateway(gateway_rx);

                agent
                    .initialize(
                        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                            .client_capabilities(
                                acp::ClientCapabilities::new()
                                    .fs(acp::FileSystemCapabilities::new())
                                    .terminal(false),
                            )
                            .meta(
                                serde_json::json!({
                                    "startupHints": {
                                        "nonInteractive": true,
                                        "skipGitStatus": true,
                                        "skipProjectLayout": true
                                    },
                                    "clientType": "agentmesh360-host-test",
                                    "clientVersion": "0.0.0-test"
                                })
                                .as_object()
                                .cloned(),
                            ),
                    )
                    .await
                    .expect("initialize Host ACP agent");
                let bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "sentinel-bootstrap-token"}),
                    ),
                )
                .await
                .expect("bootstrap response");
                assert_eq!(ext_result(bootstrap)["access"]["canEnterClient"], true);
                let _ = core.await.expect("Core request task");

                let provider = handle(
                    &agent,
                    &ext_request(
                        providers::PROVIDERS_CREATE_METHOD,
                        serde_json::json!({
                            "profile": {
                                "presetId": "compatible-openai-responses",
                                "displayName": "Host Compaction Mock",
                                "protocol": "openai_responses",
                                "baseUrl": provider_base_url,
                                "authKind": "bearer_api_key",
                                "enabledModels": ["model-main", "model-compact"]
                            },
                            "apiKey": "sentinel-provider-secret-compact"
                        }),
                    ),
                )
                .await
                .expect("create Provider response");
                let profile_id = ext_result(provider)["profile"]["profileId"]
                    .as_str()
                    .expect("profile id")
                    .to_owned();
                for (role, model_id) in [("main", "model-main"), ("compaction", "model-compact")] {
                    handle(
                        &agent,
                        &ext_request(
                            model_routing::ASSIGNMENTS_UPSERT_METHOD,
                            serde_json::json!({
                                "assignment": {
                                    "scopeKind": "agent",
                                    "scopeId": "job-agent",
                                    "role": role,
                                    "providerProfileId": profile_id,
                                    "modelId": model_id
                                }
                            }),
                        ),
                    )
                    .await
                    .unwrap_or_else(|error| panic!("upsert {role} Assignment: {error:?}"));
                }

                let activation = handle(
                    &agent,
                    &ext_request(
                        AGENTS_ACTIVATE_METHOD,
                        serde_json::json!({"agentId": "job-agent"}),
                    ),
                )
                .await
                .expect("activate Job Agent");
                let session_id = ext_result(activation)["agent"]["mainSessionId"]
                    .as_str()
                    .expect("Job Agent Main Session")
                    .to_owned();

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        acp::SessionId::new(session_id.clone()),
                        vec![acp::ContentBlock::from(
                            "Seed the conversation before compaction.",
                        )],
                    )),
                )
                .await
                .expect("seed Prompt timed out")
                .expect("seed Prompt response");
                let (main_authorization, main_body) =
                    tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                        .await
                        .expect("main Provider request timed out")
                        .expect("main Provider request capture");
                assert_eq!(
                    main_authorization,
                    "Bearer sentinel-provider-secret-compact"
                );
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&main_body)
                        .expect("main request JSON")["model"],
                    "model-main"
                );

                tokio::time::timeout(
                    Duration::from_secs(45),
                    agent.prompt(acp::PromptRequest::new(
                        acp::SessionId::new(session_id.clone()),
                        vec![acp::ContentBlock::from("/compact")],
                    )),
                )
                .await
                .expect("product compaction timed out")
                .expect("product compaction response");

                for attempt in 1..=2 {
                    let (authorization, body) =
                        tokio::time::timeout(Duration::from_secs(5), provider_requests.recv())
                            .await
                            .unwrap_or_else(|_| panic!("compaction attempt {attempt} timed out"))
                            .unwrap_or_else(|| panic!("compaction attempt {attempt} missing"));
                    assert_eq!(authorization, "Bearer sentinel-provider-secret-compact");
                    let body: serde_json::Value =
                        serde_json::from_str(&body).expect("compaction request JSON");
                    assert_eq!(body["model"], "model-compact");
                }
                assert!(
                    tokio::time::timeout(Duration::from_millis(200), provider_requests.recv())
                        .await
                        .is_err(),
                    "degenerate retry must stop after the successful compaction response"
                );

                let routes = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": session_id,
                            "role": "compaction",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("compaction Turn Routes");
                let routes = ext_result(routes);
                assert_eq!(
                    routes["turnRoutes"].as_array().map(Vec::len),
                    Some(1),
                    "all attempts in one logical compaction share one Turn Route"
                );
                assert_eq!(routes["turnRoutes"][0]["modelId"], "model-compact");
                assert!(
                    !routes
                        .to_string()
                        .contains("sentinel-provider-secret-compact")
                );

                agent
                    .agentmesh360
                    .remove_credential_for_host_test(41, &profile_id)
                    .expect("remove compaction credential");
                let missing_vault = agent
                    .prompt(acp::PromptRequest::new(
                        acp::SessionId::new(session_id.clone()),
                        vec![acp::ContentBlock::from("/compact preserve routing")],
                    ))
                    .await
                    .expect_err("missing Vault credential must block compaction");
                assert!(
                    format!("{missing_vault:?}").contains("agentmesh360_provider_route_required")
                );
                assert!(
                    tokio::time::timeout(Duration::from_millis(200), provider_requests.recv())
                        .await
                        .is_err(),
                    "missing Vault must fail before Provider submission"
                );

                agent.agentmesh360.invalidate_access_for_host_test();
                let denied = agent
                    .prompt(acp::PromptRequest::new(
                        acp::SessionId::new(session_id),
                        vec![acp::ContentBlock::from("/compact")],
                    ))
                    .await
                    .expect_err("invalid subscription must block compaction");
                assert_eq!(denied.code, acp::Error::auth_required().code);
                assert!(
                    tokio::time::timeout(Duration::from_millis(200), provider_requests.recv())
                        .await
                        .is_err(),
                    "invalid subscription must not reach Provider"
                );

                provider_task.abort();
                gateway_task.abort();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn host_acp_failure_matrix_blocks_before_provider_submission() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let denied_home = tempfile::tempdir().expect("denied state home");
                let denied_body = ACTIVE_BOOTSTRAP
                    .replace("\"status\":\"active\"", "\"status\":\"expired\"")
                    .replace("\"can_enter_client\":true", "\"can_enter_client\":false")
                    .replace("active_subscription", "subscription_expired");
                let (denied_core_url, denied_core) =
                    serve_bootstrap_sequence(vec![denied_body]).await;
                let (denied_agent, _gateway_rx) =
                    build_host_test_agent(denied_home.path(), denied_core_url);
                let denied = handle(
                    &denied_agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "expired-token"}),
                    ),
                )
                .await
                .expect("denied bootstrap response");
                assert_eq!(ext_result(denied)["access"]["canEnterClient"], false);
                let activation_error = handle(
                    &denied_agent,
                    &ext_request(
                        AGENTS_ACTIVATE_METHOD,
                        serde_json::json!({"agentId": "job-agent"}),
                    ),
                )
                .await
                .expect_err("denied subscription cannot activate a product Agent");
                assert_eq!(activation_error.code, acp::Error::auth_required().code);
                let _ = denied_core.await.expect("denied Core task");

                let state_home = tempfile::tempdir().expect("state home");
                let account_42 = ACTIVE_BOOTSTRAP
                    .replace("\"id\":1", "\"id\":2")
                    .replace("u@example.com", "other@example.com")
                    .replace("\"account_id\":41", "\"account_id\":42");
                let (core_base_url, core) =
                    serve_bootstrap_sequence(vec![ACTIVE_BOOTSTRAP.to_owned(), account_42]).await;
                let (agent, gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);
                let gateway_task = drive_gateway(gateway_rx);
                agent
                    .initialize(
                        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                            .client_capabilities(
                                acp::ClientCapabilities::new()
                                    .fs(acp::FileSystemCapabilities::new())
                                    .terminal(false),
                            )
                            .meta(
                                serde_json::json!({
                                    "startupHints": {
                                        "nonInteractive": true,
                                        "skipGitStatus": true,
                                        "skipProjectLayout": true
                                    },
                                    "clientType": "agentmesh360-host-test",
                                    "clientVersion": "0.0.0-test"
                                })
                                .as_object()
                                .cloned(),
                            ),
                    )
                    .await
                    .expect("initialize Host ACP agent");
                let bootstrap = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "account-41-token"}),
                    ),
                )
                .await
                .expect("account 41 bootstrap");
                assert_eq!(ext_result(bootstrap)["account"]["accountId"], 41);

                let job_activation = handle(
                    &agent,
                    &ext_request(
                        AGENTS_ACTIVATE_METHOD,
                        serde_json::json!({"agentId": "job-agent"}),
                    ),
                )
                .await
                .expect("activate Job Agent");
                let job_session = ext_result(job_activation)["agent"]["mainSessionId"]
                    .as_str()
                    .expect("Job Agent Main Session")
                    .to_owned();
                let missing_assignment = agent
                    .prompt(acp::PromptRequest::new(
                        acp::SessionId::new(job_session.clone()),
                        vec![acp::ContentBlock::from("must fail before Sampling")],
                    ))
                    .await
                    .expect_err("missing Assignment must fail closed");
                assert_eq!(missing_assignment.code, acp::Error::internal_error().code);
                assert!(
                    format!("{missing_assignment:?}")
                        .contains("agentmesh360_provider_route_required")
                );
                let job_routes = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": job_session.clone(),
                            "role": "main",
                            "agentId": "job-agent"
                        }),
                    ),
                )
                .await
                .expect("Job Agent Turn Routes");
                assert_eq!(
                    ext_result(job_routes)["turnRoutes"]
                        .as_array()
                        .map(Vec::len),
                    Some(0)
                );

                let provider = handle(
                    &agent,
                    &ext_request(
                        providers::PROVIDERS_CREATE_METHOD,
                        serde_json::json!({
                            "profile": {
                                "presetId": "compatible-openai-responses",
                                "displayName": "Missing Vault Provider",
                                "protocol": "openai_responses",
                                "baseUrl": "http://127.0.0.1:9/v1",
                                "authKind": "bearer_api_key",
                                "enabledModels": ["model-main"]
                            },
                            "apiKey": "sentinel-provider-secret-missing"
                        }),
                    ),
                )
                .await
                .expect("create missing-Vault Provider");
                let profile_id = ext_result(provider)["profile"]["profileId"]
                    .as_str()
                    .expect("profile id")
                    .to_owned();
                handle(
                    &agent,
                    &ext_request(
                        model_routing::ASSIGNMENTS_UPSERT_METHOD,
                        serde_json::json!({
                            "assignment": {
                                "scopeKind": "agent",
                                "scopeId": "deploy-agent",
                                "role": "main",
                                "providerProfileId": profile_id,
                                "modelId": "model-main"
                            }
                        }),
                    ),
                )
                .await
                .expect("upsert Deploy Assignment");
                let deploy_activation = handle(
                    &agent,
                    &ext_request(
                        AGENTS_ACTIVATE_METHOD,
                        serde_json::json!({"agentId": "deploy-agent"}),
                    ),
                )
                .await
                .expect("activate Deploy Agent");
                let deploy_session = ext_result(deploy_activation)["agent"]["mainSessionId"]
                    .as_str()
                    .expect("Deploy Agent Main Session")
                    .to_owned();
                agent
                    .agentmesh360
                    .remove_credential_for_host_test(41, &profile_id)
                    .expect("remove test credential");
                let missing_vault = agent
                    .prompt(acp::PromptRequest::new(
                        acp::SessionId::new(deploy_session.clone()),
                        vec![acp::ContentBlock::from("must not reach Provider")],
                    ))
                    .await
                    .expect_err("missing Vault credential must fail closed");
                assert_eq!(missing_vault.code, acp::Error::internal_error().code);
                assert!(
                    format!("{missing_vault:?}").contains("agentmesh360_provider_route_required")
                );
                let deploy_routes = handle(
                    &agent,
                    &ext_request(
                        model_routing::TURN_ROUTES_LIST_METHOD,
                        serde_json::json!({
                            "sessionId": deploy_session,
                            "role": "main",
                            "agentId": "deploy-agent"
                        }),
                    ),
                )
                .await
                .expect("Deploy Agent Turn Routes");
                assert_eq!(
                    ext_result(deploy_routes)["turnRoutes"]
                        .as_array()
                        .map(Vec::len),
                    Some(0)
                );

                let switched = handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "account-42-token"}),
                    ),
                )
                .await
                .expect("account 42 bootstrap");
                assert_eq!(ext_result(switched)["account"]["accountId"], 42);
                let cross_account = agent
                    .prompt(acp::PromptRequest::new(
                        acp::SessionId::new(job_session),
                        vec![acp::ContentBlock::from("must remain hidden")],
                    ))
                    .await
                    .expect_err("old account product Session must be hidden");
                assert_eq!(cross_account.code, acp::Error::invalid_params().code);

                assert_eq!(core.await.expect("Core sequence task").len(), 2);
                gateway_task.abort();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn input_capabilities_are_active_agent_scoped_and_path_redacted() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let state_home = tempfile::tempdir().expect("state home");
                let (core_base_url, core) = serve_bootstrap_once().await;
                let (agent, _gateway_rx) = build_host_test_agent(state_home.path(), core_base_url);
                handle(
                    &agent,
                    &ext_request(
                        ACCOUNT_BOOTSTRAP_METHOD,
                        serde_json::json!({"accessToken": "input-capability-token"}),
                    ),
                )
                .await
                .expect("bootstrap input capability access");
                let _ = core.await.expect("Core request task");

                let inactive = handle(
                    &agent,
                    &ext_request(
                        AGENT_INPUT_CAPABILITIES_GET_METHOD,
                        serde_json::json!({
                            "agentId": "job-agent",
                            "sessionId": "not-an-active-session"
                        }),
                    ),
                )
                .await
                .map(ext_envelope)
                .expect("inactive Agent returns a redacted extension error");
                assert_eq!(inactive["result"], serde_json::Value::Null);
                assert_eq!(
                    inactive["error"],
                    "Agent input capabilities require its active main session"
                );

                let job = agent
                    .agentmesh360
                    .registry()
                    .prepare_activation(41, "job-agent")
                    .expect("prepare Job Agent activation");
                let job_session = job.main_session_id.expect("Job Main Session");
                let job_capabilities = handle(
                    &agent,
                    &ext_request(
                        AGENT_INPUT_CAPABILITIES_GET_METHOD,
                        serde_json::json!({
                            "agentId": "job-agent",
                            "sessionId": job_session.clone()
                        }),
                    ),
                )
                .await
                .map(ext_result)
                .expect("Job input capabilities");
                assert_eq!(job_capabilities["schemaVersion"], 1);
                assert_eq!(job_capabilities["agentId"], "job-agent");
                assert!(job_capabilities["revision"].as_u64().is_some());
                assert_eq!(
                    job_capabilities["commands"]
                        .as_array()
                        .expect("commands")
                        .iter()
                        .map(|command| command["trigger"].as_str().expect("trigger"))
                        .collect::<Vec<_>>(),
                    ["/compact", "/context", "/session-info"]
                );
                assert_eq!(
                    job_capabilities["skills"]
                        .as_array()
                        .expect("skills")
                        .iter()
                        .map(|skill| skill["id"].as_str().expect("skill id"))
                        .collect::<Vec<_>>(),
                    ["career-profile", "job-search"]
                );
                let serialized =
                    serde_json::to_string(&job_capabilities).expect("serialize input capabilities");
                for forbidden in [
                    "always-approve",
                    "yolo",
                    "plugin",
                    "hooks",
                    "workspaceDir",
                    "sessionId",
                    state_home.path().to_string_lossy().as_ref(),
                ] {
                    assert!(!serialized.contains(forbidden), "found {forbidden}");
                }

                let malicious = handle(
                    &agent,
                    &ext_request(
                        AGENT_INPUT_CAPABILITIES_GET_METHOD,
                        serde_json::json!({
                            "agentId": "job-agent",
                            "sessionId": job_session,
                            "cwd": "/attacker/controlled",
                            "command": "/yolo"
                        }),
                    ),
                )
                .await
                .expect_err("unknown authority and command fields fail closed");
                assert_eq!(malicious.code, acp::Error::invalid_params().code);

                let deploy = agent
                    .agentmesh360
                    .registry()
                    .prepare_activation(41, "deploy-agent")
                    .expect("prepare Deploy Agent activation");
                let deploy_capabilities = handle(
                    &agent,
                    &ext_request(
                        AGENT_INPUT_CAPABILITIES_GET_METHOD,
                        serde_json::json!({
                            "agentId": "deploy-agent",
                            "sessionId": deploy.main_session_id
                        }),
                    ),
                )
                .await
                .map(ext_result)
                .expect("Deploy input capabilities");
                assert_eq!(deploy_capabilities["agentId"], "deploy-agent");
                assert_eq!(
                    deploy_capabilities["skills"]
                        .as_array()
                        .expect("Deploy skills")
                        .iter()
                        .map(|skill| skill["id"].as_str().expect("Deploy skill id"))
                        .collect::<Vec<_>>(),
                    ["release-preflight", "deployment-verification"]
                );
                assert_ne!(
                    job_capabilities["revision"],
                    deploy_capabilities["revision"]
                );
            })
            .await;
    }
}
