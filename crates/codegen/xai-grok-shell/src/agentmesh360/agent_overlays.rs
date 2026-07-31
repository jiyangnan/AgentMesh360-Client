use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use xai_grok_agent::AgentDefinition;

use super::registry::AgentRegistry;

pub const AGENT_CUSTOMIZATION_GET_METHOD: &str = "x.agentmesh360/agents/customization/get";
pub const AGENT_CUSTOMIZATION_UPSERT_METHOD: &str = "x.agentmesh360/agents/customization/upsert";
pub const AGENT_CUSTOMIZATION_CLEAR_METHOD: &str = "x.agentmesh360/agents/customization/clear";

const MAX_OVERLAY_CHARACTERS: usize = 8_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentOverlayKind {
    AgentMd,
    UserMd,
}

impl AgentOverlayKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AgentMd => "agent_md",
            Self::UserMd => "user_md",
        }
    }

    fn heading(self) -> &'static str {
        match self {
            Self::AgentMd => "User-defined behavior overlay (agent.md)",
            Self::UserMd => "User preferences for this Agent (user.md)",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentOverlayRecord {
    pub kind: AgentOverlayKind,
    pub content: String,
    pub revision: u64,
    pub customized: bool,
    pub updated_at: Option<String>,
}

impl AgentOverlayRecord {
    fn empty(kind: AgentOverlayKind) -> Self {
        Self {
            kind,
            content: String::new(),
            revision: 0,
            customized: false,
            updated_at: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCustomizationSnapshot {
    pub agent_id: String,
    pub package_name: String,
    pub package_version: String,
    pub package_description: String,
    pub agent_md: AgentOverlayRecord,
    pub user_md: AgentOverlayRecord,
}

#[derive(Clone, Debug)]
pub struct AgentOverlayStore {
    state_home: PathBuf,
}

impl AgentOverlayStore {
    pub fn in_home(state_home: impl Into<PathBuf>) -> Self {
        Self {
            state_home: state_home.into(),
        }
    }

    pub fn snapshot(
        &self,
        registry: &AgentRegistry,
        owner_account_id: i64,
        agent_id: &str,
    ) -> Result<AgentCustomizationSnapshot> {
        let agent = registry.get(owner_account_id, agent_id)?;
        Ok(AgentCustomizationSnapshot {
            agent_id: agent.agent_id,
            package_name: agent.display_name,
            package_version: agent.version,
            package_description: agent.description,
            agent_md: self.get(owner_account_id, agent_id, AgentOverlayKind::AgentMd)?,
            user_md: self.get(owner_account_id, agent_id, AgentOverlayKind::UserMd)?,
        })
    }

    pub fn get(
        &self,
        owner_account_id: i64,
        agent_id: &str,
        kind: AgentOverlayKind,
    ) -> Result<AgentOverlayRecord> {
        validate_identity(owner_account_id, agent_id)?;
        let conn = super::state::open(&self.state_home)?;
        conn.query_row(
            "SELECT content, revision, updated_at FROM agent_overlays \
             WHERE owner_account_id = ?1 AND agent_id = ?2 AND overlay_kind = ?3",
            params![owner_account_id, agent_id, kind.as_str()],
            |row| {
                let content: String = row.get(0)?;
                Ok(AgentOverlayRecord {
                    kind,
                    customized: !content.is_empty(),
                    content,
                    revision: row.get(1)?,
                    updated_at: Some(row.get(2)?),
                })
            },
        )
        .optional()?
        .map_or_else(|| Ok(AgentOverlayRecord::empty(kind)), Ok)
    }

    pub fn upsert(
        &self,
        registry: &AgentRegistry,
        owner_account_id: i64,
        agent_id: &str,
        kind: AgentOverlayKind,
        content: &str,
        expected_revision: u64,
    ) -> Result<AgentOverlayRecord> {
        validate_identity(owner_account_id, agent_id)?;
        registry.get(owner_account_id, agent_id)?;
        let content = normalize_content(content)?;
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction()?;
        let current_revision = transaction
            .query_row(
                "SELECT revision FROM agent_overlays \
                 WHERE owner_account_id = ?1 AND agent_id = ?2 AND overlay_kind = ?3",
                params![owner_account_id, agent_id, kind.as_str()],
                |row| row.get::<_, u64>(0),
            )
            .optional()?
            .unwrap_or(0);
        if current_revision != expected_revision {
            bail!("agent customization revision conflict; reload before saving");
        }
        let revision = current_revision.saturating_add(1);
        let updated_at = now();
        transaction.execute(
            "INSERT INTO agent_overlays (
               owner_account_id, agent_id, overlay_kind, content, revision, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(owner_account_id, agent_id, overlay_kind) DO UPDATE SET
               content = excluded.content,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![
                owner_account_id,
                agent_id,
                kind.as_str(),
                content,
                revision,
                updated_at
            ],
        )?;
        transaction.commit()?;
        Ok(AgentOverlayRecord {
            kind,
            customized: !content.is_empty(),
            content,
            revision,
            updated_at: Some(updated_at),
        })
    }

    pub fn clear(
        &self,
        registry: &AgentRegistry,
        owner_account_id: i64,
        agent_id: &str,
        kind: AgentOverlayKind,
        expected_revision: u64,
    ) -> Result<AgentOverlayRecord> {
        self.upsert(
            registry,
            owner_account_id,
            agent_id,
            kind,
            "",
            expected_revision,
        )
    }

    pub fn apply_to_definition(
        &self,
        owner_account_id: i64,
        agent_id: &str,
        mut definition: AgentDefinition,
    ) -> Result<(AgentDefinition, (u64, u64))> {
        let agent_md = self.get(owner_account_id, agent_id, AgentOverlayKind::AgentMd)?;
        let user_md = self.get(owner_account_id, agent_id, AgentOverlayKind::UserMd)?;
        let mut prompt = definition.prompt_body.take().unwrap_or_default();
        for overlay in [&agent_md, &user_md] {
            if !overlay.content.is_empty() {
                prompt.push_str("\n\n## ");
                prompt.push_str(overlay.kind.heading());
                prompt.push('\n');
                prompt.push_str(&overlay.content);
            }
        }
        definition.prompt_body = (!prompt.is_empty()).then_some(prompt);
        Ok((definition, (agent_md.revision, user_md.revision)))
    }
}

fn normalize_content(value: &str) -> Result<String> {
    let value = value.replace("\r\n", "\n");
    if value.chars().count() > MAX_OVERLAY_CHARACTERS {
        bail!("agent customization exceeds 8000 characters");
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        bail!("agent customization contains unsupported control characters");
    }
    if contains_obvious_secret(&value) {
        bail!("agent customization appears to contain a secret; remove credentials before saving");
    }
    Ok(value.trim().to_owned())
}

fn contains_obvious_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("-----begin private key-----")
        || lower.contains("-----begin rsa private key-----")
        || lower.contains("-----begin ec private key-----")
        || lower.contains("authorization: bearer ")
    {
        return true;
    }
    value.split_whitespace().any(|token| {
        let token = token.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']'
            )
        });
        let token = token.to_ascii_lowercase();
        token.len() >= 20
            && (token.starts_with("sk-")
                || token.starts_with("xai-")
                || token.starts_with("aiza")
                || token.starts_with("ghp_")
                || token.starts_with("github_pat_"))
    })
}

fn validate_identity(owner_account_id: i64, agent_id: &str) -> Result<()> {
    if owner_account_id <= 0 {
        bail!("owner account id must be positive");
    }
    if agent_id.len() < 3
        || agent_id.len() > 100
        || !agent_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(anyhow!("agent id is invalid"));
    }
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_obvious_secrets_without_echoing_them() {
        let secret = "sk-this-is-a-long-test-secret-value";
        let error = normalize_content(&format!("Use {secret} for requests")).expect_err("secret");
        assert!(error.to_string().contains("appears to contain a secret"));
        assert!(!error.to_string().contains(secret));
        assert!(normalize_content("Use SK-THIS-IS-AN-UPPERCASE-TEST-SECRET").is_err());
    }

    #[test]
    fn enforces_unicode_character_limit() {
        assert!(normalize_content(&"好".repeat(8_000)).is_ok());
        assert!(normalize_content(&"好".repeat(8_001)).is_err());
    }

    #[test]
    fn preserves_markdown_but_normalizes_line_endings() {
        assert_eq!(
            normalize_content("  # Style\r\n\r\n- concise  ").expect("content"),
            "# Style\n\n- concise"
        );
    }

    #[test]
    fn overlays_are_account_scoped_revisioned_and_applied_after_the_package_prompt() {
        let temp = tempfile::tempdir().expect("tempdir");
        let registry = AgentRegistry::in_home(temp.path());
        registry
            .claim_legacy_and_seed(41)
            .expect("seed first account");
        registry
            .claim_legacy_and_seed(42)
            .expect("seed second account");
        let store = AgentOverlayStore::in_home(temp.path());

        let behavior = store
            .upsert(
                &registry,
                41,
                "job-agent",
                AgentOverlayKind::AgentMd,
                "先规划，再执行。",
                0,
            )
            .expect("save behavior");
        assert_eq!(behavior.revision, 1);
        assert!(behavior.customized);
        assert_eq!(
            store
                .get(42, "job-agent", AgentOverlayKind::AgentMd)
                .expect("other account overlay"),
            AgentOverlayRecord::empty(AgentOverlayKind::AgentMd)
        );

        let conflict = store
            .upsert(
                &registry,
                41,
                "job-agent",
                AgentOverlayKind::AgentMd,
                "并发覆盖",
                0,
            )
            .expect_err("stale revision must fail");
        assert!(conflict.to_string().contains("revision conflict"));

        let mut definition = AgentDefinition::default_grok_build();
        definition.prompt_body = Some("Package base prompt".into());
        let (applied, revisions) = store
            .apply_to_definition(41, "job-agent", definition)
            .expect("apply overlay");
        let prompt = applied.prompt_body.expect("combined prompt");
        assert!(prompt.starts_with("Package base prompt"));
        assert!(prompt.contains("User-defined behavior overlay (agent.md)"));
        assert!(prompt.ends_with("先规划，再执行。"));
        assert_eq!(revisions, (1, 0));

        let cleared = store
            .clear(&registry, 41, "job-agent", AgentOverlayKind::AgentMd, 1)
            .expect("clear behavior");
        assert_eq!(cleared.revision, 2);
        assert!(!cleared.customized);
    }
}
