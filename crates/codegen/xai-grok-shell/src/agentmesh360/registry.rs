use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS product_agents (
    agent_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL,
    version TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    desired_state TEXT NOT NULL,
    runtime_state TEXT NOT NULL,
    main_session_id TEXT UNIQUE,
    workspace_dir TEXT,
    activated_at TEXT,
    updated_at TEXT NOT NULL,
    last_error TEXT
);
PRAGMA user_version = 1;
"#;

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
        let state_home = std::env::var_os("AGENTMESH360_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".agentmesh360")))
            .unwrap_or_else(|| PathBuf::from(".agentmesh360"));
        Self::in_home(state_home)
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

    pub fn list(&self) -> Result<Vec<ProductAgentRecord>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT agent_id, display_name, description, version, desired_state, \
             runtime_state, main_session_id, workspace_dir, activated_at, updated_at, \
             last_error FROM product_agents ORDER BY sort_order, agent_id",
        )?;
        let rows = stmt.query_map([], Self::row_to_record)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read AgentMesh360 product agent registry")
    }

    pub fn get(&self, agent_id: &str) -> Result<ProductAgentRecord> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT agent_id, display_name, description, version, desired_state, \
             runtime_state, main_session_id, workspace_dir, activated_at, updated_at, \
             last_error FROM product_agents WHERE agent_id = ?1",
            [agent_id],
            Self::row_to_record,
        )
        .with_context(|| format!("unknown AgentMesh360 product agent: {agent_id}"))
    }

    pub fn contains_main_session(&self, session_id: &str) -> Result<bool> {
        let conn = self.open()?;
        let found = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM product_agents WHERE main_session_id = ?1)",
            [session_id],
            |row| row.get(0),
        )?;
        Ok(found)
    }

    pub fn main_session_ids(&self) -> Result<HashSet<String>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT main_session_id FROM product_agents WHERE main_session_id IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<HashSet<_>>>()
            .context("read AgentMesh360 protected main sessions")
    }

    pub fn prepare_activation(&self, agent_id: &str) -> Result<ProductAgentRecord> {
        if !BUILTIN_AGENTS.iter().any(|spec| spec.agent_id == agent_id) {
            return Err(anyhow!("unknown AgentMesh360 product agent: {agent_id}"));
        }
        let workspace_dir = self.state_home.join("workspaces").join(agent_id);
        std::fs::create_dir_all(&workspace_dir).with_context(|| {
            format!("create product agent workspace {}", workspace_dir.display())
        })?;
        let main_session_id = stable_main_session_id(agent_id).to_string();
        let now = now();
        let conn = self.open()?;
        let changed = conn.execute(
            "UPDATE product_agents SET desired_state = 'running', runtime_state = 'starting', \
             main_session_id = ?2, workspace_dir = ?3, \
             activated_at = COALESCE(activated_at, ?4), updated_at = ?4, last_error = NULL \
             WHERE agent_id = ?1",
            params![
                agent_id,
                main_session_id,
                workspace_dir.to_string_lossy().as_ref(),
                now
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("unknown AgentMesh360 product agent: {agent_id}"));
        }
        self.get(agent_id)
    }

    pub fn mark_runtime(
        &self,
        agent_id: &str,
        runtime_state: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        let conn = self.open()?;
        let changed = conn.execute(
            "UPDATE product_agents SET runtime_state = ?2, updated_at = ?3, last_error = ?4 \
             WHERE agent_id = ?1",
            params![agent_id, runtime_state, now(), last_error],
        )?;
        if changed != 1 {
            return Err(anyhow!("unknown AgentMesh360 product agent: {agent_id}"));
        }
        Ok(())
    }

    fn open(&self) -> Result<Connection> {
        std::fs::create_dir_all(&self.state_home).with_context(|| {
            format!(
                "create AgentMesh360 state directory {}",
                self.state_home.display()
            )
        })?;
        let mode = xai_sqlite_journal::JournalMode::for_db_path(&self.db_path);
        let conn = mode
            .open(&self.db_path)
            .with_context(|| format!("open AgentMesh360 registry {}", self.db_path.display()))?;
        conn.execute_batch(SCHEMA)
            .context("initialize AgentMesh360 product agent registry")?;
        self.seed_builtins(&conn)?;
        Ok(conn)
    }

    fn seed_builtins(&self, conn: &Connection) -> Result<()> {
        let now = now();
        for spec in BUILTIN_AGENTS {
            conn.execute(
                "INSERT INTO product_agents (agent_id, display_name, description, version, \
                 sort_order, desired_state, runtime_state, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'inactive', 'available', ?6) \
                 ON CONFLICT(agent_id) DO UPDATE SET display_name = excluded.display_name, \
                 description = excluded.description, version = excluded.version, \
                 sort_order = excluded.sort_order",
                params![
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
            agent_id: row.get(0)?,
            display_name: row.get(1)?,
            description: row.get(2)?,
            version: row.get(3)?,
            desired_state: row.get(4)?,
            runtime_state: row.get(5)?,
            main_session_id: row.get(6)?,
            workspace_dir: row.get(7)?,
            activated_at: row.get(8)?,
            updated_at: row.get(9)?,
            last_error: row.get(10)?,
        })
    }
}

pub fn stable_main_session_id(agent_id: &str) -> Uuid {
    let identity = format!("https://agentmesh360.com/product-agents/{agent_id}/main");
    Uuid::new_v5(&Uuid::NAMESPACE_URL, identity.as_bytes())
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

        let records = registry.list().expect("list catalog");

        assert_eq!(records.len(), 3);
        assert_eq!(records[0].agent_id, "job-agent");
        assert_eq!(records[1].agent_id, "lecturecast-agent");
        assert_eq!(records[2].agent_id, "deploy-agent");
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
        let expected_session_id = stable_main_session_id("job-agent").to_string();
        assert!(
            !first
                .contains_main_session(&expected_session_id)
                .expect("inactive agent has no main session")
        );
        let activated = first.prepare_activation("job-agent").expect("activate");

        assert_eq!(
            activated.main_session_id.as_deref(),
            Some(expected_session_id.as_str())
        );
        assert_eq!(activated.desired_state, "running");
        assert!(
            first
                .contains_main_session(&expected_session_id)
                .expect("activated main session is protected")
        );
        assert_eq!(
            first.main_session_ids().expect("protected sessions"),
            HashSet::from([expected_session_id.clone()])
        );

        let reopened = AgentRegistry::in_home(temp.path());
        let activated_again = reopened
            .prepare_activation("job-agent")
            .expect("reactivate");
        assert_eq!(activated_again.main_session_id, activated.main_session_id);
        assert_eq!(activated_again.workspace_dir, activated.workspace_dir);
        assert_eq!(activated_again.activated_at, activated.activated_at);
        assert!(
            reopened
                .contains_main_session(&expected_session_id)
                .expect("reopened registry protects the same main session")
        );
    }

    #[test]
    fn stable_session_ids_are_distinct_per_product_agent() {
        let job = stable_main_session_id("job-agent");
        assert_eq!(job, stable_main_session_id("job-agent"));
        assert_ne!(job, stable_main_session_id("lecturecast-agent"));
        assert_ne!(job, stable_main_session_id("deploy-agent"));
    }
}
