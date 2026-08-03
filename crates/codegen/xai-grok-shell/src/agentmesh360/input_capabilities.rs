use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent::MvpAgent;

use super::agent_packages::{AgentPackageCatalog, AgentPackageManifest};
use super::package_installer::PackageInstallService;

pub(crate) const GET_METHOD: &str = "x.agentmesh360/agents/input-capabilities/get";
const SCHEMA_VERSION: u32 = 1;
const MAX_SAFE_JSON_INTEGER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputCapabilitiesRequest {
    pub agent_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputCapabilitiesResponse {
    pub schema_version: u32,
    pub revision: u64,
    pub agent_id: String,
    pub commands: Vec<PublicInputCommand>,
    pub skills: Vec<PublicInputSkill>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicInputCommand {
    pub id: &'static str,
    pub trigger: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicInputSkill {
    pub id: String,
    pub trigger: String,
    pub display_name: String,
    pub description: String,
    pub prompt_text: String,
}

/// Explicit product allowlist. It intentionally excludes permission bypass,
/// goal automation, plugin/hook mutation, reload, feedback, scheduling, and
/// developer commands even when Grok advertises them through its generic
/// `x.ai/commands/list` endpoint.
const SAFE_COMMANDS: [PublicInputCommand; 3] = [
    PublicInputCommand {
        id: "compact",
        trigger: "/compact",
        display_name: "压缩当前对话",
        description: "压缩较早的对话内容，同时保留当前任务需要的上下文。",
        argument_hint: Some("可选：说明必须保留的内容"),
    },
    PublicInputCommand {
        id: "context",
        trigger: "/context",
        display_name: "查看上下文用量",
        description: "查看当前会话的上下文窗口与用量信息。",
        argument_hint: None,
    },
    PublicInputCommand {
        id: "session-info",
        trigger: "/session-info",
        display_name: "查看会话状态",
        description: "查看当前会话的模型、轮次和上下文概况。",
        argument_hint: None,
    },
];

pub(crate) fn get(
    agent: &MvpAgent,
    owner_account_id: i64,
    request: &InputCapabilitiesRequest,
) -> Result<InputCapabilitiesResponse> {
    let registry = agent.agentmesh360.registry();
    let record = registry.get(owner_account_id, &request.agent_id)?;
    if record.desired_state != "running"
        || record.main_session_id.as_deref() != Some(request.session_id.as_str())
    {
        bail!("Agent input capabilities require its active main session");
    }

    let catalog = registry
        .package_catalog()
        .map_err(|_| anyhow!("Agent Package Catalog is unavailable"))?;
    let package = catalog.package_for_agent(&request.agent_id)?;
    if !package_is_currently_trusted(agent, package)? {
        bail!("Agent Package is not currently trusted");
    }

    let commands = SAFE_COMMANDS.to_vec();
    let skills = package
        .skills
        .user_facing
        .iter()
        .map(|skill| PublicInputSkill {
            id: skill.id.clone(),
            trigger: skill.prompt_token.clone(),
            display_name: skill.display_name.clone(),
            description: skill.description.clone(),
            prompt_text: skill.prompt_text.clone(),
        })
        .collect::<Vec<_>>();
    let revision = calculate_revision(catalog.catalog_revision, package, &commands);
    Ok(InputCapabilitiesResponse {
        schema_version: SCHEMA_VERSION,
        revision,
        agent_id: request.agent_id.clone(),
        commands,
        skills,
    })
}

fn package_is_currently_trusted(agent: &MvpAgent, package: &AgentPackageManifest) -> Result<bool> {
    let builtin = AgentPackageCatalog::builtin()?
        .packages
        .into_iter()
        .find(|candidate| candidate.package_id == package.package_id);
    if builtin.as_ref() == Some(package) {
        // First-party manifests compiled into this application are covered by
        // the application's own distribution signature and immutable binary.
        return Ok(true);
    }

    let installer = PackageInstallService::in_home(&agent.agentmesh360.state_home);
    let Some(installed) = installer.get(&package.package_id)? else {
        return Ok(false);
    };
    if installed.agent_id != package.agent.agent_id
        || installed.active.version != package.version
        || installed.active.requested_permissions != package.requested_permissions
    {
        return Ok(false);
    }
    Ok(agent
        .agentmesh360
        .package_registry_fetcher
        .verifies_installed_signature(
            &package.package_id,
            &package.agent.agent_id,
            &package.version,
            &package.publisher,
            &installed.active.signature_key_id,
            &agent.agentmesh360.access,
        ))
}

fn calculate_revision(
    catalog_revision: u64,
    package: &AgentPackageManifest,
    commands: &[PublicInputCommand],
) -> u64 {
    let mut digest = Sha256::new();
    digest.update(b"agentmesh360-input-capabilities-v1\n");
    digest.update(catalog_revision.to_be_bytes());
    digest.update(package.package_id.as_bytes());
    digest.update(b"\0");
    digest.update(package.version.as_bytes());
    digest.update(b"\0");
    digest.update(package.agent.agent_id.as_bytes());
    digest.update(b"\n");
    for command in commands {
        digest.update(command.id.as_bytes());
        digest.update(b"\0");
        digest.update(command.trigger.as_bytes());
        digest.update(b"\n");
    }
    for skill in &package.skills.user_facing {
        digest.update(skill.id.as_bytes());
        digest.update(b"\0");
        digest.update(skill.prompt_token.as_bytes());
        digest.update(b"\0");
        digest.update(skill.prompt_text.as_bytes());
        digest.update(b"\n");
    }
    let bytes: [u8; 8] = digest.finalize()[..8]
        .try_into()
        .expect("SHA-256 prefix is eight bytes");
    (u64::from_be_bytes(bytes) & MAX_SAFE_JSON_INTEGER).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_command_allowlist_has_no_dangerous_grok_commands() {
        assert_eq!(
            SAFE_COMMANDS
                .iter()
                .map(|command| command.trigger)
                .collect::<Vec<_>>(),
            ["/compact", "/context", "/session-info"]
        );
        let serialized = serde_json::to_string(&SAFE_COMMANDS).expect("commands serialize");
        for forbidden in [
            "always-approve",
            "yolo",
            "plugins",
            "hooks",
            "reload",
            "goal",
            "loop",
            "developer",
        ] {
            assert!(!serialized.contains(forbidden), "found {forbidden}");
        }
    }

    #[test]
    fn revision_is_public_safe_and_changes_between_agent_packages() {
        let catalog = AgentPackageCatalog::builtin().expect("catalog");
        let job = catalog.package_for_agent("job-agent").expect("Job Package");
        let deploy = catalog
            .package_for_agent("deploy-agent")
            .expect("Deploy Package");
        let job_revision = calculate_revision(catalog.catalog_revision, job, &SAFE_COMMANDS);
        let deploy_revision = calculate_revision(catalog.catalog_revision, deploy, &SAFE_COMMANDS);
        assert!((1..=MAX_SAFE_JSON_INTEGER).contains(&job_revision));
        assert!((1..=MAX_SAFE_JSON_INTEGER).contains(&deploy_revision));
        assert_ne!(job_revision, deploy_revision);
    }
}
