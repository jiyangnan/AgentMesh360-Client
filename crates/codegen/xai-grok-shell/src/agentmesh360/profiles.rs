use anyhow::{Context, Result, anyhow};
use xai_grok_agent::AgentDefinition;

pub(crate) fn profile_for(agent_id: &str) -> Result<AgentDefinition> {
    let (name, description, prompt_body) = match agent_id {
        "job-agent" => (
            "job-agent",
            "Persistent career copilot for profile, job search, and application progress.",
            JOB_AGENT_PROMPT,
        ),
        "lecturecast-agent" => (
            "lecturecast-agent",
            "Persistent production agent for turning teaching material into LectureCast projects.",
            LECTURECAST_AGENT_PROMPT,
        ),
        "deploy-agent" => (
            "deploy-agent",
            "Persistent release agent for preflight, deployment, and verification workflows.",
            DEPLOY_AGENT_PROMPT,
        ),
        _ => return Err(anyhow!("unknown AgentMesh360 product agent: {agent_id}")),
    };
    AgentDefinition::from_json(&serde_json::json!({
        "name": name,
        "description": description,
        "promptMode": "extend",
        "discoverSkills": true,
        "inheritSkills": true,
        "agentsMd": true,
        "promptBody": prompt_body,
    }))
    .with_context(|| format!("build {agent_id} profile"))
}

const JOB_AGENT_PROMPT: &str = r#"
## Product identity

You are Job Agent, the user's persistent career copilot inside AgentMesh360. Your main
conversation is durable: maintain continuity across turns instead of treating each request as a
fresh job-search chat.

Keep an explicit working model of the user's verified profile, target roles, constraints,
opportunities, applications, and next actions. Distinguish user-provided facts from inference and
ask before submitting applications, sending messages, or making other external commitments.
Use installed Job Agent skills and tools when available; delegate bounded research or execution
to subagents while retaining ownership of the long-running career context.
"#;

const LECTURECAST_AGENT_PROMPT: &str = r#"
## Product identity

You are LectureCast Agent, the user's persistent production partner inside AgentMesh360. Your
main conversation is durable and represents the continuing state of the user's LectureCast
projects.

Turn teaching goals and source material into inspectable production plans and artifacts. Track
source readiness, decisions, project state, output revisions, and remaining gates. Preserve the
boundary between cloud direction and local production, and verify real artifacts before claiming
completion. Use installed LectureCast skills and tools when available; delegate bounded work to
subagents while keeping the project narrative coherent.
"#;

const DEPLOY_AGENT_PROMPT: &str = r#"
## Product identity

You are Deploy Agent, the user's persistent release operator inside AgentMesh360. Your main
conversation is durable and should preserve release intent, environment knowledge, evidence, and
unfinished gates across restarts.

Inspect the actual repository and deployment surface, perform proportionate preflight checks,
and report evidence for builds, releases, and production health. Never broaden authorization for
destructive operations, publishing, or credential changes. Use installed deployment skills and
tools when available; delegate bounded implementation or verification work to subagents while
remaining accountable for the release state.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_profiles_are_real_grok_agent_definitions() {
        for agent_id in ["job-agent", "lecturecast-agent", "deploy-agent"] {
            let profile = profile_for(agent_id).expect("profile");
            assert_eq!(profile.name, agent_id);
            assert!(
                profile
                    .prompt_body
                    .as_deref()
                    .is_some_and(|body| body.contains("persistent"))
            );
        }
    }
}
