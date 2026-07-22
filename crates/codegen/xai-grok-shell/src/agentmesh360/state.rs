use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction};

const SCHEMA_VERSION: u32 = 4;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS product_agents (
    owner_account_id INTEGER,
    agent_id TEXT NOT NULL,
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
    last_error TEXT,
    PRIMARY KEY(owner_account_id, agent_id),
    CHECK(owner_account_id IS NULL OR owner_account_id > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_agents_legacy_agent
    ON product_agents(agent_id) WHERE owner_account_id IS NULL;

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

CREATE TABLE IF NOT EXISTS model_assignments (
    assignment_id TEXT PRIMARY KEY,
    owner_account_id INTEGER NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global', 'agent', 'session')),
    scope_id TEXT NOT NULL,
    role TEXT NOT NULL,
    provider_profile_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    assignment_revision INTEGER NOT NULL CHECK(assignment_revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_account_id, scope_kind, scope_id, role),
    FOREIGN KEY(provider_profile_id) REFERENCES provider_profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_assignments_resolve
    ON model_assignments(owner_account_id, role, scope_kind, scope_id);
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
    if current_version < 4 {
        migrate_product_agents_to_v4(&transaction)?;
    }
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

fn migrate_product_agents_to_v4(transaction: &Transaction<'_>) -> Result<()> {
    let table_exists = transaction
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_agents'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !table_exists {
        return Ok(());
    }

    let has_owner_column = {
        let mut stmt = transaction.prepare("PRAGMA table_info(product_agents)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|column| column == "owner_account_id")
    };
    if has_owner_column {
        return Ok(());
    }

    transaction
        .execute_batch(
            "ALTER TABLE product_agents RENAME TO product_agents_unscoped_v3;
             CREATE TABLE product_agents (
               owner_account_id INTEGER,
               agent_id TEXT NOT NULL,
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
               last_error TEXT,
               PRIMARY KEY(owner_account_id, agent_id),
               CHECK(owner_account_id IS NULL OR owner_account_id > 0)
             );
             INSERT INTO product_agents (
               owner_account_id, agent_id, display_name, description, version, sort_order,
               desired_state, runtime_state, main_session_id, workspace_dir, activated_at,
               updated_at, last_error
             )
             SELECT NULL, agent_id, display_name, description, version, sort_order,
               desired_state, runtime_state, main_session_id, workspace_dir, activated_at,
               updated_at, last_error
             FROM product_agents_unscoped_v3;
             DROP TABLE product_agents_unscoped_v3;",
        )
        .context("migrate product agents to account-scoped registry")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_the_shared_v4_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let conn = open(temp.path()).expect("open state");

        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN \
                     ('model_assignments', 'product_agents', 'provider_profiles') ORDER BY name",
                )
                .expect("prepare table query");
            stmt.query_map([], |row| row.get(0))
                .expect("query tables")
                .collect::<rusqlite::Result<_>>()
                .expect("collect tables")
        };

        assert_eq!(version, 4);
        assert_eq!(
            tables,
            ["model_assignments", "product_agents", "provider_profiles"]
        );
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

    #[test]
    fn upgrades_v2_without_losing_provider_profiles() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = open(temp.path()).expect("initialize database");
            conn.execute_batch(
                "DROP TABLE model_assignments;
                 PRAGMA user_version = 2;
                 INSERT INTO provider_profiles (
                   profile_id, owner_account_id, preset_id, display_name, protocol,
                   base_url, auth_kind, credential_ref, credential_last_four,
                   enabled_models_json, route_revision, created_at, updated_at
                 ) VALUES (
                   'pp_existing', 1, 'openai', 'Existing', 'openai_responses',
                   'https://api.openai.com/v1', 'bearer_api_key',
                   'credential://vault/h_00000000000000000000000000000001', '1234',
                   '[\"model-main\"]', 1, '2026-07-23T00:00:00Z', '2026-07-23T00:00:00Z'
                 );",
            )
            .expect("prepare v2 database");
        }

        let conn = open(temp.path()).expect("upgrade v2 database");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let profiles: u32 = conn
            .query_row("SELECT COUNT(*) FROM provider_profiles", [], |row| {
                row.get(0)
            })
            .expect("profile count");
        let assignments_table: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type = 'table' AND name = 'model_assignments'",
                [],
                |row| row.get(0),
            )
            .expect("assignment table count");

        assert_eq!(version, 4);
        assert_eq!(profiles, 1);
        assert_eq!(assignments_table, 1);
    }

    #[test]
    fn upgrades_v3_product_agents_to_unclaimed_account_scoped_rows() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = open(temp.path()).expect("initialize database");
            conn.execute_batch(
                "DROP TABLE product_agents;
                 CREATE TABLE product_agents (
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
                 INSERT INTO product_agents (
                   agent_id, display_name, description, version, sort_order, desired_state,
                   runtime_state, main_session_id, workspace_dir, activated_at, updated_at
                 ) VALUES (
                   'job-agent', 'Job Agent', 'Legacy', '0.1.0', 10, 'running', 'resident',
                   '11111111-1111-1111-1111-111111111111', '/legacy/workspace',
                   '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z'
                 );
                 PRAGMA user_version = 3;",
            )
            .expect("prepare v3 database");
        }

        let conn = open(temp.path()).expect("upgrade v3 database");
        let owner: Option<i64> = conn
            .query_row(
                "SELECT owner_account_id FROM product_agents WHERE agent_id = 'job-agent'",
                [],
                |row| row.get(0),
            )
            .expect("legacy owner");
        let session_id: String = conn
            .query_row(
                "SELECT main_session_id FROM product_agents WHERE agent_id = 'job-agent'",
                [],
                |row| row.get(0),
            )
            .expect("legacy session");

        assert_eq!(owner, None);
        assert_eq!(session_id, "11111111-1111-1111-1111-111111111111");
    }
}
