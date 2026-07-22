use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use rusqlite::types::Type;
use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};
use serde::Serialize;
use uuid::Uuid;

use super::provider_profiles::ProviderProtocol;
use super::session_bindings::SessionProviderBinding;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnRouteRecord {
    pub turn_route_id: String,
    #[serde(skip_serializing)]
    pub owner_account_id: i64,
    pub session_id: String,
    pub turn_id: String,
    pub role: String,
    pub binding_revision: u64,
    pub binding_snapshot_hash: String,
    pub provider_profile_id: String,
    pub provider_preset_id: Option<String>,
    pub model_id: String,
    pub protocol: ProviderProtocol,
    pub endpoint_origin: String,
    pub submitted_at: String,
}

#[derive(Clone, Debug)]
pub struct TurnRouteStore {
    state_home: PathBuf,
}

impl Default for TurnRouteStore {
    fn default() -> Self {
        Self::in_home(super::state::default_state_home())
    }
}

impl TurnRouteStore {
    pub fn in_home(state_home: impl Into<PathBuf>) -> Self {
        Self {
            state_home: state_home.into(),
        }
    }

    /// Fail before Sampling submission when this turn is already bound to a
    /// different immutable route. A concurrent writer is checked again by
    /// `record_submitted` after actor acceptance.
    pub fn validate_submission(
        &self,
        owner_account_id: i64,
        turn_id: &str,
        binding: &SessionProviderBinding,
    ) -> Result<()> {
        if binding.owner_account_id != owner_account_id {
            bail!("Turn route account does not match Binding owner");
        }
        let turn_id = normalize_id(turn_id, "turn id")?;
        let conn = super::state::open(&self.state_home)?;
        if let Some(record) = query_turn(
            &conn,
            owner_account_id,
            &binding.session_id,
            &binding.role,
            &turn_id,
        )? && (record.binding_revision != binding.binding_revision
            || record.binding_snapshot_hash != binding.snapshot_hash)
        {
            bail!("Turn is already recorded with a different Binding revision");
        }
        Ok(())
    }

    /// This is intentionally not called while merely preparing or displaying a route.
    /// Slice D must call it only at the Sampling request submission boundary.
    #[allow(dead_code)]
    pub fn record_submitted(
        &self,
        owner_account_id: i64,
        turn_id: &str,
        binding: &SessionProviderBinding,
    ) -> Result<TurnRouteRecord> {
        if binding.owner_account_id != owner_account_id {
            bail!("Turn route account does not match Binding owner");
        }
        let turn_id = normalize_id(turn_id, "turn id")?;
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let binding_exists = transaction
            .query_row(
                "SELECT 1 FROM session_provider_bindings WHERE owner_account_id = ?1 \
                 AND session_id = ?2 AND role = ?3 AND binding_revision = ?4 \
                 AND snapshot_hash = ?5",
                params![
                    owner_account_id,
                    binding.session_id,
                    binding.role,
                    binding.binding_revision,
                    binding.snapshot_hash,
                ],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !binding_exists {
            bail!("Turn route requires a persisted Session Provider Binding");
        }

        let turn_route_id = format!("trr_{}", Uuid::new_v4().simple());
        let submitted_at = now();
        transaction.execute(
            "INSERT INTO turn_route_records (
               turn_route_id, owner_account_id, session_id, turn_id, role, binding_revision,
               binding_snapshot_hash, provider_profile_id, provider_preset_id, model_id,
               protocol, endpoint_origin, submitted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(owner_account_id, session_id, role, turn_id) DO NOTHING",
            params![
                turn_route_id,
                owner_account_id,
                binding.session_id,
                turn_id,
                binding.role,
                binding.binding_revision,
                binding.snapshot_hash,
                binding.route.provider_profile_id,
                binding.route.provider_preset_id,
                binding.route.model_id,
                protocol_name(binding.route.protocol),
                binding.route.endpoint_origin,
                submitted_at,
            ],
        )?;
        let record = query_turn(
            &transaction,
            owner_account_id,
            &binding.session_id,
            &binding.role,
            &turn_id,
        )?
        .expect("inserted or existing Turn Route Record exists");
        if record.binding_revision != binding.binding_revision
            || record.binding_snapshot_hash != binding.snapshot_hash
        {
            bail!("Turn is already recorded with a different Binding revision");
        }
        transaction.commit()?;
        Ok(record)
    }

    pub fn list_session(
        &self,
        owner_account_id: i64,
        session_id: &str,
        role: &str,
    ) -> Result<Vec<TurnRouteRecord>> {
        if owner_account_id <= 0 {
            bail!("AgentMesh360 account id is invalid");
        }
        let session_id = normalize_id(session_id, "session id")?;
        let role = normalize_id(role, "model role")?;
        let conn = super::state::open(&self.state_home)?;
        let mut stmt = conn.prepare(
            "SELECT turn_route_id, owner_account_id, session_id, turn_id, role,
             binding_revision, binding_snapshot_hash, provider_profile_id,
             provider_preset_id, model_id, protocol, endpoint_origin, submitted_at
             FROM turn_route_records WHERE owner_account_id = ?1 AND session_id = ?2
             AND role = ?3 ORDER BY submitted_at, rowid",
        )?;
        let rows = stmt.query_map(params![owner_account_id, session_id, role], row_to_record)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read Turn Route Records")
    }
}

fn query_turn(
    conn: &rusqlite::Connection,
    owner_account_id: i64,
    session_id: &str,
    role: &str,
    turn_id: &str,
) -> Result<Option<TurnRouteRecord>> {
    conn.query_row(
        "SELECT turn_route_id, owner_account_id, session_id, turn_id, role,
         binding_revision, binding_snapshot_hash, provider_profile_id,
         provider_preset_id, model_id, protocol, endpoint_origin, submitted_at
         FROM turn_route_records WHERE owner_account_id = ?1 AND session_id = ?2
         AND role = ?3 AND turn_id = ?4",
        params![owner_account_id, session_id, role, turn_id],
        row_to_record,
    )
    .optional()
    .map_err(Into::into)
}

fn row_to_record(row: &Row<'_>) -> rusqlite::Result<TurnRouteRecord> {
    let protocol_raw: String = row.get(10)?;
    let protocol =
        parse_protocol(&protocol_raw).map_err(|message| conversion_message(10, message))?;
    Ok(TurnRouteRecord {
        turn_route_id: row.get(0)?,
        owner_account_id: row.get(1)?,
        session_id: row.get(2)?,
        turn_id: row.get(3)?,
        role: row.get(4)?,
        binding_revision: row.get(5)?,
        binding_snapshot_hash: row.get(6)?,
        provider_profile_id: row.get(7)?,
        provider_preset_id: row.get(8)?,
        model_id: row.get(9)?,
        protocol,
        endpoint_origin: row.get(11)?,
        submitted_at: row.get(12)?,
    })
}

fn normalize_id(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        bail!("{label} is invalid");
    }
    Ok(value.to_owned())
}

fn protocol_name(protocol: ProviderProtocol) -> &'static str {
    match protocol {
        ProviderProtocol::OpenaiResponses => "openai_responses",
        ProviderProtocol::OpenaiChat => "openai_chat",
        ProviderProtocol::AnthropicMessages => "anthropic_messages",
    }
}

fn parse_protocol(value: &str) -> Result<ProviderProtocol, String> {
    match value {
        "openai_responses" => Ok(ProviderProtocol::OpenaiResponses),
        "openai_chat" => Ok(ProviderProtocol::OpenaiChat),
        "anthropic_messages" => Ok(ProviderProtocol::AnthropicMessages),
        _ => Err("unsupported provider protocol in Turn Route Record".into()),
    }
}

fn conversion_message(column: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentmesh360::model_routing::PreparedRoute;
    use crate::agentmesh360::provider_catalog::{ModelCapability, ProviderClassification};
    use crate::agentmesh360::provider_profiles::{ProviderAuthKind, ProviderProtocol};
    use crate::agentmesh360::session_bindings::{BindingChangeReason, SessionBindingStore};

    fn route(model_id: &str) -> PreparedRoute {
        PreparedRoute {
            provider_profile_id: "pp_a".into(),
            provider_preset_id: Some("openai".into()),
            provider_display_name: "Provider".into(),
            endpoint_classification: ProviderClassification::Official,
            endpoint_origin: "https://api.example".into(),
            protocol: ProviderProtocol::OpenaiResponses,
            base_url: "https://api.example/v1".into(),
            auth_kind: ProviderAuthKind::BearerApiKey,
            model_id: model_id.into(),
            profile_route_revision: 1,
            assignment_id: "ma_main".into(),
            assignment_revision: 1,
            catalog_revision: 1,
            capability: ModelCapability::unknown(),
            quirks: Vec::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn records_only_persisted_actual_binding_once_per_turn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bindings = SessionBindingStore::in_home(temp.path());
        let turns = TurnRouteStore::in_home(temp.path());
        let first = bindings
            .bind_initial(41, "session-a", "main", None, &route("model-a"))
            .expect("initial binding");
        let recorded = turns
            .record_submitted(41, "turn-1", &first)
            .expect("record submitted turn");
        let repeated = turns
            .record_submitted(41, "turn-1", &first)
            .expect("idempotent record");
        assert_eq!(recorded, repeated);

        let second = bindings
            .append(
                41,
                "session-a",
                "main",
                None,
                BindingChangeReason::ExplicitSwitch,
                &route("model-b"),
            )
            .expect("switch binding");
        let conflict = turns
            .record_submitted(41, "turn-1", &second)
            .expect_err("same turn cannot change route");
        assert!(conflict.to_string().contains("different Binding"));
        turns
            .record_submitted(41, "turn-2", &second)
            .expect("record second turn");

        let listed = turns
            .list_session(41, "session-a", "main")
            .expect("list records");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].binding_revision, 1);
        assert_eq!(listed[1].binding_revision, 2);
        let json = serde_json::to_string(&listed).expect("serialize records");
        assert!(!json.contains("ownerAccountId"));
        assert!(!json.to_ascii_lowercase().contains("credential"));
        assert!(!json.to_ascii_lowercase().contains("apikey"));
    }

    #[test]
    fn rejects_fabricated_or_cross_account_binding_records() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bindings = SessionBindingStore::in_home(temp.path());
        let turns = TurnRouteStore::in_home(temp.path());
        let mut binding = bindings
            .bind_initial(41, "session-a", "main", None, &route("model-a"))
            .expect("initial binding");
        assert!(turns.record_submitted(42, "turn-1", &binding).is_err());
        binding.snapshot_hash = "fabricated".into();
        assert!(turns.record_submitted(41, "turn-1", &binding).is_err());
    }
}
