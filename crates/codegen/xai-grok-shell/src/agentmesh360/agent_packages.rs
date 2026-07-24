use std::collections::HashSet;
use std::path::{Component, Path};

use anyhow::{Context, Result, anyhow, bail};
use semver::Version;
use serde::{Deserialize, Serialize};
use url::Url;
use xai_grok_agent::AgentDefinition;

use super::model_policy::AgentModelPolicy;

const SUPPORTED_MANIFEST_SCHEMA_VERSION: u32 = 1;
const BUILTIN_CATALOG_REVISION: u64 = 1;
const BUILTIN_PACKAGE_DOCUMENTS: [&str; 3] = [
    include_str!("packages/job-agent/agentmesh-agent.toml"),
    include_str!("packages/lecturecast-agent/agentmesh-agent.toml"),
    include_str!("packages/deploy-agent/agentmesh-agent.toml"),
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPackageManifest {
    pub schema_version: u32,
    pub package_id: String,
    pub version: String,
    pub publisher: String,
    pub source_repository: String,
    pub requested_permissions: Vec<PackagePermission>,
    pub agent: ProductAgentManifest,
    pub persistence: PersistenceProjection,
    pub runtime: RuntimeProjection,
    pub model_policy: AgentModelPolicy,
    pub skills: SkillProjection,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProductAgentManifest {
    pub agent_id: String,
    pub display_name: String,
    pub description: String,
    pub sort_order: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PackagePermission {
    BrowserControl,
    ExternalActions,
    ExternalMutations,
    LocalFiles,
    NetworkAccess,
    ProcessExecution,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersistenceProjection {
    pub main_session_strategy: MainSessionStrategy,
    pub workspace_strategy: WorkspaceStrategy,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MainSessionStrategy {
    AccountAgentStableV5,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceStrategy {
    AccountAgentDirectory,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeProjection {
    pub prompt_mode: PromptMode,
    pub discover_skills: bool,
    pub inherit_skills: bool,
    pub agents_md: bool,
    pub prompt_body: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PromptMode {
    Extend,
    Replace,
}

impl PromptMode {
    fn as_agent_definition_value(self) -> &'static str {
        match self {
            Self::Extend => "extend",
            Self::Replace => "replace",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillProjection {
    pub canonical_workflow: String,
    #[serde(default)]
    pub adapters: Vec<SkillAdapter>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillAdapter {
    pub host: SkillHost,
    pub path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SkillHost {
    Codex,
    ClaudeCode,
    Openclaw,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPackageCatalog {
    pub schema_version: u32,
    pub catalog_revision: u64,
    pub packages: Vec<AgentPackageManifest>,
}

impl AgentPackageCatalog {
    pub(crate) fn builtin() -> Result<Self> {
        Self::from_documents(&BUILTIN_PACKAGE_DOCUMENTS)
            .context("load built-in AgentMesh360 Agent Packages")
    }

    fn from_documents(documents: &[&str]) -> Result<Self> {
        let mut packages = Vec::with_capacity(documents.len());
        for document in documents {
            let manifest: AgentPackageManifest =
                toml::from_str(document).context("parse Agent Package Manifest")?;
            validate_manifest(&manifest)?;
            packages.push(manifest);
        }
        validate_catalog(&packages)?;
        packages.sort_by_key(|package| package.agent.sort_order);
        Ok(Self {
            schema_version: SUPPORTED_MANIFEST_SCHEMA_VERSION,
            catalog_revision: BUILTIN_CATALOG_REVISION,
            packages,
        })
    }

    pub(crate) fn package_for_agent(&self, agent_id: &str) -> Result<&AgentPackageManifest> {
        self.packages
            .iter()
            .find(|package| package.agent.agent_id == agent_id)
            .ok_or_else(|| anyhow!("unknown AgentMesh360 product agent: {agent_id}"))
    }
}

impl AgentPackageManifest {
    pub(crate) fn agent_definition(&self) -> Result<AgentDefinition> {
        AgentDefinition::from_json(&serde_json::json!({
            "name": self.agent.agent_id,
            "description": self.agent.description,
            "promptMode": self.runtime.prompt_mode.as_agent_definition_value(),
            "discoverSkills": self.runtime.discover_skills,
            "inheritSkills": self.runtime.inherit_skills,
            "agentsMd": self.runtime.agents_md,
            "promptBody": self.runtime.prompt_body,
        }))
        .with_context(|| format!("build {} profile", self.agent.agent_id))
    }
}

fn validate_manifest(manifest: &AgentPackageManifest) -> Result<()> {
    if manifest.schema_version != SUPPORTED_MANIFEST_SCHEMA_VERSION {
        bail!(
            "unsupported Agent Package Manifest schema version: {}",
            manifest.schema_version
        );
    }
    validate_identifier("packageId", &manifest.package_id, true)?;
    validate_identifier("publisher", &manifest.publisher, true)?;
    validate_identifier("agent.agentId", &manifest.agent.agent_id, false)?;
    Version::parse(&manifest.version)
        .with_context(|| format!("invalid Agent Package version: {}", manifest.version))?;
    validate_source_repository(&manifest.source_repository)?;
    if manifest.agent.display_name.trim().is_empty()
        || manifest.agent.description.trim().is_empty()
        || manifest.runtime.prompt_body.trim().is_empty()
    {
        bail!("Agent Package identity and prompt fields must not be empty");
    }
    if manifest.agent.sort_order < 0 {
        bail!("Agent Package sortOrder must not be negative");
    }
    if manifest.requested_permissions.is_empty() {
        bail!("Agent Package requestedPermissions must not be empty");
    }
    if manifest
        .requested_permissions
        .iter()
        .collect::<HashSet<_>>()
        .len()
        != manifest.requested_permissions.len()
    {
        bail!("Agent Package requestedPermissions must not contain duplicates");
    }
    validate_relative_package_path(
        "skills.canonicalWorkflow",
        &manifest.skills.canonical_workflow,
    )?;
    let mut hosts = HashSet::new();
    for adapter in &manifest.skills.adapters {
        if !hosts.insert(adapter.host) {
            bail!("Agent Package has duplicate Skill Adapter host");
        }
        validate_relative_package_path("skills.adapters.path", &adapter.path)?;
    }
    Ok(())
}

fn validate_catalog(packages: &[AgentPackageManifest]) -> Result<()> {
    if packages.is_empty() {
        bail!("Agent Package Catalog must not be empty");
    }
    let mut package_ids = HashSet::new();
    let mut agent_ids = HashSet::new();
    let mut sort_orders = HashSet::new();
    for package in packages {
        if !package_ids.insert(package.package_id.as_str()) {
            bail!("duplicate Agent Package packageId: {}", package.package_id);
        }
        if !agent_ids.insert(package.agent.agent_id.as_str()) {
            bail!(
                "duplicate Agent Package agentId: {}",
                package.agent.agent_id
            );
        }
        if !sort_orders.insert(package.agent.sort_order) {
            bail!(
                "duplicate Agent Package sortOrder: {}",
                package.agent.sort_order
            );
        }
    }
    Ok(())
}

fn validate_identifier(field: &str, value: &str, allow_period: bool) -> Result<()> {
    let valid = !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || byte == b'-'
                || (allow_period && byte == b'.')
        })
        && !value.starts_with(['-', '.'])
        && !value.ends_with(['-', '.']);
    if !valid {
        bail!("Agent Package {field} is invalid");
    }
    Ok(())
}

fn validate_source_repository(value: &str) -> Result<()> {
    let url = Url::parse(value).context("Agent Package sourceRepository is invalid")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Agent Package sourceRepository must be an HTTPS URL without credentials or params");
    }
    Ok(())
}

fn validate_relative_package_path(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        bail!("Agent Package {field} must not be empty");
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("Agent Package {field} must be a normalized relative path");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOB_DOCUMENT: &str = include_str!("packages/job-agent/agentmesh-agent.toml");

    #[test]
    fn builtins_are_versioned_packages_in_product_order() {
        let catalog = AgentPackageCatalog::builtin().expect("built-in packages");

        assert_eq!(catalog.schema_version, 1);
        assert_eq!(catalog.catalog_revision, 1);
        assert_eq!(
            catalog
                .packages
                .iter()
                .map(|package| (
                    package.agent.agent_id.as_str(),
                    package.version.as_str(),
                    package.skills.adapters.len()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("job-agent", "0.4.7", 2),
                ("lecturecast-agent", "0.4.0", 3),
                ("deploy-agent", "0.1.1", 0),
            ]
        );
    }

    #[test]
    fn product_profiles_are_derived_from_the_same_manifest() {
        let catalog = AgentPackageCatalog::builtin().expect("built-in packages");

        for package in &catalog.packages {
            let profile = package.agent_definition().expect("profile");
            assert_eq!(profile.name, package.agent.agent_id);
            assert_eq!(profile.description, package.agent.description);
            assert!(
                profile
                    .prompt_body
                    .as_deref()
                    .is_some_and(|body| body.contains("persistent"))
            );
        }
    }

    #[test]
    fn future_schema_and_unknown_fields_fail_closed() {
        let future = JOB_DOCUMENT.replacen("schemaVersion = 1", "schemaVersion = 2", 1);
        assert!(
            AgentPackageCatalog::from_documents(&[&future])
                .expect_err("future schema")
                .to_string()
                .contains("unsupported")
        );

        let unknown = format!("{JOB_DOCUMENT}\nunknownField = true\n");
        assert!(AgentPackageCatalog::from_documents(&[&unknown]).is_err());
    }

    #[test]
    fn unknown_permissions_and_unsafe_adapter_paths_fail_closed() {
        let unknown_permission = JOB_DOCUMENT.replacen("browser_control", "unrestricted_root", 1);
        assert!(AgentPackageCatalog::from_documents(&[&unknown_permission]).is_err());

        let traversal =
            JOB_DOCUMENT.replacen("skills/claude-code/SKILL.md", "../outside/SKILL.md", 1);
        assert!(AgentPackageCatalog::from_documents(&[&traversal]).is_err());
    }

    #[test]
    fn duplicate_package_or_agent_identity_fails_closed() {
        assert!(AgentPackageCatalog::from_documents(&[JOB_DOCUMENT, JOB_DOCUMENT]).is_err());
    }

    #[test]
    fn public_package_metadata_has_no_secret_or_user_data_fields() {
        let catalog = AgentPackageCatalog::builtin().expect("built-in packages");
        let json = serde_json::to_string(&catalog)
            .expect("serialize package catalog")
            .to_ascii_lowercase();

        for forbidden in [
            "apikey",
            "api_key",
            "accesstoken",
            "refresh_token",
            "credentialref",
            "owneraccountid",
            "sessionid",
            "workspacepath",
        ] {
            assert!(
                !json.contains(forbidden),
                "found forbidden field {forbidden}"
            );
        }
    }
}
