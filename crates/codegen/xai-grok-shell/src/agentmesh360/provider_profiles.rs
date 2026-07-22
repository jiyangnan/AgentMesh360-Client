use std::collections::HashSet;
use std::fmt;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{SecondsFormat, Utc};
use rusqlite::types::Type;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    OpenaiResponses,
    OpenaiChat,
    AnthropicMessages,
}

impl ProviderProtocol {
    fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiResponses => "openai_responses",
            Self::OpenaiChat => "openai_chat",
            Self::AnthropicMessages => "anthropic_messages",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "openai_responses" => Ok(Self::OpenaiResponses),
            "openai_chat" => Ok(Self::OpenaiChat),
            "anthropic_messages" => Ok(Self::AnthropicMessages),
            _ => bail!("unsupported provider protocol"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthKind {
    BearerApiKey,
    XApiKey,
}

impl ProviderAuthKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::BearerApiKey => "bearer_api_key",
            Self::XApiKey => "x_api_key",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "bearer_api_key" => Ok(Self::BearerApiKey),
            "x_api_key" => Ok(Self::XApiKey),
            _ => bail!("unsupported provider authentication kind"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfileInput {
    pub preset_id: Option<String>,
    pub display_name: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub auth_kind: ProviderAuthKind,
    #[serde(default)]
    pub enabled_models: Vec<String>,
}

impl ProviderProfileInput {
    pub fn normalized(mut self) -> Result<Self> {
        self.display_name = self.display_name.trim().to_owned();
        if self.display_name.is_empty() || self.display_name.chars().count() > 80 {
            bail!("provider display name must contain 1 to 80 characters");
        }

        self.preset_id = self
            .preset_id
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if self
            .preset_id
            .as_ref()
            .is_some_and(|value| value.chars().count() > 128)
        {
            bail!("provider preset id is too long");
        }

        let url = Url::parse(self.base_url.trim()).context("provider base URL is invalid")?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("provider base URL must use http or https");
        }
        if !url.username().is_empty() || url.password().is_some() {
            bail!("provider base URL must not contain credentials");
        }
        if url.query().is_some() || url.fragment().is_some() {
            bail!("provider base URL must not contain a query or fragment");
        }
        if url.host_str().is_none() {
            bail!("provider base URL must contain a host");
        }
        self.base_url = url.as_str().trim_end_matches('/').to_owned();

        let mut seen = HashSet::new();
        let mut models = Vec::with_capacity(self.enabled_models.len());
        for model in self.enabled_models {
            let model = model.trim().to_owned();
            if model.is_empty() || model.chars().count() > 200 {
                bail!("provider model ids must contain 1 to 200 characters");
            }
            if seen.insert(model.clone()) {
                models.push(model);
            }
        }
        if models.len() > 64 {
            bail!("a provider profile cannot enable more than 64 models");
        }
        self.enabled_models = models;
        Ok(self)
    }
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileRecord {
    pub profile_id: String,
    #[serde(skip_serializing)]
    pub owner_account_id: i64,
    pub preset_id: Option<String>,
    pub display_name: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub auth_kind: ProviderAuthKind,
    pub enabled_models: Vec<String>,
    pub route_revision: u64,
    pub credential_configured: bool,
    pub credential_last_four: String,
    #[serde(skip_serializing)]
    pub credential_ref: String,
    pub created_at: String,
    pub updated_at: String,
}

impl fmt::Debug for ProviderProfileRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderProfileRecord")
            .field("profile_id", &self.profile_id)
            .field("preset_id", &self.preset_id)
            .field("display_name", &self.display_name)
            .field("protocol", &self.protocol)
            .field("base_url", &self.base_url)
            .field("auth_kind", &self.auth_kind)
            .field("enabled_models", &self.enabled_models)
            .field("route_revision", &self.route_revision)
            .field("credential_configured", &self.credential_configured)
            .field("credential_last_four", &self.credential_last_four)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct ProviderProfileStore {
    state_home: PathBuf,
}

impl Default for ProviderProfileStore {
    fn default() -> Self {
        Self::in_home(super::state::default_state_home())
    }
}

impl ProviderProfileStore {
    pub fn in_home(state_home: impl Into<PathBuf>) -> Self {
        Self {
            state_home: state_home.into(),
        }
    }

    pub fn list(&self, owner_account_id: i64) -> Result<Vec<ProviderProfileRecord>> {
        let conn = super::state::open(&self.state_home)?;
        let mut stmt = conn.prepare(
            "SELECT profile_id, owner_account_id, preset_id, display_name, protocol, base_url, \
             auth_kind, enabled_models_json, route_revision, credential_last_four, \
             credential_ref, created_at, updated_at FROM provider_profiles \
             WHERE owner_account_id = ?1 ORDER BY display_name COLLATE NOCASE, profile_id",
        )?;
        let rows = stmt.query_map([owner_account_id], Self::row_to_record)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read AgentMesh360 provider profiles")
    }

    pub fn get(&self, owner_account_id: i64, profile_id: &str) -> Result<ProviderProfileRecord> {
        let conn = super::state::open(&self.state_home)?;
        conn.query_row(
            "SELECT profile_id, owner_account_id, preset_id, display_name, protocol, base_url, \
             auth_kind, enabled_models_json, route_revision, credential_last_four, \
             credential_ref, created_at, updated_at FROM provider_profiles \
             WHERE owner_account_id = ?1 AND profile_id = ?2",
            params![owner_account_id, profile_id],
            Self::row_to_record,
        )
        .optional()?
        .ok_or_else(|| anyhow!("provider profile not found"))
    }

    pub fn insert(
        &self,
        owner_account_id: i64,
        profile_id: &str,
        credential_ref: &str,
        credential_last_four: &str,
        input: &ProviderProfileInput,
    ) -> Result<ProviderProfileRecord> {
        let conn = super::state::open(&self.state_home)?;
        let now = now();
        let enabled_models =
            serde_json::to_string(&input.enabled_models).context("serialize provider model ids")?;
        conn.execute(
            "INSERT INTO provider_profiles (profile_id, owner_account_id, preset_id, \
             display_name, protocol, base_url, auth_kind, credential_ref, \
             credential_last_four, enabled_models_json, route_revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)",
            params![
                profile_id,
                owner_account_id,
                input.preset_id,
                input.display_name,
                input.protocol.as_str(),
                input.base_url,
                input.auth_kind.as_str(),
                credential_ref,
                credential_last_four,
                enabled_models,
                now,
            ],
        )
        .context("create AgentMesh360 provider profile")?;
        self.get(owner_account_id, profile_id)
    }

    pub fn update(
        &self,
        owner_account_id: i64,
        profile_id: &str,
        input: &ProviderProfileInput,
    ) -> Result<ProviderProfileRecord> {
        let current = self.get(owner_account_id, profile_id)?;
        let route_changed = current.preset_id != input.preset_id
            || current.protocol != input.protocol
            || current.base_url != input.base_url
            || current.auth_kind != input.auth_kind
            || current.enabled_models != input.enabled_models;
        let next_revision = current.route_revision + u64::from(route_changed);
        let enabled_models =
            serde_json::to_string(&input.enabled_models).context("serialize provider model ids")?;
        let conn = super::state::open(&self.state_home)?;
        let changed = conn.execute(
            "UPDATE provider_profiles SET preset_id = ?3, display_name = ?4, protocol = ?5, \
             base_url = ?6, auth_kind = ?7, enabled_models_json = ?8, route_revision = ?9, \
             updated_at = ?10 WHERE owner_account_id = ?1 AND profile_id = ?2",
            params![
                owner_account_id,
                profile_id,
                input.preset_id,
                input.display_name,
                input.protocol.as_str(),
                input.base_url,
                input.auth_kind.as_str(),
                enabled_models,
                next_revision,
                now(),
            ],
        )?;
        if changed != 1 {
            bail!("provider profile not found");
        }
        self.get(owner_account_id, profile_id)
    }

    pub fn update_credential_metadata(
        &self,
        owner_account_id: i64,
        profile_id: &str,
        credential_last_four: &str,
    ) -> Result<ProviderProfileRecord> {
        let conn = super::state::open(&self.state_home)?;
        let changed = conn.execute(
            "UPDATE provider_profiles SET credential_last_four = ?3, updated_at = ?4 \
             WHERE owner_account_id = ?1 AND profile_id = ?2",
            params![owner_account_id, profile_id, credential_last_four, now()],
        )?;
        if changed != 1 {
            bail!("provider profile not found");
        }
        self.get(owner_account_id, profile_id)
    }

    pub fn delete(&self, owner_account_id: i64, profile_id: &str) -> Result<()> {
        let conn = super::state::open(&self.state_home)?;
        let changed = conn.execute(
            "DELETE FROM provider_profiles WHERE owner_account_id = ?1 AND profile_id = ?2",
            params![owner_account_id, profile_id],
        )?;
        if changed != 1 {
            bail!("provider profile not found");
        }
        Ok(())
    }

    fn row_to_record(row: &Row<'_>) -> rusqlite::Result<ProviderProfileRecord> {
        let protocol_raw: String = row.get(4)?;
        let auth_kind_raw: String = row.get(6)?;
        let models_raw: String = row.get(7)?;
        let protocol = ProviderProtocol::parse(&protocol_raw)
            .map_err(|error| conversion_message(4, error.to_string()))?;
        let auth_kind = ProviderAuthKind::parse(&auth_kind_raw)
            .map_err(|error| conversion_message(6, error.to_string()))?;
        let enabled_models = serde_json::from_str(&models_raw)
            .map_err(|error| conversion_error(7, Type::Text, error))?;
        Ok(ProviderProfileRecord {
            profile_id: row.get(0)?,
            owner_account_id: row.get(1)?,
            preset_id: row.get(2)?,
            display_name: row.get(3)?,
            protocol,
            base_url: row.get(5)?,
            auth_kind,
            enabled_models,
            route_revision: row.get(8)?,
            credential_configured: true,
            credential_last_four: row.get(9)?,
            credential_ref: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }
}

fn conversion_message(column: usize, message: String) -> rusqlite::Error {
    conversion_error(
        column,
        Type::Text,
        std::io::Error::new(std::io::ErrorKind::InvalidData, message),
    )
}

fn conversion_error(
    column: usize,
    source_type: Type,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, source_type, Box::new(error))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(display_name: &str, base_url: &str) -> ProviderProfileInput {
        ProviderProfileInput {
            preset_id: Some("openai".into()),
            display_name: display_name.into(),
            protocol: ProviderProtocol::OpenaiResponses,
            base_url: base_url.into(),
            auth_kind: ProviderAuthKind::BearerApiKey,
            enabled_models: vec!["model-main".into()],
        }
        .normalized()
        .expect("valid profile input")
    }

    #[test]
    fn profiles_are_account_scoped_and_do_not_serialize_credential_refs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ProviderProfileStore::in_home(temp.path());
        let record = store
            .insert(
                11,
                "profile-1",
                "credential://vault/h-secret-handle",
                "1234",
                &input("Personal OpenAI", "https://api.openai.com/v1/"),
            )
            .expect("insert profile");

        assert_eq!(store.list(11).expect("owner profiles"), [record.clone()]);
        assert!(store.list(12).expect("other owner profiles").is_empty());
        let json = serde_json::to_string(&record).expect("serialize response");
        assert!(!json.contains("h-secret-handle"));
        assert!(!json.contains("ownerAccountId"));
        assert!(json.contains("credentialLastFour"));
    }

    #[test]
    fn route_revision_changes_only_for_route_fields() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ProviderProfileStore::in_home(temp.path());
        store
            .insert(
                11,
                "profile-1",
                "credential://vault/h-1",
                "1234",
                &input("OpenAI", "https://api.openai.com/v1"),
            )
            .expect("insert profile");

        let renamed = store
            .update(
                11,
                "profile-1",
                &input("Renamed", "https://api.openai.com/v1"),
            )
            .expect("rename profile");
        assert_eq!(renamed.route_revision, 1);

        let rerouted = store
            .update(
                11,
                "profile-1",
                &input("Renamed", "https://gateway.example.com/v1"),
            )
            .expect("reroute profile");
        assert_eq!(rerouted.route_revision, 2);

        let rekeyed = store
            .update_credential_metadata(11, "profile-1", "5678")
            .expect("update key metadata");
        assert_eq!(rekeyed.route_revision, 2);
        assert_eq!(rekeyed.credential_last_four, "5678");
    }

    #[test]
    fn validation_rejects_credentials_in_base_urls() {
        let result = ProviderProfileInput {
            preset_id: None,
            display_name: "Unsafe".into(),
            protocol: ProviderProtocol::OpenaiChat,
            base_url: "https://token@example.com/v1".into(),
            auth_kind: ProviderAuthKind::BearerApiKey,
            enabled_models: Vec::new(),
        }
        .normalized();
        assert!(result.is_err());
    }
}
