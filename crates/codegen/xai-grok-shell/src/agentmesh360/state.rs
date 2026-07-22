use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::Connection;

const SCHEMA_VERSION: u32 = 2;

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

CREATE TABLE IF NOT EXISTS provider_profiles (
    profile_id TEXT PRIMARY KEY,
    owner_account_id INTEGER NOT NULL,
    preset_id TEXT,
    display_name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth_kind TEXT NOT NULL,
    credential_ref TEXT NOT NULL UNIQUE,
    credential_last_four TEXT NOT NULL,
    enabled_models_json TEXT NOT NULL,
    route_revision INTEGER NOT NULL CHECK(route_revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_account_id, display_name)
);

CREATE INDEX IF NOT EXISTS idx_provider_profiles_owner
    ON provider_profiles(owner_account_id, display_name, profile_id);
"#;

pub(super) fn default_state_home() -> PathBuf {
    std::env::var_os("AGENTMESH360_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".agentmesh360")))
        .unwrap_or_else(|| PathBuf::from(".agentmesh360"))
}

pub(super) fn open(state_home: &Path) -> Result<Connection> {
    std::fs::create_dir_all(state_home).with_context(|| {
        format!(
            "create AgentMesh360 state directory {}",
            state_home.display()
        )
    })?;
    let db_path = state_home.join("state.db");
    let mode = xai_sqlite_journal::JournalMode::for_db_path(&db_path);
    let mut conn = mode
        .open(&db_path)
        .with_context(|| format!("open AgentMesh360 state database {}", db_path.display()))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .context("enable AgentMesh360 state foreign keys")?;
    let current_version: u32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .context("read AgentMesh360 state schema version")?;
    if current_version > SCHEMA_VERSION {
        anyhow::bail!("unsupported AgentMesh360 state schema version: {current_version}");
    }
    let transaction = conn
        .transaction()
        .context("start AgentMesh360 state migration")?;
    transaction
        .execute_batch(SCHEMA)
        .context("initialize AgentMesh360 state database")?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .context("update AgentMesh360 state schema version")?;
    transaction
        .commit()
        .context("commit AgentMesh360 state migration")?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_the_shared_v2_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let conn = open(temp.path()).expect("open state");

        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN \
                     ('product_agents', 'provider_profiles') ORDER BY name",
                )
                .expect("prepare table query");
            stmt.query_map([], |row| row.get(0))
                .expect("query tables")
                .collect::<rusqlite::Result<_>>()
                .expect("collect tables")
        };

        assert_eq!(version, 2);
        assert_eq!(tables, ["product_agents", "provider_profiles"]);
    }

    #[test]
    fn refuses_to_downgrade_a_newer_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = rusqlite::Connection::open(temp.path().join("state.db"))
                .expect("create future database");
            conn.pragma_update(None, "user_version", 99)
                .expect("set future version");
        }

        let error = open(temp.path()).expect_err("future schema must fail closed");
        assert!(error.to_string().contains("unsupported"));
        let conn = rusqlite::Connection::open(temp.path().join("state.db"))
            .expect("reopen future database");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read future version");
        assert_eq!(version, 99);
    }
}
