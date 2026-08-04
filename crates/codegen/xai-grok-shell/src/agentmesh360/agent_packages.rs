use std::collections::HashSet;
use std::path::{Component, Path};

use anyhow::{Context, Result, anyhow, bail};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use xai_grok_agent::AgentDefinition;

use super::model_policy::AgentModelPolicy;

const SUPPORTED_MANIFEST_SCHEMA_VERSION: u32 = 1;
const BUILTIN_CATALOG_REVISION: u64 = 1;
const MAX_SAFE_JSON_INTEGER: u64 = (1_u64 << 53) - 1;
const MAX_USER_SKILLS: usize = 32;
const MAX_USER_SKILL_DISPLAY_CHARS: usize = 80;
const MAX_USER_SKILL_DESCRIPTION_CHARS: usize = 300;
const MAX_USER_SKILL_PROMPT_CHARS: usize = 2_000;
pub(super) const MAX_PACKAGE_IDENTIFIER_BYTES: usize = 128;
pub(super) const MAX_PACKAGE_PATH_BYTES: usize = 512;
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

impl PackagePermission {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::BrowserControl => "browser_control",
            Self::ExternalActions => "external_actions",
            Self::ExternalMutations => "external_mutations",
            Self::LocalFiles => "local_files",
            Self::NetworkAccess => "network_access",
            Self::ProcessExecution => "process_execution",
        }
    }
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
    /// Product-facing prompt macros shown behind the `$` Composer trigger.
    ///
    /// These are deliberately text semantics, not filesystem-backed Grok Skill
    /// paths. The signed Package declares the exact model-facing prompt and the
    /// Desktop never needs access to `SKILL.md` locations.
    #[serde(default)]
    pub user_facing: Vec<UserFacingSkill>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserFacingSkill {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub prompt_token: String,
    pub prompt_text: String,
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

impl SkillHost {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::Openclaw => "openclaw",
        }
    }
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

    pub(crate) fn parse_document(document: &str) -> Result<AgentPackageManifest> {
        let manifest: AgentPackageManifest =
            toml::from_str(document).context("parse Agent Package Manifest")?;
        validate_manifest(&manifest)?;
        Ok(manifest)
    }

    fn from_documents(documents: &[&str]) -> Result<Self> {
        let mut packages = Vec::with_capacity(documents.len());
        for document in documents {
            packages.push(Self::parse_document(document)?);
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

    pub(crate) fn with_installed_active(
        installed_active: Vec<AgentPackageManifest>,
    ) -> Result<Self> {
        let mut catalog = Self::builtin()?;
        if installed_active.is_empty() {
            return Ok(catalog);
        }

        for installed in installed_active {
            validate_manifest(&installed)?;
            if let Some(index) = catalog
                .packages
                .iter()
                .position(|package| package.package_id == installed.package_id)
            {
                let builtin = &catalog.packages[index];
                if builtin.agent.agent_id != installed.agent.agent_id {
                    bail!(
                        "installed Agent Package cannot change the built-in packageId to another agentId"
                    );
                }
                let builtin_version = Version::parse(&builtin.version)?;
                let installed_version = Version::parse(&installed.version)?;
                match installed_version.cmp_precedence(&builtin_version) {
                    std::cmp::Ordering::Less => {
                        bail!("installed Agent Package cannot downgrade a built-in Package");
                    }
                    std::cmp::Ordering::Equal if installed_version != builtin_version => {
                        bail!(
                            "installed Agent Package cannot replace a built-in Package with equal SemVer precedence"
                        );
                    }
                    _ => {}
                }
                catalog.packages[index] = installed;
                continue;
            }
            if catalog
                .packages
                .iter()
                .any(|package| package.agent.agent_id == installed.agent.agent_id)
            {
                bail!("installed Agent Package agentId conflicts with another Package");
            }
            catalog.packages.push(installed);
        }

        validate_catalog(&catalog.packages)?;
        catalog
            .packages
            .sort_by_key(|package| package.agent.sort_order);
        catalog.catalog_revision = calculate_catalog_revision(&catalog.packages);
        Ok(catalog)
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
    validate_package_id_input(&manifest.package_id)?;
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
    if manifest.skills.user_facing.len() > MAX_USER_SKILLS {
        bail!("Agent Package has too many user-facing Skills");
    }
    let mut skill_ids = HashSet::new();
    let mut prompt_tokens = HashSet::new();
    for skill in &manifest.skills.user_facing {
        validate_identifier("skills.userFacing.id", &skill.id, false)?;
        validate_user_skill_text(
            "skills.userFacing.displayName",
            &skill.display_name,
            MAX_USER_SKILL_DISPLAY_CHARS,
        )?;
        validate_user_skill_text(
            "skills.userFacing.description",
            &skill.description,
            MAX_USER_SKILL_DESCRIPTION_CHARS,
        )?;
        validate_user_skill_text(
            "skills.userFacing.promptText",
            &skill.prompt_text,
            MAX_USER_SKILL_PROMPT_CHARS,
        )?;
        if skill.prompt_token != format!("${}", skill.id) {
            bail!("Agent Package user-facing Skill promptToken must equal '$' plus its id");
        }
        if !skill_ids.insert(skill.id.as_str())
            || !prompt_tokens.insert(skill.prompt_token.as_str())
        {
            bail!("Agent Package user-facing Skills must have unique ids and prompt tokens");
        }
    }
    Ok(())
}

fn validate_user_skill_text(field: &str, value: &str, max_chars: usize) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed != value
        || value.chars().count() > max_chars
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        bail!("Agent Package {field} is invalid");
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

fn calculate_catalog_revision(packages: &[AgentPackageManifest]) -> u64 {
    let mut digest = Sha256::new();
    digest.update(b"agentmesh360-agent-package-catalog-v1\n");
    for package in packages {
        digest.update(package.package_id.as_bytes());
        digest.update(b"\0");
        digest.update(package.version.as_bytes());
        digest.update(b"\0");
        digest.update(package.agent.agent_id.as_bytes());
        digest.update(b"\n");
    }
    let bytes: [u8; 8] = digest.finalize()[..8]
        .try_into()
        .expect("SHA-256 prefix is eight bytes");
    (u64::from_be_bytes(bytes) & MAX_SAFE_JSON_INTEGER).max(1)
}

pub(super) fn validate_identifier(field: &str, value: &str, allow_period: bool) -> Result<()> {
    let valid = !value.is_empty()
        && value.len() <= MAX_PACKAGE_IDENTIFIER_BYTES
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

pub(crate) fn validate_package_id_input(value: &str) -> Result<()> {
    validate_identifier("packageId", value, true)
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

pub(super) fn validate_relative_package_path(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > MAX_PACKAGE_PATH_BYTES {
        bail!("Agent Package {field} size is invalid");
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
                    package.skills.adapters.len(),
                    package.skills.user_facing.len(),
                ))
                .collect::<Vec<_>>(),
            vec![
                ("job-agent", "0.4.8", 2, 2),
                ("lecturecast-agent", "0.4.0", 3, 2),
                ("deploy-agent", "0.1.1", 0, 2),
            ]
        );
    }

    #[test]
    fn job_agent_runtime_prompt_owns_state_driven_onboarding() {
        let catalog = AgentPackageCatalog::builtin().expect("built-in packages");
        let job = catalog.package_for_agent("job-agent").expect("Job Agent");
        let prompt = job.runtime.prompt_body.as_str();

        for required in [
            "not a general chat assistant",
            "<resolved-jobagent> --version",
            "$HOME/.local/bin/jobagent",
            "/opt/homebrew/bin/jobagent",
            "/usr/local/bin/jobagent",
            "<resolved-jobagent> doctor env",
            "environment_healthy",
            "workflow.ready",
            "next_suggested",
            "https://agentmesh360.com/app/",
            "jobagent init --key <job-agent-key>",
            "PDF, DOCX, TXT, or Markdown",
            "jobagent resume analyze --file <resume-path>",
            "jobagent round start",
            "Boss直聘 -> 猎聘 -> 智联招聘 -> 51Job",
            "paid_pass_required=true",
            "Do not answer a first greeting with a generic capability menu",
        ] {
            assert!(
                prompt.contains(required),
                "missing Job Agent contract: {required}"
            );
        }
        assert!(
            prompt.contains("never ask the user to paste")
                && prompt.contains("it into ordinary chat history"),
            "Job Agent must not collect its service Key in ordinary conversation history"
        );

        for other_agent_id in ["lecturecast-agent", "deploy-agent"] {
            let other = catalog
                .package_for_agent(other_agent_id)
                .expect("other product Agent");
            assert!(
                !other
                    .runtime
                    .prompt_body
                    .contains("<resolved-jobagent> doctor env")
            );
            assert!(!other.runtime.prompt_body.contains("resume analyze"));
        }
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
    fn overlong_package_publisher_and_agent_identifiers_fail_closed() {
        for (field, replacement) in [
            (
                "packageId = \"com.agentmesh360.job-agent\"",
                format!("packageId = \"{}\"", "a".repeat(129)),
            ),
            (
                "publisher = \"agentmesh360\"",
                format!("publisher = \"{}\"", "a".repeat(129)),
            ),
            (
                "agentId = \"job-agent\"",
                format!("agentId = \"{}\"", "a".repeat(129)),
            ),
        ] {
            let document = JOB_DOCUMENT.replacen(field, &replacement, 1);
            assert!(
                AgentPackageCatalog::from_documents(&[&document]).is_err(),
                "{field} must reject overlong values"
            );
        }
    }

    #[test]
    fn unknown_permissions_and_unsafe_adapter_paths_fail_closed() {
        let unknown_permission = JOB_DOCUMENT.replacen("browser_control", "unrestricted_root", 1);
        assert!(AgentPackageCatalog::from_documents(&[&unknown_permission]).is_err());

        let traversal =
            JOB_DOCUMENT.replacen("skills/claude-code/SKILL.md", "../outside/SKILL.md", 1);
        assert!(AgentPackageCatalog::from_documents(&[&traversal]).is_err());

        let overlong = JOB_DOCUMENT.replacen(
            "skills/claude-code/SKILL.md",
            &format!("{}.md", "a".repeat(MAX_PACKAGE_PATH_BYTES)),
            1,
        );
        assert!(AgentPackageCatalog::from_documents(&[&overlong]).is_err());
    }

    #[test]
    fn duplicate_package_or_agent_identity_fails_closed() {
        assert!(AgentPackageCatalog::from_documents(&[JOB_DOCUMENT, JOB_DOCUMENT]).is_err());
    }

    #[test]
    fn user_facing_skill_schema_rejects_duplicates_tokens_and_malicious_fields() {
        let duplicate = JOB_DOCUMENT.replacen("id = \"job-search\"", "id = \"career-profile\"", 1);
        assert!(AgentPackageCatalog::parse_document(&duplicate).is_err());

        let wrong_token = JOB_DOCUMENT.replacen(
            "promptToken = \"$career-profile\"",
            "promptToken = \"/always-approve on\"",
            1,
        );
        assert!(AgentPackageCatalog::parse_document(&wrong_token).is_err());

        let unknown = JOB_DOCUMENT.replacen(
            "promptText = \"请帮我建立或更新求职档案。",
            "privatePath = \"/private/skills/SKILL.md\"\npromptText = \"请帮我建立或更新求职档案。",
            1,
        );
        assert!(AgentPackageCatalog::parse_document(&unknown).is_err());

        let control = JOB_DOCUMENT.replacen(
            "displayName = \"建立求职档案\"",
            "displayName = \"建立\\u0000求职档案\"",
            1,
        );
        assert!(AgentPackageCatalog::parse_document(&control).is_err());
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

    #[test]
    fn installed_active_upgrades_builtin_and_appends_new_agent_deterministically() {
        let upgraded = AgentPackageCatalog::parse_document(&JOB_DOCUMENT.replacen(
            "version = \"0.4.8\"",
            "version = \"0.4.9\"",
            1,
        ))
        .expect("upgraded built-in");
        let new_agent_document = JOB_DOCUMENT
            .replacen(
                "packageId = \"com.agentmesh360.job-agent\"",
                "packageId = \"com.agentmesh360.research-agent\"",
                1,
            )
            .replacen("version = \"0.4.8\"", "version = \"0.1.0\"", 1)
            .replacen("agentId = \"job-agent\"", "agentId = \"research-agent\"", 1)
            .replacen(
                "displayName = \"Job Agent\"",
                "displayName = \"Research Agent\"",
                1,
            )
            .replacen("sortOrder = 10", "sortOrder = 40", 1);
        let new_agent =
            AgentPackageCatalog::parse_document(&new_agent_document).expect("new Agent");

        let catalog =
            AgentPackageCatalog::with_installed_active(vec![new_agent, upgraded]).expect("merge");

        assert_eq!(catalog.packages.len(), 4);
        assert_eq!(
            catalog
                .package_for_agent("job-agent")
                .expect("upgraded Job Agent")
                .version,
            "0.4.9"
        );
        assert_eq!(
            catalog
                .packages
                .iter()
                .map(|package| package.agent.agent_id.as_str())
                .collect::<Vec<_>>(),
            [
                "job-agent",
                "lecturecast-agent",
                "deploy-agent",
                "research-agent"
            ]
        );
        assert_ne!(catalog.catalog_revision, BUILTIN_CATALOG_REVISION);
        assert!(catalog.catalog_revision <= MAX_SAFE_JSON_INTEGER);
        assert!(
            serde_json::to_value(&catalog)
                .expect("serialize dynamic catalog")
                .get("catalogRevision")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|revision| revision <= MAX_SAFE_JSON_INTEGER)
        );
    }

    #[test]
    fn installed_active_cannot_hijack_or_downgrade_builtin_identity() {
        let hijack = JOB_DOCUMENT.replacen(
            "packageId = \"com.agentmesh360.job-agent\"",
            "packageId = \"com.example.job-agent\"",
            1,
        );
        let hijack = AgentPackageCatalog::parse_document(&hijack).expect("hijack manifest");
        assert!(
            AgentPackageCatalog::with_installed_active(vec![hijack])
                .expect_err("agentId hijack")
                .to_string()
                .contains("conflicts")
        );

        for version in ["0.4.7", "0.4.8+replacement"] {
            let replacement = JOB_DOCUMENT.replacen(
                "version = \"0.4.8\"",
                &format!("version = \"{version}\""),
                1,
            );
            let replacement =
                AgentPackageCatalog::parse_document(&replacement).expect("replacement");
            assert!(
                AgentPackageCatalog::with_installed_active(vec![replacement]).is_err(),
                "version {version} must not replace the built-in Package"
            );
        }
    }
}
