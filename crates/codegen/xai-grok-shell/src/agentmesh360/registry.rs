use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
struct BuiltinAgentSpec {
    agent_id: &'static str,
    display_name: &'static str,
    description: &'static str,
    version: &'static str,
    sort_order: i64,
}

const BUILTIN_AGENTS: [BuiltinAgentSpec; 3] = [
    BuiltinAgentSpec {
        agent_id: "job-agent",
        display_name: "Job Agent",
        description: "Persistent career copilot for profile, job search, and application progress.",
        version: "0.1.0",
        sort_order: 10,
    },
    BuiltinAgentSpec {
        agent_id: "lecturecast-agent",
        display_name: "LectureCast Agent",
        description: "Persistent production agent for turning teaching material into LectureCast projects.",
        version: "0.1.0",
        sort_order: 20,
    },
    BuiltinAgentSpec {
        agent_id: "deploy-agent",
        display_name: "Deploy Agent",
        description: "Persistent release agent for preflight, deployment, and verification workflows.",
        version: "0.1.0",
        sort_order: 30,
    },
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProductAgentRecord {
    #[serde(skip_serializing)]
    pub owner_account_id: i64,
    pub agent_id: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub desired_state: String,
    pub runtime_state: String,
    pub main_session_id: Option<String>,
    pub workspace_dir: Option<String>,
    pub activated_at: Option<String>,
    pub updated_at: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AgentRegistry {
    state_home: PathBuf,
    db_path: PathBuf,
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::in_home(super::state::default_state_home())
    }
}

impl AgentRegistry {
    pub fn in_home(state_home: impl Into<PathBuf>) -> Self {
        let state_home = state_home.into();
        let db_path = state_home.join("state.db");
        Self {
            state_home,
            db_path,
        }
    }

    pub fn claim_legacy_and_seed(&self, owner_account_id: i64) -> Result<()> {
        validate_owner(owner_account_id)?;
        let mut conn = self.open()?;
        let transaction = conn.transaction()?;
        let existing: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM product_agents WHERE owner_account_id = ?1",
            [owner_account_id],
            |row| row.get(0),
        )?;
        if existing == 0 {
            transaction.execute(
                "UPDATE product_agents SET owner_account_id = ?1 \
                 WHERE owner_account_id IS NULL",
                [owner_account_id],
            )?;
        }
        self.seed_builtins(&transaction, owner_account_id)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list(&self, owner_account_id: i64) -> Result<Vec<ProductAgentRecord>> {
        validate_owner(owner_account_id)?;
        let conn = self.open()?;
        self.seed_builtins(&conn, owner_account_id)?;
        let mut stmt = conn.prepare(
            "SELECT owner_account_id, agent_id, display_name, description, version, desired_state, \
             runtime_state, main_session_id, workspace_dir, activated_at, updated_at, \
             last_error FROM product_agents WHERE owner_account_id = ?1 \
             ORDER BY sort_order, agent_id",
        )?;
        let rows = stmt.query_map([owner_account_id], Self::row_to_record)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read AgentMesh360 product agent registry")
    }

    pub fn get(&self, owner_account_id: i64, agent_id: &str) -> Result<ProductAgentRecord> {
        validate_owner(owner_account_id)?;
        let conn = self.open()?;
        self.seed_builtins(&conn, owner_account_id)?;
        conn.query_row(
            "SELECT owner_account_id, agent_id, display_name, description, version, desired_state, \
             runtime_state, main_session_id, workspace_dir, activated_at, updated_at, \
             last_error FROM product_agents WHERE owner_account_id = ?1 AND agent_id = ?2",
            params![owner_account_id, agent_id],
            Self::row_to_record,
        )
        .with_context(|| format!("unknown AgentMesh360 product agent: {agent_id}"))
    }

    pub fn main_session_owner(&self, session_id: &str) -> Result<Option<Option<i64>>> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT owner_account_id FROM product_agents WHERE main_session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn main_session_ids(&self, owner_account_id: i64) -> Result<HashSet<String>> {
        validate_owner(owner_account_id)?;
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT main_session_id FROM product_agents \
             WHERE owner_account_id = ?1 AND main_session_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([owner_account_id], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<HashSet<_>>>()
            .context("read AgentMesh360 protected main sessions")
    }

    pub fn all_main_session_ids(&self) -> Result<HashSet<String>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT main_session_id FROM product_agents WHERE main_session_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<HashSet<_>>>()
            .context("read all AgentMesh360 protected main sessions")
    }

    pub fn prepare_activation(
        &self,
        owner_account_id: i64,
        agent_id: &str,
    ) -> Result<ProductAgentRecord> {
        validate_owner(owner_account_id)?;
        if !BUILTIN_AGENTS.iter().any(|spec| spec.agent_id == agent_id) {
            return Err(anyhow!("unknown AgentMesh360 product agent: {agent_id}"));
        }
        let workspace_dir = self
            .state_home
            .join("workspaces")
            .join(owner_account_id.to_string())
            .join(agent_id);
        std::fs::create_dir_all(&workspace_dir).with_context(|| {
            format!("create product agent workspace {}", workspace_dir.display())
        })?;
        let main_session_id = stable_main_session_id(owner_account_id, agent_id).to_string();
        let now = now();
        let conn = self.open()?;
        self.seed_builtins(&conn, owner_account_id)?;
        let changed = conn.execute(
            "UPDATE product_agents SET desired_state = 'running', runtime_state = 'starting', \
             main_session_id = COALESCE(main_session_id, ?3), \
             workspace_dir = COALESCE(workspace_dir, ?4), \
             activated_at = COALESCE(activated_at, ?5), updated_at = ?5, last_error = NULL \
             WHERE owner_account_id = ?1 AND agent_id = ?2",
            params![
                owner_account_id,
                agent_id,
                main_session_id,
                workspace_dir.to_string_lossy().as_ref(),
                now
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("unknown AgentMesh360 product agent: {agent_id}"));
        }
        self.get(owner_account_id, agent_id)
    }

    pub fn mark_runtime(
        &self,
        owner_account_id: i64,
        agent_id: &str,
        runtime_state: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        let conn = self.open()?;
        let changed = conn.execute(
            "UPDATE product_agents SET runtime_state = ?3, updated_at = ?4, last_error = ?5 \
             WHERE owner_account_id = ?1 AND agent_id = ?2",
            params![owner_account_id, agent_id, runtime_state, now(), last_error],
        )?;
        if changed != 1 {
            return Err(anyhow!("unknown AgentMesh360 product agent: {agent_id}"));
        }
        Ok(())
    }

    fn open(&self) -> Result<Connection> {
        let conn = super::state::open(&self.state_home)
            .with_context(|| format!("open AgentMesh360 registry {}", self.db_path.display()))?;
        Ok(conn)
    }

    fn seed_builtins(&self, conn: &Connection, owner_account_id: i64) -> Result<()> {
        let now = now();
        for spec in BUILTIN_AGENTS {
            conn.execute(
                "INSERT INTO product_agents (owner_account_id, agent_id, display_name, description, version, \
                 sort_order, desired_state, runtime_state, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'inactive', 'available', ?7) \
                 ON CONFLICT(owner_account_id, agent_id) DO UPDATE SET \
                 display_name = excluded.display_name, \
                 description = excluded.description, version = excluded.version, \
                 sort_order = excluded.sort_order",
                params![
                    owner_account_id,
                    spec.agent_id,
                    spec.display_name,
                    spec.description,
                    spec.version,
                    spec.sort_order,
                    now
                ],
            )?;
        }
        Ok(())
    }

    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProductAgentRecord> {
        Ok(ProductAgentRecord {
            owner_account_id: row.get(0)?,
            agent_id: row.get(1)?,
            display_name: row.get(2)?,
            description: row.get(3)?,
            version: row.get(4)?,
            desired_state: row.get(5)?,
            runtime_state: row.get(6)?,
            main_session_id: row.get(7)?,
            workspace_dir: row.get(8)?,
            activated_at: row.get(9)?,
            updated_at: row.get(10)?,
            last_error: row.get(11)?,
        })
    }
}

pub fn stable_main_session_id(owner_account_id: i64, agent_id: &str) -> Uuid {
    let identity = format!(
        "https://agentmesh360.com/accounts/{owner_account_id}/product-agents/{agent_id}/main"
    );
    Uuid::new_v5(&Uuid::NAMESPACE_URL, identity.as_bytes())
}

fn validate_owner(owner_account_id: i64) -> Result<()> {
    if owner_account_id <= 0 {
        return Err(anyhow!("AgentMesh360 account id is invalid"));
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
    fn seeds_the_first_party_catalog_in_product_order() {
        let temp = tempfile::tempdir().expect("tempdir");
        let registry = AgentRegistry::in_home(temp.path());

        let records = registry.list(41).expect("list catalog");

        assert_eq!(records.len(), 3);
        assert_eq!(records[0].agent_id, "job-agent");
        assert_eq!(records[1].agent_id, "lecturecast-agent");
        assert_eq!(records[2].agent_id, "deploy-agent");
        assert!(records.iter().all(|record| record.owner_account_id == 41));
        assert!(
            records
                .iter()
                .all(|record| record.desired_state == "inactive")
        );
    }

    #[test]
    fn activation_is_idempotent_across_registry_reopen() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first = AgentRegistry::in_home(temp.path());
        let expected_session_id = stable_main_session_id(41, "job-agent").to_string();
        assert!(
            first
                .main_session_owner(&expected_session_id)
                .expect("inactive lookup")
                .is_none()
        );
        let activated = first.prepare_activation(41, "job-agent").expect("activate");

        assert_eq!(
            activated.main_session_id.as_deref(),
            Some(expected_session_id.as_str())
        );
        assert_eq!(activated.desired_state, "running");
        assert_eq!(
            first
                .main_session_owner(&expected_session_id)
                .expect("activated main session is protected"),
            Some(Some(41))
        );
        assert_eq!(
            first.main_session_ids(41).expect("protected sessions"),
            HashSet::from([expected_session_id.clone()])
        );

        let reopened = AgentRegistry::in_home(temp.path());
        let activated_again = reopened
            .prepare_activation(41, "job-agent")
            .expect("reactivate");
        assert_eq!(activated_again.main_session_id, activated.main_session_id);
        assert_eq!(activated_again.workspace_dir, activated.workspace_dir);
        assert_eq!(activated_again.activated_at, activated.activated_at);
        assert_eq!(
            reopened
                .main_session_owner(&expected_session_id)
                .expect("reopened registry protects the same main session"),
            Some(Some(41))
        );
    }

    #[test]
    fn stable_session_ids_are_distinct_per_account_and_product_agent() {
        let job = stable_main_session_id(41, "job-agent");
        assert_eq!(job, stable_main_session_id(41, "job-agent"));
        assert_ne!(job, stable_main_session_id(41, "lecturecast-agent"));
        assert_ne!(job, stable_main_session_id(41, "deploy-agent"));
        assert_ne!(job, stable_main_session_id(42, "job-agent"));
    }

    #[test]
    fn accounts_have_separate_instances_workspaces_and_sessions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let registry = AgentRegistry::in_home(temp.path());

        let first = registry
            .prepare_activation(41, "job-agent")
            .expect("first account activation");
        let second = registry
            .prepare_activation(42, "job-agent")
            .expect("second account activation");

        assert_ne!(first.main_session_id, second.main_session_id);
        assert_ne!(first.workspace_dir, second.workspace_dir);
        assert_eq!(
            registry.list(41).expect("first list")[0].owner_account_id,
            41
        );
        assert_eq!(
            registry.list(42).expect("second list")[0].owner_account_id,
            42
        );
        let first_json = serde_json::to_string(&first).expect("serialize record");
        assert!(!first_json.contains("ownerAccountId"));
    }

    #[test]
    fn first_valid_account_claims_legacy_rows_without_replacing_session_or_workspace() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = super::super::state::open(temp.path()).expect("open state");
            conn.execute(
                "INSERT INTO product_agents (
                   owner_account_id, agent_id, display_name, description, version, sort_order,
                   desired_state, runtime_state, main_session_id, workspace_dir, activated_at,
                   updated_at
                 ) VALUES (
                   NULL, 'job-agent', 'Job Agent', 'Legacy', '0.1.0', 10,
                   'running', 'dormant', '11111111-1111-1111-1111-111111111111',
                   '/legacy/workspace', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z'
                 )",
                [],
            )
            .expect("insert legacy row");
        }
        let registry = AgentRegistry::in_home(temp.path());

        registry
            .claim_legacy_and_seed(41)
            .expect("claim legacy rows");
        let claimed = registry.get(41, "job-agent").expect("claimed agent");

        assert_eq!(
            claimed.main_session_id.as_deref(),
            Some("11111111-1111-1111-1111-111111111111")
        );
        assert_eq!(claimed.workspace_dir.as_deref(), Some("/legacy/workspace"));
        assert_eq!(claimed.desired_state, "running");
        registry
            .claim_legacy_and_seed(42)
            .expect("seed second account");
        let second = registry.get(42, "job-agent").expect("second account agent");
        assert_eq!(second.desired_state, "inactive");
        assert!(second.main_session_id.is_none());
    }
}
