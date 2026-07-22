use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::model_routing::PreparedRoute;
use super::provider_profiles::ProviderProtocol;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BindingChangeReason {
    Initial,
    ExplicitSwitch,
    CompatibleMigration,
    Rollback,
}

impl BindingChangeReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::ExplicitSwitch => "explicit_switch",
            Self::CompatibleMigration => "compatible_migration",
            Self::Rollback => "rollback",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "initial" => Ok(Self::Initial),
            "explicit_switch" => Ok(Self::ExplicitSwitch),
            "compatible_migration" => Ok(Self::CompatibleMigration),
            "rollback" => Ok(Self::Rollback),
            _ => bail!("unsupported Session Provider Binding change reason"),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionProviderBinding {
    pub binding_id: String,
    #[serde(skip_serializing)]
    pub owner_account_id: i64,
    pub session_id: String,
    pub role: String,
    pub agent_id: Option<String>,
    pub binding_revision: u64,
    pub change_reason: BindingChangeReason,
    pub route: PreparedRoute,
    pub snapshot_hash: String,
    pub bound_at: String,
}

#[derive(Clone, Debug)]
pub struct SessionBindingStore {
    state_home: PathBuf,
}

impl Default for SessionBindingStore {
    fn default() -> Self {
        Self::in_home(super::state::default_state_home())
    }
}

impl SessionBindingStore {
    pub fn in_home(state_home: impl Into<PathBuf>) -> Self {
        Self {
            state_home: state_home.into(),
        }
    }

    pub fn current(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
    ) -> Result<Option<SessionProviderBinding>> {
        validate_owner(owner_account_id)?;
        let session_id = normalize_session_id(session_id)?;
        let role = normalize_identifier(role, "model role")?;
        let conn = super::state::open(&self.state_home)?;
        query_current(&conn, owner_account_id, &session_id, &role)
    }

    pub fn history(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
    ) -> Result<Vec<SessionProviderBinding>> {
        validate_owner(owner_account_id)?;
        let session_id = normalize_session_id(session_id)?;
        let role = normalize_identifier(role, "model role")?;
        let conn = super::state::open(&self.state_home)?;
        let mut stmt = conn.prepare(
            "SELECT binding_id, owner_account_id, session_id, role, agent_id, \
             binding_revision, change_reason, prepared_route_json, snapshot_hash, bound_at \
             FROM session_provider_bindings WHERE owner_account_id = ?1 AND session_id = ?2 \
             AND role = ?3 ORDER BY binding_revision",
        )?;
        let rows = stmt.query_map(params![owner_account_id, session_id, role], row_to_binding)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read Session Provider Binding history")
    }

    pub fn revision(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
        binding_revision: u64,
    ) -> Result<SessionProviderBinding> {
        validate_owner(owner_account_id)?;
        let session_id = normalize_session_id(session_id)?;
        let role = normalize_identifier(role, "model role")?;
        let conn = super::state::open(&self.state_home)?;
        conn.query_row(
            "SELECT binding_id, owner_account_id, session_id, role, agent_id, \
             binding_revision, change_reason, prepared_route_json, snapshot_hash, bound_at \
             FROM session_provider_bindings WHERE owner_account_id = ?1 AND session_id = ?2 \
             AND role = ?3 AND binding_revision = ?4",
            params![owner_account_id, session_id, role, binding_revision],
            row_to_binding,
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("Session Provider Binding revision not found"))
    }

    pub fn bind_initial(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
        agent_id: Option<&str>,
        route: &PreparedRoute,
    ) -> Result<SessionProviderBinding> {
        validate_owner(owner_account_id)?;
        let session_id = normalize_session_id(session_id)?;
        let role = normalize_identifier(role, "model role")?;
        let agent_id = normalize_optional_identifier(agent_id, "agent id")?;
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(current) = query_current(&transaction, owner_account_id, &session_id, &role)? {
            transaction.commit()?;
            return Ok(current);
        }
        let record = insert_binding(
            &transaction,
            owner_account_id,
            &session_id,
            &role,
            agent_id.as_deref(),
            1,
            BindingChangeReason::Initial,
            route,
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn append(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
        agent_id: Option<&str>,
        reason: BindingChangeReason,
        route: &PreparedRoute,
    ) -> Result<SessionProviderBinding> {
        validate_owner(owner_account_id)?;
        if reason == BindingChangeReason::Initial {
            bail!("initial bindings must use bind_initial");
        }
        let session_id = normalize_session_id(session_id)?;
        let role = normalize_identifier(role, "model role")?;
        let agent_id = normalize_optional_identifier(agent_id, "agent id")?;
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = query_current(&transaction, owner_account_id, &session_id, &role)?
            .ok_or_else(|| anyhow::anyhow!("Session Provider Binding is not initialized"))?;
        if current.agent_id.as_deref() != agent_id.as_deref() {
            bail!("Session Provider Binding agent identity cannot change");
        }
        let record = insert_binding(
            &transaction,
            owner_account_id,
            &session_id,
            &role,
            agent_id.as_deref(),
            current.binding_revision + 1,
            reason,
            route,
        )?;
        transaction.commit()?;
        Ok(record)
    }
}

fn insert_binding(
    conn: &Connection,
    owner_account_id: i64,
    session_id: &str,
    role: &str,
    agent_id: Option<&str>,
    binding_revision: u64,
    reason: BindingChangeReason,
    route: &PreparedRoute,
) -> Result<SessionProviderBinding> {
    let prepared_route_json =
        serde_json::to_string(route).context("serialize PreparedRoute snapshot")?;
    let snapshot_hash = blake3::hash(prepared_route_json.as_bytes())
        .to_hex()
        .to_string();
    let binding_id = format!("spb_{}", Uuid::new_v4().simple());
    let bound_at = now();
    conn.execute(
        "INSERT INTO session_provider_bindings (
           binding_id, owner_account_id, session_id, role, agent_id, binding_revision,
           change_reason, prepared_route_json, snapshot_hash, provider_profile_id,
           provider_preset_id, model_id, protocol, endpoint_origin, profile_route_revision,
           assignment_id, assignment_revision, catalog_revision, bound_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
           ?17, ?18, ?19
         )",
        params![
            binding_id,
            owner_account_id,
            session_id,
            role,
            agent_id,
            binding_revision,
            reason.as_str(),
            prepared_route_json,
            snapshot_hash,
            route.provider_profile_id,
            route.provider_preset_id,
            route.model_id,
            protocol_name(route.protocol),
            route.endpoint_origin,
            route.profile_route_revision,
            route.assignment_id,
            route.assignment_revision,
            route.catalog_revision,
            bound_at,
        ],
    )
    .context("append Session Provider Binding revision")?;

    Ok(SessionProviderBinding {
        binding_id,
        owner_account_id,
        session_id: session_id.to_owned(),
        role: role.to_owned(),
        agent_id: agent_id.map(str::to_owned),
        binding_revision,
        change_reason: reason,
        route: route.clone(),
        snapshot_hash,
        bound_at,
    })
}

fn query_current(
    conn: &Connection,
    owner_account_id: i64,
    session_id: &str,
    role: &str,
) -> Result<Option<SessionProviderBinding>> {
    conn.query_row(
        "SELECT binding_id, owner_account_id, session_id, role, agent_id, \
         binding_revision, change_reason, prepared_route_json, snapshot_hash, bound_at \
         FROM session_provider_bindings WHERE owner_account_id = ?1 AND session_id = ?2 \
         AND role = ?3 ORDER BY binding_revision DESC LIMIT 1",
        params![owner_account_id, session_id, role],
        row_to_binding,
    )
    .optional()
    .map_err(Into::into)
}

fn row_to_binding(row: &Row<'_>) -> rusqlite::Result<SessionProviderBinding> {
    let reason_raw: String = row.get(6)?;
    let route_raw: String = row.get(7)?;
    let change_reason = BindingChangeReason::parse(&reason_raw)
        .map_err(|error| conversion_message(6, error.to_string()))?;
    let snapshot_hash: String = row.get(8)?;
    let computed_hash = blake3::hash(route_raw.as_bytes()).to_hex().to_string();
    if snapshot_hash != computed_hash {
        return Err(conversion_message(
            8,
            "Session Provider Binding snapshot hash mismatch".into(),
        ));
    }
    let route = serde_json::from_str(&route_raw).map_err(|error| conversion_error(7, error))?;
    Ok(SessionProviderBinding {
        binding_id: row.get(0)?,
        owner_account_id: row.get(1)?,
        session_id: row.get(2)?,
        role: row.get(3)?,
        agent_id: row.get(4)?,
        binding_revision: row.get(5)?,
        change_reason,
        route,
        snapshot_hash,
        bound_at: row.get(9)?,
    })
}

fn validate_owner(owner_account_id: i64) -> Result<()> {
    if owner_account_id <= 0 {
        bail!("AgentMesh360 account id is invalid");
    }
    Ok(())
}

fn normalize_session_id(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        bail!("session id is invalid");
    }
    Ok(value.to_owned())
}

fn normalize_identifier(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
    {
        bail!("{label} is invalid");
    }
    Ok(value.to_owned())
}

fn normalize_optional_identifier(value: Option<&str>, label: &str) -> Result<Option<String>> {
    value
        .map(|value| normalize_identifier(value, label))
        .transpose()
}

fn protocol_name(protocol: ProviderProtocol) -> &'static str {
    match protocol {
        ProviderProtocol::OpenaiResponses => "openai_responses",
        ProviderProtocol::OpenaiChat => "openai_chat",
        ProviderProtocol::AnthropicMessages => "anthropic_messages",
    }
}

fn conversion_error(
    column: usize,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
}

fn conversion_message(column: usize, message: String) -> rusqlite::Error {
    conversion_error(
        column,
        std::io::Error::new(std::io::ErrorKind::InvalidData, message),
    )
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;
    use crate::agentmesh360::provider_catalog::{ModelCapability, ProviderClassification};
    use crate::agentmesh360::provider_profiles::{ProviderAuthKind, ProviderProtocol};

    fn route(profile_id: &str, model_id: &str, profile_revision: u64) -> PreparedRoute {
        PreparedRoute {
            provider_profile_id: profile_id.into(),
            provider_preset_id: Some("openai".into()),
            provider_display_name: "Personal Provider".into(),
            endpoint_classification: ProviderClassification::Official,
            endpoint_origin: "https://api.example".into(),
            protocol: ProviderProtocol::OpenaiResponses,
            base_url: "https://api.example/v1".into(),
            auth_kind: ProviderAuthKind::BearerApiKey,
            model_id: model_id.into(),
            profile_route_revision: profile_revision,
            assignment_id: "ma_main".into(),
            assignment_role: "main".into(),
            assignment_revision: profile_revision,
            catalog_revision: 9,
            capability: ModelCapability::unknown(),
            quirks: Vec::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn initial_binding_is_idempotent_and_account_scoped() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = SessionBindingStore::in_home(temp.path());
        let first = store
            .bind_initial(
                41,
                "session-a",
                "main",
                Some("job-agent"),
                &route("pp_a", "m1", 1),
            )
            .expect("first binding");
        let repeated = store
            .bind_initial(
                41,
                "session-a",
                "main",
                Some("job-agent"),
                &route("pp_b", "m2", 2),
            )
            .expect("repeated binding");

        assert_eq!(first, repeated);
        assert_eq!(first.binding_revision, 1);
        assert!(
            store
                .current(42, "session-a", "main")
                .expect("other account")
                .is_none()
        );
        let json = serde_json::to_string(&first).expect("serialize binding");
        assert!(!json.contains("ownerAccountId"));
        assert!(!json.to_ascii_lowercase().contains("credential"));
        assert!(!json.to_ascii_lowercase().contains("apikey"));
        assert_eq!(first.snapshot_hash.len(), 64);
    }

    #[test]
    fn revisions_are_append_only_and_preserve_old_snapshots() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = SessionBindingStore::in_home(temp.path());
        let first = store
            .bind_initial(41, "session-a", "main", None, &route("pp_a", "m1", 1))
            .expect("first binding");
        let second = store
            .append(
                41,
                "session-a",
                "main",
                None,
                BindingChangeReason::ExplicitSwitch,
                &route("pp_b", "m2", 2),
            )
            .expect("second binding");

        assert_eq!(second.binding_revision, 2);
        assert_eq!(second.route.provider_profile_id, "pp_b");
        assert_eq!(
            store
                .revision(41, "session-a", "main", 1)
                .expect("old revision"),
            first
        );
        assert_eq!(
            store.history(41, "session-a", "main").expect("history"),
            [first, second]
        );
    }

    #[test]
    fn concurrent_initial_binding_creates_one_revision() {
        let temp = tempfile::tempdir().expect("tempdir");
        super::super::state::open(temp.path()).expect("initialize state before concurrent writes");
        let home = Arc::new(temp.path().to_path_buf());
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let home = Arc::clone(&home);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                let store = SessionBindingStore::in_home(home.as_ref());
                barrier.wait();
                store
                    .bind_initial(41, "session-a", "main", None, &route("pp_a", "m1", 1))
                    .expect("concurrent initial")
            }));
        }
        barrier.wait();
        let records: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().expect("thread"))
            .collect();

        assert_eq!(records[0], records[1]);
        let store = SessionBindingStore::in_home(home.as_ref());
        assert_eq!(
            store
                .history(41, "session-a", "main")
                .expect("history")
                .len(),
            1
        );
    }

    #[test]
    fn fails_closed_when_a_snapshot_is_modified_on_disk() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = SessionBindingStore::in_home(temp.path());
        store
            .bind_initial(41, "session-a", "main", None, &route("pp_a", "m1", 1))
            .expect("initial binding");
        let conn = super::super::state::open(temp.path()).expect("open state");
        conn.execute(
            "UPDATE session_provider_bindings SET prepared_route_json = '{}'",
            [],
        )
        .expect("tamper snapshot");

        let error = store
            .current(41, "session-a", "main")
            .expect_err("tampered binding must fail closed");
        assert!(error.to_string().contains("snapshot hash mismatch"));
    }
}
