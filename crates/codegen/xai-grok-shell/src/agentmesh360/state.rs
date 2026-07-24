use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

const SCHEMA_VERSION: u32 = 9;

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

CREATE TABLE IF NOT EXISTS session_provider_bindings (
    binding_id TEXT PRIMARY KEY,
    owner_account_id INTEGER NOT NULL CHECK(owner_account_id > 0),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    agent_id TEXT,
    binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
    change_reason TEXT NOT NULL CHECK(change_reason IN (
        'initial', 'explicit_switch', 'compatible_migration', 'rollback'
    )),
    prepared_route_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    provider_profile_id TEXT NOT NULL,
    provider_preset_id TEXT,
    model_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    endpoint_origin TEXT NOT NULL,
    profile_route_revision INTEGER NOT NULL CHECK(profile_route_revision >= 1),
    assignment_id TEXT NOT NULL,
    assignment_revision INTEGER NOT NULL CHECK(assignment_revision >= 1),
    catalog_revision INTEGER NOT NULL CHECK(catalog_revision >= 1),
    bound_at TEXT NOT NULL,
    UNIQUE(owner_account_id, session_id, role, binding_revision)
);

CREATE INDEX IF NOT EXISTS idx_session_provider_bindings_current
    ON session_provider_bindings(owner_account_id, session_id, role, binding_revision DESC);

CREATE TABLE IF NOT EXISTS turn_route_records (
    turn_route_id TEXT PRIMARY KEY,
    owner_account_id INTEGER NOT NULL CHECK(owner_account_id > 0),
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
    binding_snapshot_hash TEXT NOT NULL,
    provider_profile_id TEXT NOT NULL,
    provider_preset_id TEXT,
    model_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    endpoint_origin TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    UNIQUE(owner_account_id, session_id, role, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_turn_route_records_session
    ON turn_route_records(owner_account_id, session_id, role, submitted_at);

CREATE TABLE IF NOT EXISTS provider_probe_results (
    probe_id TEXT PRIMARY KEY,
    owner_account_id INTEGER NOT NULL CHECK(owner_account_id > 0),
    provider_profile_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN (
        'local_validation', 'metadata', 'minimal_inference'
    )),
    status TEXT NOT NULL CHECK(status IN (
        'passed', 'failed', 'unsupported', 'confirmation_required'
    )),
    network_attempted INTEGER NOT NULL CHECK(network_attempted IN (0, 1)),
    may_incur_cost INTEGER NOT NULL CHECK(may_incur_cost IN (0, 1)),
    endpoint_classification TEXT NOT NULL CHECK(endpoint_classification IN (
        'official', 'aggregator', 'gateway', 'custom', 'local'
    )),
    endpoint_origin TEXT NOT NULL,
    protocol TEXT NOT NULL,
    assignment_count INTEGER NOT NULL CHECK(assignment_count >= 0),
    summary_code TEXT NOT NULL,
    summary_message TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_provider_probe_results_owner
    ON provider_probe_results(owner_account_id, completed_at DESC, probe_id);

CREATE TABLE IF NOT EXISTS agent_package_registry (
    package_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE,
    active_version TEXT NOT NULL,
    active_artifact_sha256 TEXT NOT NULL,
    active_file_manifest_sha256 TEXT NOT NULL,
    active_relative_path TEXT NOT NULL,
    active_permissions_json TEXT NOT NULL,
    active_signature_key_id TEXT NOT NULL,
    previous_version TEXT,
    previous_artifact_sha256 TEXT,
    previous_file_manifest_sha256 TEXT,
    previous_relative_path TEXT,
    previous_permissions_json TEXT,
    previous_signature_key_id TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (
            previous_version IS NULL
            AND previous_artifact_sha256 IS NULL
            AND previous_file_manifest_sha256 IS NULL
            AND previous_relative_path IS NULL
            AND previous_permissions_json IS NULL
            AND previous_signature_key_id IS NULL
        )
        OR
        (
            previous_version IS NOT NULL
            AND previous_artifact_sha256 IS NOT NULL
            AND previous_file_manifest_sha256 IS NOT NULL
            AND previous_relative_path IS NOT NULL
            AND previous_permissions_json IS NOT NULL
            AND previous_signature_key_id IS NOT NULL
        )
    )
);

CREATE TABLE IF NOT EXISTS package_trust_cache (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
    root_key_id TEXT NOT NULL,
    trust_sequence INTEGER NOT NULL CHECK(trust_sequence >= 1),
    trust_document TEXT NOT NULL,
    trust_document_sha256 TEXT NOT NULL,
    trust_expires_at TEXT NOT NULL,
    registry_revision INTEGER NOT NULL CHECK(registry_revision >= 1),
    registry_document TEXT NOT NULL,
    registry_document_sha256 TEXT NOT NULL,
    registry_expires_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
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
    conn.busy_timeout(Duration::from_secs(5))
        .context("configure AgentMesh360 state lock timeout")?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .context("enable AgentMesh360 state foreign keys")?;
    let current_version: u32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .context("read AgentMesh360 state schema version")?;
    if current_version > SCHEMA_VERSION {
        anyhow::bail!("unsupported AgentMesh360 state schema version: {current_version}");
    }
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("start AgentMesh360 state migration")?;
    if current_version < 4 {
        migrate_product_agents_to_v4(&transaction)?;
    }
    if current_version == 7 {
        migrate_agent_package_registry_to_v8(&transaction)?;
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

fn migrate_agent_package_registry_to_v8(transaction: &Transaction<'_>) -> Result<()> {
    let table_exists = transaction
        .query_row(
            "SELECT 1 FROM sqlite_master \
             WHERE type = 'table' AND name = 'agent_package_registry'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !table_exists {
        return Ok(());
    }
    let package_count: u32 =
        transaction.query_row("SELECT COUNT(*) FROM agent_package_registry", [], |row| {
            row.get(0)
        })?;
    if package_count != 0 {
        anyhow::bail!(
            "Agent Package Registry v7 entries lack trusted file-manifest integrity anchors; \
             remove the unpublished development entries and reinstall signed Packages"
        );
    }
    transaction
        .execute_batch("DROP TABLE agent_package_registry;")
        .context("replace empty Agent Package Registry v7 schema")?;
    Ok(())
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
    fn initializes_the_shared_v9_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let conn = open(temp.path()).expect("open state");

        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN \
                     ('agent_package_registry', 'model_assignments', 'package_trust_cache', \
                      'product_agents', 'provider_profiles', 'provider_probe_results', 'session_provider_bindings', \
                      'turn_route_records') ORDER BY name",
                )
                .expect("prepare table query");
            stmt.query_map([], |row| row.get(0))
                .expect("query tables")
                .collect::<rusqlite::Result<_>>()
                .expect("collect tables")
        };

        assert_eq!(version, 9);
        assert_eq!(
            tables,
            [
                "agent_package_registry",
                "model_assignments",
                "package_trust_cache",
                "product_agents",
                "provider_probe_results",
                "provider_profiles",
                "session_provider_bindings",
                "turn_route_records"
            ]
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

        assert_eq!(version, 9);
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

    #[test]
    fn upgrades_v4_without_losing_account_scoped_agents() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = open(temp.path()).expect("initialize database");
            conn.execute_batch(
                "DROP TABLE turn_route_records;
                 DROP TABLE session_provider_bindings;
                 INSERT INTO product_agents (
                   owner_account_id, agent_id, display_name, description, version, sort_order,
                   desired_state, runtime_state, main_session_id, updated_at
                 ) VALUES (
                   41, 'job-agent', 'Job Agent', 'Existing', '0.1.0', 10,
                   'running', 'dormant', '11111111-1111-1111-1111-111111111111',
                   '2026-07-23T00:00:00Z'
                 );
                 PRAGMA user_version = 4;",
            )
            .expect("prepare v4 database");
        }

        let conn = open(temp.path()).expect("upgrade v4 database");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let owner: i64 = conn
            .query_row(
                "SELECT owner_account_id FROM product_agents WHERE agent_id = 'job-agent'",
                [],
                |row| row.get(0),
            )
            .expect("agent owner");
        let binding_tables: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN \
                 ('session_provider_bindings', 'turn_route_records')",
                [],
                |row| row.get(0),
            )
            .expect("binding tables");

        assert_eq!(version, 9);
        assert_eq!(owner, 41);
        assert_eq!(binding_tables, 2);
    }

    #[test]
    fn upgrades_empty_v7_package_registry_with_integrity_anchor_columns() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = open(temp.path()).expect("initialize database");
            prepare_v7_package_registry(&conn, false);
        }

        let conn = open(temp.path()).expect("upgrade empty v7 registry");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let columns = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(agent_package_registry)")
                .expect("table info");
            stmt.query_map([], |row| row.get::<_, String>(1))
                .expect("query columns")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect columns")
        };

        assert_eq!(version, 9);
        assert!(columns.contains(&"active_file_manifest_sha256".to_owned()));
        assert!(columns.contains(&"previous_file_manifest_sha256".to_owned()));
    }

    #[test]
    fn refuses_to_blindly_anchor_existing_v7_package_rows() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = open(temp.path()).expect("initialize database");
            prepare_v7_package_registry(&conn, true);
        }

        let error = open(temp.path()).expect_err("unanchored v7 Package row");
        assert!(error.to_string().contains("lack trusted"));
        let conn =
            rusqlite::Connection::open(temp.path().join("state.db")).expect("reopen v7 database");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let rows: u32 = conn
            .query_row("SELECT COUNT(*) FROM agent_package_registry", [], |row| {
                row.get(0)
            })
            .expect("registry rows");
        assert_eq!(version, 7);
        assert_eq!(rows, 1);
    }

    #[test]
    fn upgrades_v6_with_package_registry_without_losing_existing_state() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = open(temp.path()).expect("initialize database");
            conn.execute_batch(
                "DROP TABLE agent_package_registry;
                 INSERT INTO product_agents (
                   owner_account_id, agent_id, display_name, description, version, sort_order,
                   desired_state, runtime_state, main_session_id, updated_at
                 ) VALUES (
                   41, 'job-agent', 'Job Agent', 'Existing', '0.4.7', 10,
                   'running', 'dormant', '11111111-1111-1111-1111-111111111111',
                   '2026-07-24T00:00:00Z'
                 );
                 PRAGMA user_version = 6;",
            )
            .expect("prepare v6 database");
        }

        let conn = open(temp.path()).expect("upgrade v6 database");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let session_id: String = conn
            .query_row(
                "SELECT main_session_id FROM product_agents \
                 WHERE owner_account_id = 41 AND agent_id = 'job-agent'",
                [],
                |row| row.get(0),
            )
            .expect("existing Agent session");
        let registry_table: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type = 'table' AND name = 'agent_package_registry'",
                [],
                |row| row.get(0),
            )
            .expect("Package Registry table");

        assert_eq!(version, 9);
        assert_eq!(session_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(registry_table, 1);
    }

    #[test]
    fn upgrades_v8_with_empty_package_trust_cache_without_losing_existing_state() {
        let temp = tempfile::tempdir().expect("tempdir");
        {
            let conn = open(temp.path()).expect("initialize database");
            conn.execute_batch(
                "DROP TABLE package_trust_cache;
                 INSERT INTO product_agents (
                   owner_account_id, agent_id, display_name, description, version, sort_order,
                   desired_state, runtime_state, main_session_id, updated_at
                 ) VALUES (
                   41, 'job-agent', 'Job Agent', 'Existing', '0.4.7', 10,
                   'running', 'dormant', '11111111-1111-1111-1111-111111111111',
                   '2026-07-24T00:00:00Z'
                 );
                 PRAGMA user_version = 8;",
            )
            .expect("prepare v8 database");
        }

        let conn = open(temp.path()).expect("upgrade v8 database");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        let session_id: String = conn
            .query_row(
                "SELECT main_session_id FROM product_agents \
                 WHERE owner_account_id = 41 AND agent_id = 'job-agent'",
                [],
                |row| row.get(0),
            )
            .expect("existing Agent session");
        let cache_rows: u32 = conn
            .query_row("SELECT COUNT(*) FROM package_trust_cache", [], |row| {
                row.get(0)
            })
            .expect("Package Trust Cache row count");

        assert_eq!(version, 9);
        assert_eq!(session_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(cache_rows, 0);
    }

    fn prepare_v7_package_registry(conn: &Connection, with_row: bool) {
        conn.execute_batch(
            "DROP TABLE agent_package_registry;
             CREATE TABLE agent_package_registry (
               package_id TEXT PRIMARY KEY,
               agent_id TEXT NOT NULL UNIQUE,
               active_version TEXT NOT NULL,
               active_artifact_sha256 TEXT NOT NULL,
               active_relative_path TEXT NOT NULL,
               active_permissions_json TEXT NOT NULL,
               active_signature_key_id TEXT NOT NULL,
               previous_version TEXT,
               previous_artifact_sha256 TEXT,
               previous_relative_path TEXT,
               previous_permissions_json TEXT,
               previous_signature_key_id TEXT,
               installed_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             PRAGMA user_version = 7;",
        )
        .expect("prepare v7 Package Registry");
        if with_row {
            conn.execute(
                "INSERT INTO agent_package_registry (
                   package_id, agent_id, active_version, active_artifact_sha256,
                   active_relative_path, active_permissions_json, active_signature_key_id,
                   installed_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                rusqlite::params![
                    "com.agentmesh360.job-agent",
                    "job-agent",
                    "0.4.7",
                    "a".repeat(64),
                    "versions/com.agentmesh360.job-agent/0.4.7/a",
                    "[]",
                    "agentmesh360-test-2026",
                    "2026-07-24T00:00:00Z"
                ],
            )
            .expect("insert v7 Package row");
        }
    }
}
