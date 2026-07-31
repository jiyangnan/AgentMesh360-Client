use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::provider_profiles::normalize_model_id;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentScopeKind {
    Global,
    Agent,
    Session,
}

impl AssignmentScopeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Agent => "agent",
            Self::Session => "session",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "global" => Ok(Self::Global),
            "agent" => Ok(Self::Agent),
            "session" => Ok(Self::Session),
            _ => bail!("unsupported model assignment scope"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelAssignmentInput {
    pub scope_kind: AssignmentScopeKind,
    pub scope_id: Option<String>,
    pub role: String,
    pub provider_profile_id: String,
    pub model_id: String,
}

impl ModelAssignmentInput {
    fn normalized(mut self) -> Result<Self> {
        self.scope_id = self
            .scope_id
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        match self.scope_kind {
            AssignmentScopeKind::Global if self.scope_id.is_some() => {
                bail!("global model assignments must not have a scope id")
            }
            AssignmentScopeKind::Agent | AssignmentScopeKind::Session
                if self.scope_id.is_none() =>
            {
                bail!("agent and session model assignments require a scope id")
            }
            _ => {}
        }
        if self
            .scope_id
            .as_ref()
            .is_some_and(|value| value.chars().count() > 200 || value.chars().any(char::is_control))
        {
            bail!("model assignment scope id is too long");
        }

        self.role = normalized_identifier(&self.role, "model role")?;
        self.provider_profile_id =
            normalized_identifier(&self.provider_profile_id, "provider profile id")?;
        self.model_id = normalize_model_id(&self.model_id)?;
        Ok(self)
    }

    fn database_scope_id(&self) -> &str {
        self.scope_id.as_deref().unwrap_or("")
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelAssignmentRecord {
    pub assignment_id: String,
    #[serde(skip_serializing)]
    pub owner_account_id: i64,
    pub scope_kind: AssignmentScopeKind,
    pub scope_id: Option<String>,
    pub role: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub assignment_revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct ModelAssignmentStore {
    state_home: PathBuf,
}

impl Default for ModelAssignmentStore {
    fn default() -> Self {
        Self::in_home(super::state::default_state_home())
    }
}

impl ModelAssignmentStore {
    pub fn in_home(state_home: impl Into<PathBuf>) -> Self {
        Self {
            state_home: state_home.into(),
        }
    }

    pub fn list(&self, owner_account_id: i64) -> Result<Vec<ModelAssignmentRecord>> {
        let conn = super::state::open(&self.state_home)?;
        let mut stmt = conn.prepare(
            "SELECT assignment_id, owner_account_id, scope_kind, scope_id, role, \
             provider_profile_id, model_id, assignment_revision, created_at, updated_at \
             FROM model_assignments WHERE owner_account_id = ?1 \
             ORDER BY role, scope_kind, scope_id",
        )?;
        let rows = stmt.query_map([owner_account_id], row_to_record)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read AgentMesh360 model assignments")
    }

    pub fn upsert(
        &self,
        owner_account_id: i64,
        input: ModelAssignmentInput,
    ) -> Result<ModelAssignmentRecord> {
        let input = input.normalized()?;
        let mut conn = super::state::open(&self.state_home)?;
        let transaction = conn.transaction()?;
        let enabled_models_json = transaction
            .query_row(
                "SELECT enabled_models_json FROM provider_profiles \
                 WHERE owner_account_id = ?1 AND profile_id = ?2",
                params![owner_account_id, input.provider_profile_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| anyhow!("provider profile not found"))?;
        let enabled_models: Vec<String> = serde_json::from_str(&enabled_models_json)
            .context("parse provider enabled model ids")?;
        if !enabled_models.iter().any(|model| model == &input.model_id) {
            bail!("model is not enabled for the selected provider profile");
        }

        let current = get_exact(
            &transaction,
            owner_account_id,
            input.scope_kind,
            input.database_scope_id(),
            &input.role,
        )?;
        let (assignment_id, assignment_revision, created_at) = match current {
            Some(current) => {
                let changed = current.provider_profile_id != input.provider_profile_id
                    || current.model_id != input.model_id;
                (
                    current.assignment_id,
                    current.assignment_revision + u64::from(changed),
                    current.created_at,
                )
            }
            None => (format!("ma_{}", Uuid::new_v4().simple()), 1, now()),
        };
        let updated_at = now();
        transaction.execute(
            "INSERT INTO model_assignments (assignment_id, owner_account_id, scope_kind, \
             scope_id, role, provider_profile_id, model_id, assignment_revision, \
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(owner_account_id, scope_kind, scope_id, role) DO UPDATE SET \
             provider_profile_id = excluded.provider_profile_id, model_id = excluded.model_id, \
             assignment_revision = excluded.assignment_revision, updated_at = excluded.updated_at",
            params![
                assignment_id,
                owner_account_id,
                input.scope_kind.as_str(),
                input.database_scope_id(),
                input.role,
                input.provider_profile_id,
                input.model_id,
                assignment_revision,
                created_at,
                updated_at,
            ],
        )?;
        let record = get_exact(
            &transaction,
            owner_account_id,
            input.scope_kind,
            input.database_scope_id(),
            &input.role,
        )?
        .expect("upserted model assignment exists");
        transaction.commit()?;
        Ok(record)
    }

    pub fn resolve(
        &self,
        owner_account_id: i64,
        role: &str,
        agent_id: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<ModelAssignmentRecord> {
        let role = normalized_identifier(role, "model role")?;
        let conn = super::state::open(&self.state_home)?;
        resolve_role(&conn, owner_account_id, &role, agent_id, session_id)?
            .ok_or_else(|| anyhow!("no model assignment is configured for role {role}"))
    }

    pub fn resolve_with_main_fallback(
        &self,
        owner_account_id: i64,
        role: &str,
        agent_id: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<ModelAssignmentRecord> {
        let role = normalized_identifier(role, "model role")?;
        let conn = super::state::open(&self.state_home)?;
        if let Some(record) = resolve_role(&conn, owner_account_id, &role, agent_id, session_id)? {
            return Ok(record);
        }
        if role != "main"
            && let Some(record) =
                resolve_role(&conn, owner_account_id, "main", agent_id, session_id)?
        {
            return Ok(record);
        }
        Err(anyhow!(
            "no model assignment is configured for role {role} or fallback role main"
        ))
    }

    pub fn delete(&self, owner_account_id: i64, assignment_id: &str) -> Result<()> {
        let assignment_id = normalized_identifier(assignment_id, "model assignment id")?;
        let conn = super::state::open(&self.state_home)?;
        let changed = conn.execute(
            "DELETE FROM model_assignments WHERE owner_account_id = ?1 AND assignment_id = ?2",
            params![owner_account_id, assignment_id],
        )?;
        if changed != 1 {
            bail!("model assignment not found");
        }
        Ok(())
    }
}

fn resolve_role(
    conn: &Connection,
    owner_account_id: i64,
    role: &str,
    agent_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<Option<ModelAssignmentRecord>> {
    if let Some(session_id) = session_id
        && let Some(record) = get_exact(
            conn,
            owner_account_id,
            AssignmentScopeKind::Session,
            session_id,
            role,
        )?
    {
        return Ok(Some(record));
    }
    if let Some(agent_id) = agent_id
        && let Some(record) = get_exact(
            conn,
            owner_account_id,
            AssignmentScopeKind::Agent,
            agent_id,
            role,
        )?
    {
        return Ok(Some(record));
    }
    get_exact(
        conn,
        owner_account_id,
        AssignmentScopeKind::Global,
        "",
        role,
    )
}

fn get_exact(
    conn: &Connection,
    owner_account_id: i64,
    scope_kind: AssignmentScopeKind,
    scope_id: &str,
    role: &str,
) -> Result<Option<ModelAssignmentRecord>> {
    conn.query_row(
        "SELECT assignment_id, owner_account_id, scope_kind, scope_id, role, \
         provider_profile_id, model_id, assignment_revision, created_at, updated_at \
         FROM model_assignments WHERE owner_account_id = ?1 AND scope_kind = ?2 \
         AND scope_id = ?3 AND role = ?4",
        params![owner_account_id, scope_kind.as_str(), scope_id, role],
        row_to_record,
    )
    .optional()
    .map_err(Into::into)
}

fn row_to_record(row: &Row<'_>) -> rusqlite::Result<ModelAssignmentRecord> {
    let scope_kind_raw: String = row.get(2)?;
    let scope_kind = AssignmentScopeKind::parse(&scope_kind_raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                error.to_string(),
            )),
        )
    })?;
    let scope_id_raw: String = row.get(3)?;
    Ok(ModelAssignmentRecord {
        assignment_id: row.get(0)?,
        owner_account_id: row.get(1)?,
        scope_kind,
        scope_id: (!scope_id_raw.is_empty()).then_some(scope_id_raw),
        role: row.get(4)?,
        provider_profile_id: row.get(5)?,
        model_id: row.get(6)?,
        assignment_revision: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn normalized_identifier(value: &str, label: &str) -> Result<String> {
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

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentmesh360::provider_profiles::{
        ProviderAuthKind, ProviderProfileInput, ProviderProfileStore, ProviderProtocol,
    };

    fn profile(store: &ProviderProfileStore, owner: i64, profile_id: &str, name: &str) {
        store
            .insert(
                owner,
                profile_id,
                &format!("credential://vault/h_{}", Uuid::new_v4().simple()),
                "1234",
                &ProviderProfileInput {
                    preset_id: Some("openai".into()),
                    display_name: name.into(),
                    protocol: ProviderProtocol::OpenaiResponses,
                    base_url: "https://api.openai.com/v1".into(),
                    auth_kind: ProviderAuthKind::BearerApiKey,
                    enabled_models: vec![
                        "model-main".into(),
                        "global-model".into(),
                        "agent-model".into(),
                        "session-model".into(),
                        "main-session-model".into(),
                        "vision-global-model".into(),
                        "model-a".into(),
                        "model-b".into(),
                    ],
                }
                .normalized()
                .expect("valid profile"),
            )
            .expect("insert profile");
    }

    fn assignment(
        scope_kind: AssignmentScopeKind,
        scope_id: Option<&str>,
        profile_id: &str,
        model_id: &str,
    ) -> ModelAssignmentInput {
        ModelAssignmentInput {
            scope_kind,
            scope_id: scope_id.map(str::to_owned),
            role: "main".into(),
            provider_profile_id: profile_id.into(),
            model_id: model_id.into(),
        }
    }

    #[test]
    fn resolves_session_then_agent_then_global() {
        let temp = tempfile::tempdir().expect("tempdir");
        let profiles = ProviderProfileStore::in_home(temp.path());
        let assignments = ModelAssignmentStore::in_home(temp.path());
        profile(&profiles, 7, "pp_global", "Global");
        profile(&profiles, 7, "pp_agent", "Agent");
        profile(&profiles, 7, "pp_session", "Session");

        assignments
            .upsert(
                7,
                assignment(
                    AssignmentScopeKind::Global,
                    None,
                    "pp_global",
                    "global-model",
                ),
            )
            .expect("global");
        assignments
            .upsert(
                7,
                assignment(
                    AssignmentScopeKind::Agent,
                    Some("job-agent"),
                    "pp_agent",
                    "agent-model",
                ),
            )
            .expect("agent");
        assignments
            .upsert(
                7,
                assignment(
                    AssignmentScopeKind::Session,
                    Some("session-1"),
                    "pp_session",
                    "session-model",
                ),
            )
            .expect("session");

        assert_eq!(
            assignments
                .resolve(7, "main", Some("job-agent"), Some("session-1"))
                .expect("session assignment")
                .model_id,
            "session-model"
        );
        assert_eq!(
            assignments
                .resolve(7, "main", Some("job-agent"), Some("other-session"))
                .expect("agent assignment")
                .model_id,
            "agent-model"
        );
        assert_eq!(
            assignments
                .resolve(7, "main", Some("deploy-agent"), None)
                .expect("global assignment")
                .model_id,
            "global-model"
        );
    }

    #[test]
    fn auxiliary_role_prefers_its_full_scope_chain_then_falls_back_to_main() {
        let temp = tempfile::tempdir().expect("tempdir");
        let profiles = ProviderProfileStore::in_home(temp.path());
        let assignments = ModelAssignmentStore::in_home(temp.path());
        profile(&profiles, 7, "pp_main", "Main");
        profile(&profiles, 7, "pp_vision", "Vision");

        assignments
            .upsert(
                7,
                assignment(
                    AssignmentScopeKind::Session,
                    Some("session-1"),
                    "pp_main",
                    "main-session-model",
                ),
            )
            .expect("main session assignment");

        let fallback = assignments
            .resolve_with_main_fallback(7, "vision", Some("job-agent"), Some("session-1"))
            .expect("vision falls back to main");
        assert_eq!(fallback.role, "main");
        assert_eq!(fallback.model_id, "main-session-model");

        let mut vision = assignment(
            AssignmentScopeKind::Global,
            None,
            "pp_vision",
            "vision-global-model",
        );
        vision.role = "vision".into();
        assignments.upsert(7, vision).expect("vision assignment");

        let exact = assignments
            .resolve_with_main_fallback(7, "vision", Some("job-agent"), Some("session-1"))
            .expect("dedicated vision assignment");
        assert_eq!(exact.role, "vision");
        assert_eq!(exact.model_id, "vision-global-model");
        assert!(
            assignments
                .resolve_with_main_fallback(7, "memory", Some("job-agent"), Some("missing"))
                .is_err(),
            "an unrelated Session-scoped main Assignment must not cross Session identity"
        );
    }

    #[test]
    fn assignments_are_account_scoped_revisioned_and_cascade_with_profile() {
        let temp = tempfile::tempdir().expect("tempdir");
        let profiles = ProviderProfileStore::in_home(temp.path());
        let assignments = ModelAssignmentStore::in_home(temp.path());
        profile(&profiles, 7, "pp_owner", "Owner");
        profile(&profiles, 8, "pp_other", "Other");

        let created = assignments
            .upsert(
                7,
                assignment(AssignmentScopeKind::Global, None, "pp_owner", "model-a"),
            )
            .expect("create assignment");
        assert_eq!(created.assignment_revision, 1);
        assert!(
            assignments
                .upsert(
                    7,
                    assignment(
                        AssignmentScopeKind::Agent,
                        Some("job-agent"),
                        "pp_other",
                        "x"
                    ),
                )
                .is_err()
        );

        let unchanged = assignments
            .upsert(
                7,
                assignment(AssignmentScopeKind::Global, None, "pp_owner", "model-a"),
            )
            .expect("idempotent update");
        assert_eq!(unchanged.assignment_revision, 1);
        let changed = assignments
            .upsert(
                7,
                assignment(AssignmentScopeKind::Global, None, "pp_owner", "model-b"),
            )
            .expect("change assignment");
        assert_eq!(changed.assignment_revision, 2);
        assert!(assignments.list(8).expect("other account").is_empty());

        profiles.delete(7, "pp_owner").expect("delete profile");
        assert!(assignments.list(7).expect("assignments").is_empty());
    }

    #[test]
    fn assignment_rejects_a_model_not_enabled_by_the_selected_profile() {
        let temp = tempfile::tempdir().expect("tempdir");
        let profiles = ProviderProfileStore::in_home(temp.path());
        let assignments = ModelAssignmentStore::in_home(temp.path());
        profile(&profiles, 7, "pp_owner", "Owner");

        let error = assignments
            .upsert(
                7,
                assignment(
                    AssignmentScopeKind::Agent,
                    Some("job-agent"),
                    "pp_owner",
                    "invented-model",
                ),
            )
            .expect_err("model must come from the profile");

        assert!(
            error
                .to_string()
                .contains("model is not enabled for the selected provider profile")
        );
        assert!(assignments.list(7).expect("assignments").is_empty());
    }
}
