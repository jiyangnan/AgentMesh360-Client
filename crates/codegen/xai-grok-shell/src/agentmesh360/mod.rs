//! AgentMesh360's persistent first-party product-agent layer.
//!
//! Grok Build remains the execution harness and the source of truth for session
//! transcripts, tools, permissions, memory, and subagents. This module adds the
//! stable product identity that a desktop client needs: one catalog entry and one
//! deterministic main conversation per activated product agent.

mod access;
mod agent_packages;
mod credential_lease;
mod credential_vault;
mod model_assignments;
mod model_policy;
mod model_routing;
mod package_artifact;
mod package_installer;
mod package_registry_fetcher;
mod package_registry_snapshot;
mod package_trust;
mod package_trust_cache;
mod provider_catalog;
mod provider_probes;
mod provider_profiles;
mod providers;
pub mod registry;
mod session_bindings;
mod state;
mod turn_routes;
pub(crate) mod turn_submission;

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::path::PathBuf;

use agent_client_protocol as acp;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use crate::agent::MvpAgent;
use crate::agent::mvp_agent::LocalRef;
use crate::agent::roster::RosterActivity;
use registry::{AgentRegistry, ProductAgentRecord};

pub const ACCOUNT_BOOTSTRAP_METHOD: &str = "x.agentmesh360/account/bootstrap";
pub const AGENTS_LIST_METHOD: &str = "x.agentmesh360/agents/list";
pub const AGENTS_ACTIVATE_METHOD: &str = "x.agentmesh360/agents/activate";
pub const AGENT_PACKAGES_CATALOG_METHOD: &str = "x.agentmesh360/agent-packages/catalog";
pub const AGENT_PACKAGES_STATUS_METHOD: &str = "x.agentmesh360/agent-packages/status";

pub(crate) struct AgentMesh360Runtime {
    registry: AgentRegistry,
    providers: providers::ProviderService<credential_vault::RuntimeCredentialVault>,
    provider_probes:
        provider_probes::ProviderProbeService<credential_vault::RuntimeCredentialVault>,
    model_routing: model_routing::ModelRoutingService,
    package_registry_fetcher: package_registry_fetcher::PackageRegistryFetcher,
    access: access::ClientAccess,
    state_home: PathBuf,
    credential_vault: credential_vault::RuntimeCredentialVault,
    pinned_sessions: RefCell<HashSet<acp::SessionId>>,
    restore_started: Cell<bool>,
    access_generation: Cell<u64>,
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
            package_registry_fetcher: package_registry_fetcher::PackageRegistryFetcher::embedded(
                &state_home,
            ),
            access,
            state_home,
            credential_vault,
            pinned_sessions: RefCell::default(),
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

    pub(crate) fn pin(&self, session_id: acp::SessionId) {
        self.pinned_sessions.borrow_mut().insert(session_id);
    }

    pub(crate) fn is_pinned(&self, session_id: &acp::SessionId) -> bool {
        self.pinned_sessions.borrow().contains(session_id)
    }

    fn suspend_residency(&self) -> bool {
        let had_pins = !self.pinned_sessions.borrow().is_empty();
        self.pinned_sessions.borrow_mut().clear();
        let had_restore = self.restore_started.replace(false);
        had_pins || had_restore
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
    let residency_changed = agent.agentmesh360.suspend_residency();
    if !force_notify && !residency_changed {
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
    let persisted_cwd = crate::session::resolve_local_session_any_cwd(session_id.0.as_ref());
    let mut meta = acp::Meta::new();
    meta.insert("agentProfile".into(), profile.to_json_value());
    meta.insert("agentmesh360AgentId".into(), agent_id.into());
    meta.insert("agentmesh360AccountId".into(), owner_account_id.into());
    meta.insert(
        "clientIdentifier".into(),
        "agentmesh360-product-agent".into(),
    );

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
    } else if crate::session::resolve_local_session_any_cwd(session_id.0.as_ref()).is_some() {
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
    use futures_util::stream;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
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
        let envelope: serde_json::Value =
            serde_json::from_str(response.0.get()).expect("extension response");
        match envelope.get("result") {
            Some(result) if !result.is_null() => result.clone(),
            _ => panic!("extension response has no successful result: {envelope}"),
        }
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
                assert_eq!(routes["turnRoutes"].as_array().map(Vec::len), Some(1));
                assert_eq!(routes["turnRoutes"][0]["modelId"], "model-main");
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
}
