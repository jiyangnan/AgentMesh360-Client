use std::time::{Duration, Instant};

use agent_client_protocol as acp;
use anyhow::{Context, Result, anyhow};
use chrono::{SecondsFormat, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;
use xai_grok_sampling_types::{ConversationItem, ConversationRequest};

use super::credential_lease::{CredentialLeaseResolver, prepare_ephemeral_probe};
use super::credential_vault::CredentialVault;
use super::model_assignments::ModelAssignmentStore;
use super::provider_catalog::{ProviderCatalog, ProviderClassification};
use super::provider_profiles::{
    ProviderProfileInput, ProviderProfileRecord, ProviderProfileStore, ProviderProtocol,
    normalize_model_id,
};

pub const PROVIDER_CONNECTION_TEST_METHOD: &str = "x.agentmesh360/providers/test-connection";
pub const PROVIDER_PROBE_RUN_METHOD: &str = "x.agentmesh360/providers/probes/run";
pub const PROVIDER_PROBE_LIST_METHOD: &str = "x.agentmesh360/providers/probes/list";
const MINIMAL_INFERENCE_TIMEOUT: Duration = Duration::from_secs(20);

pub fn handles(method: &str) -> bool {
    matches!(
        method,
        PROVIDER_CONNECTION_TEST_METHOD | PROVIDER_PROBE_RUN_METHOD | PROVIDER_PROBE_LIST_METHOD
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProbeLevel {
    LocalValidation,
    Metadata,
    MinimalInference,
}

impl ProviderProbeLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::LocalValidation => "local_validation",
            Self::Metadata => "metadata",
            Self::MinimalInference => "minimal_inference",
        }
    }

    fn may_incur_cost(self) -> bool {
        matches!(self, Self::MinimalInference)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProbeStatus {
    Passed,
    Failed,
    Unsupported,
    ConfirmationRequired,
}

impl ProviderProbeStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Unsupported => "unsupported",
            Self::ConfirmationRequired => "confirmation_required",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "passed" => Ok(Self::Passed),
            "failed" => Ok(Self::Failed),
            "unsupported" => Ok(Self::Unsupported),
            "confirmation_required" => Ok(Self::ConfirmationRequired),
            _ => anyhow::bail!("unsupported Provider Probe status"),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunProviderProbeRequest {
    profile_id: String,
    model_id: String,
    level: ProviderProbeLevel,
    #[serde(default)]
    confirm_paid_inference: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListProviderProbesRequest {
    profile_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestProviderConnectionRequest {
    profile: ProviderProfileInput,
    api_key: String,
    model_id: String,
    #[serde(default)]
    confirm_paid_inference: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeResult {
    pub probe_id: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub level: ProviderProbeLevel,
    pub status: ProviderProbeStatus,
    pub network_attempted: bool,
    pub may_incur_cost: bool,
    pub endpoint_classification: ProviderClassification,
    pub endpoint_origin: String,
    pub protocol: ProviderProtocol,
    pub assignment_count: usize,
    pub summary_code: String,
    pub summary_message: String,
    pub warnings: Vec<String>,
    pub started_at: String,
    pub completed_at: String,
    pub latency_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProbeResponse {
    probe: ProviderProbeResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProbesResponse {
    probes: Vec<ProviderProbeResult>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionTestResult {
    pub model_id: String,
    pub status: ProviderProbeStatus,
    pub network_attempted: bool,
    pub may_incur_cost: bool,
    pub endpoint_classification: ProviderClassification,
    pub endpoint_origin: String,
    pub protocol: ProviderProtocol,
    pub summary_code: String,
    pub summary_message: String,
    pub started_at: String,
    pub completed_at: String,
    pub latency_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConnectionTestResponse {
    connection_test: ProviderConnectionTestResult,
}

pub struct ProviderProbeService<V> {
    state_home: std::path::PathBuf,
    profiles: ProviderProfileStore,
    assignments: ModelAssignmentStore,
    catalog: ProviderCatalog,
    vault: V,
}

impl<V: CredentialVault + Clone> ProviderProbeService<V> {
    pub(super) fn in_home(state_home: impl Into<std::path::PathBuf>, vault: V) -> Self {
        let state_home = state_home.into();
        Self {
            profiles: ProviderProfileStore::in_home(&state_home),
            assignments: ModelAssignmentStore::in_home(&state_home),
            catalog: ProviderCatalog::builtin(),
            state_home,
            vault,
        }
    }

    async fn test_connection(
        &self,
        request: TestProviderConnectionRequest,
        require_access: &dyn Fn() -> Result<()>,
    ) -> Result<ProviderConnectionTestResult> {
        require_access()?;
        if !request.confirm_paid_inference {
            anyhow::bail!(
                "explicit confirmation is required because the connection test may incur Provider cost"
            );
        }
        let profile = request.profile.normalized()?;
        let model_id = normalize_model_id(&request.model_id)?;
        if !profile
            .enabled_models
            .iter()
            .any(|model| model == &model_id)
        {
            anyhow::bail!("connection test model is not enabled by the Provider Profile");
        }

        let started = Instant::now();
        let started_at = now();
        let endpoint_origin = endpoint_origin(&profile.base_url)?;
        let endpoint_classification =
            self.input_endpoint_classification(&profile, &endpoint_origin);
        let protocol = profile.protocol;
        let leased = prepare_ephemeral_probe(profile, &model_id, request.api_key)?;
        let client = leased
            .into_client()
            .context("prepare Provider connection test client")?;

        require_access()?;
        let request = minimal_inference_request(&model_id, "connection-test");
        let (status, summary_code, summary_message) = run_minimal_inference(client, request).await;
        Ok(ProviderConnectionTestResult {
            model_id,
            status,
            network_attempted: true,
            may_incur_cost: true,
            endpoint_classification,
            endpoint_origin,
            protocol,
            summary_code,
            summary_message,
            started_at,
            completed_at: now(),
            latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    async fn run(
        &self,
        owner_account_id: i64,
        request: RunProviderProbeRequest,
        require_access: &dyn Fn() -> Result<()>,
    ) -> Result<ProviderProbeResult> {
        require_access()?;
        let profile = self
            .profiles
            .get(owner_account_id, request.profile_id.trim())?;
        let model_id = request.model_id.trim();
        if !profile.enabled_models.iter().any(|model| model == model_id) {
            anyhow::bail!("Probe model is not enabled by the Provider Profile");
        }
        let started = Instant::now();
        let started_at = now();
        let endpoint_origin = endpoint_origin(&profile.base_url)?;
        let endpoint_classification = self.endpoint_classification(&profile, &endpoint_origin);
        let assignment_count = self
            .assignments
            .list(owner_account_id)?
            .into_iter()
            .filter(|assignment| {
                assignment.provider_profile_id == profile.profile_id
                    && assignment.model_id == model_id
            })
            .count();
        let mut warnings = Vec::new();
        if endpoint_classification == ProviderClassification::Custom {
            warnings.push("endpoint_not_catalog_verified".into());
        }
        if assignment_count == 0 {
            warnings.push("model_not_assigned".into());
        }

        let probe_id = format!("probe_{}", Uuid::new_v4().simple());
        let mut result = ProviderProbeResult {
            probe_id,
            provider_profile_id: profile.profile_id.clone(),
            model_id: model_id.to_owned(),
            level: request.level,
            status: ProviderProbeStatus::Passed,
            network_attempted: false,
            may_incur_cost: request.level.may_incur_cost(),
            endpoint_classification,
            endpoint_origin,
            protocol: profile.protocol,
            assignment_count,
            summary_code: String::new(),
            summary_message: String::new(),
            warnings,
            started_at,
            completed_at: String::new(),
            latency_ms: 0,
        };

        match request.level {
            ProviderProbeLevel::LocalValidation => {
                let resolver =
                    CredentialLeaseResolver::in_home(&self.state_home, self.vault.clone());
                match resolver.resolve_profile_probe(
                    owner_account_id,
                    &profile.profile_id,
                    model_id,
                ) {
                    Ok(_) => {
                        result.summary_code = "local_validation_passed".into();
                        result.summary_message =
                            "Profile, model, endpoint, protocol, and Vault credential are valid."
                                .into();
                    }
                    Err(_) => {
                        result.status = ProviderProbeStatus::Failed;
                        result.summary_code = "local_validation_failed".into();
                        result.summary_message =
                            "The saved Profile or Vault credential is unavailable.".into();
                    }
                }
            }
            ProviderProbeLevel::Metadata => {
                result.status = ProviderProbeStatus::Unsupported;
                result.summary_code = "metadata_probe_not_declared".into();
                result.summary_message =
                    "The current Provider Catalog does not declare a non-billing metadata probe."
                        .into();
            }
            ProviderProbeLevel::MinimalInference if !request.confirm_paid_inference => {
                result.status = ProviderProbeStatus::ConfirmationRequired;
                result.summary_code = "paid_inference_confirmation_required".into();
                result.summary_message =
                    "Explicit confirmation is required because this probe may incur Provider cost."
                        .into();
            }
            ProviderProbeLevel::MinimalInference => {
                require_access()?;
                let resolver =
                    CredentialLeaseResolver::in_home(&self.state_home, self.vault.clone());
                let leased = match resolver.resolve_profile_probe(
                    owner_account_id,
                    &profile.profile_id,
                    model_id,
                ) {
                    Ok(leased) => leased,
                    Err(_) => {
                        result.status = ProviderProbeStatus::Failed;
                        result.summary_code = "probe_credential_unavailable".into();
                        result.summary_message =
                            "The saved Provider credential is unavailable.".into();
                        return self.finish_and_record(owner_account_id, result, started);
                    }
                };
                let client = match leased.into_client() {
                    Ok(client) => client,
                    Err(_) => {
                        result.status = ProviderProbeStatus::Failed;
                        result.summary_code = "probe_client_unavailable".into();
                        result.summary_message =
                            "The Provider client could not be prepared.".into();
                        return self.finish_and_record(owner_account_id, result, started);
                    }
                };
                require_access()?;
                result.network_attempted = true;
                let request = minimal_inference_request(model_id, "provider-probe");
                let (status, summary_code, summary_message) =
                    run_minimal_inference(client, request).await;
                result.status = status;
                result.summary_code = summary_code;
                result.summary_message = summary_message;
            }
        }
        self.finish_and_record(owner_account_id, result, started)
    }

    fn finish_and_record(
        &self,
        owner_account_id: i64,
        mut result: ProviderProbeResult,
        started: Instant,
    ) -> Result<ProviderProbeResult> {
        result.completed_at = now();
        result.latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.record(owner_account_id, &result)?;
        Ok(result)
    }

    fn record(&self, owner_account_id: i64, result: &ProviderProbeResult) -> Result<()> {
        let warnings_json =
            serde_json::to_string(&result.warnings).context("serialize Provider Probe warnings")?;
        let latency_ms = i64::try_from(result.latency_ms).unwrap_or(i64::MAX);
        super::state::open(&self.state_home)?
            .execute(
                "INSERT INTO provider_probe_results (
                   probe_id, owner_account_id, provider_profile_id, model_id, level, status,
                   network_attempted, may_incur_cost, endpoint_classification, endpoint_origin,
                   protocol, assignment_count, summary_code, summary_message, warnings_json,
                   started_at, completed_at, latency_ms
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                   ?17, ?18
                 )",
                params![
                    result.probe_id,
                    owner_account_id,
                    result.provider_profile_id,
                    result.model_id,
                    result.level.as_str(),
                    result.status.as_str(),
                    result.network_attempted,
                    result.may_incur_cost,
                    classification_str(result.endpoint_classification),
                    result.endpoint_origin,
                    protocol_str(result.protocol),
                    i64::try_from(result.assignment_count).unwrap_or(i64::MAX),
                    result.summary_code,
                    result.summary_message,
                    warnings_json,
                    result.started_at,
                    result.completed_at,
                    latency_ms,
                ],
            )
            .context("record Provider Probe result")?;
        Ok(())
    }

    fn list(
        &self,
        owner_account_id: i64,
        profile_id: Option<&str>,
    ) -> Result<Vec<ProviderProbeResult>> {
        let conn = super::state::open(&self.state_home)?;
        let profile_id = profile_id.map(str::trim).filter(|value| !value.is_empty());
        let mut stmt = conn.prepare(
            "SELECT probe_id, provider_profile_id, model_id, level, status, network_attempted,
                    may_incur_cost, endpoint_classification, endpoint_origin, protocol,
                    assignment_count, summary_code, summary_message, warnings_json, started_at,
                    completed_at, latency_ms
             FROM provider_probe_results
             WHERE owner_account_id = ?1 AND (?2 IS NULL OR provider_profile_id = ?2)
             ORDER BY completed_at DESC, probe_id DESC LIMIT 100",
        )?;
        let rows = stmt.query_map(params![owner_account_id, profile_id], |row| {
            let level: String = row.get(3)?;
            let status: String = row.get(4)?;
            let endpoint_classification: String = row.get(7)?;
            let protocol: String = row.get(9)?;
            let assignment_count: i64 = row.get(10)?;
            let warnings_json: String = row.get(13)?;
            let latency_ms: i64 = row.get(16)?;
            Ok(ProviderProbeResult {
                probe_id: row.get(0)?,
                provider_profile_id: row.get(1)?,
                model_id: row.get(2)?,
                level: parse_level(&level).map_err(sql_conversion_error)?,
                status: ProviderProbeStatus::parse(&status).map_err(sql_conversion_error)?,
                network_attempted: row.get(5)?,
                may_incur_cost: row.get(6)?,
                endpoint_classification: parse_classification(&endpoint_classification)
                    .map_err(sql_conversion_error)?,
                endpoint_origin: row.get(8)?,
                protocol: parse_protocol(&protocol).map_err(sql_conversion_error)?,
                assignment_count: usize::try_from(assignment_count).unwrap_or_default(),
                summary_code: row.get(11)?,
                summary_message: row.get(12)?,
                warnings: serde_json::from_str(&warnings_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        13,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                started_at: row.get(14)?,
                completed_at: row.get(15)?,
                latency_ms: u64::try_from(latency_ms).unwrap_or_default(),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("read Provider Probe results")
    }

    fn endpoint_classification(
        &self,
        profile: &ProviderProfileRecord,
        endpoint_origin: &str,
    ) -> ProviderClassification {
        profile
            .preset_id
            .as_deref()
            .and_then(|preset_id| self.catalog.provider(preset_id))
            .filter(|preset| {
                preset.protocol == profile.protocol
                    && preset.auth_kind == profile.auth_kind
                    && preset
                        .allowed_endpoint_origins
                        .iter()
                        .any(|allowed| allowed == endpoint_origin)
            })
            .map_or(ProviderClassification::Custom, |preset| {
                preset.classification
            })
    }

    fn input_endpoint_classification(
        &self,
        profile: &ProviderProfileInput,
        endpoint_origin: &str,
    ) -> ProviderClassification {
        profile
            .preset_id
            .as_deref()
            .and_then(|preset_id| self.catalog.provider(preset_id))
            .filter(|preset| {
                preset.protocol == profile.protocol
                    && preset.auth_kind == profile.auth_kind
                    && preset
                        .allowed_endpoint_origins
                        .iter()
                        .any(|allowed| allowed == endpoint_origin)
            })
            .map_or(ProviderClassification::Custom, |preset| {
                preset.classification
            })
    }
}

pub async fn handle<V: CredentialVault + Clone>(
    service: &ProviderProbeService<V>,
    owner_account_id: i64,
    args: &acp::ExtRequest,
    require_access: &dyn Fn() -> Result<()>,
) -> crate::extensions::ExtResult {
    let result = match args.method.as_ref() {
        PROVIDER_CONNECTION_TEST_METHOD => {
            let request: TestProviderConnectionRequest = crate::extensions::parse_params(args)?;
            service
                .test_connection(request, require_access)
                .await
                .and_then(|connection_test| {
                    serde_json::to_value(ProviderConnectionTestResponse { connection_test })
                        .map_err(Into::into)
                })
        }
        PROVIDER_PROBE_RUN_METHOD => {
            let request: RunProviderProbeRequest = crate::extensions::parse_params(args)?;
            service
                .run(owner_account_id, request, require_access)
                .await
                .and_then(|probe| {
                    serde_json::to_value(ProviderProbeResponse { probe }).map_err(Into::into)
                })
        }
        PROVIDER_PROBE_LIST_METHOD => {
            let request: ListProviderProbesRequest = crate::extensions::parse_params(args)?;
            service
                .list(owner_account_id, request.profile_id.as_deref())
                .and_then(|probes| {
                    serde_json::to_value(ProviderProbesResponse { probes }).map_err(Into::into)
                })
        }
        other => Err(anyhow!(
            "unknown AgentMesh360 Provider Probe extension method: {other}"
        )),
    };
    crate::extensions::to_ext_response(result)
}

fn minimal_inference_request(model_id: &str, purpose: &str) -> ConversationRequest {
    ConversationRequest {
        items: vec![ConversationItem::user(
            "Reply with a short acknowledgement. Do not use tools.",
        )],
        model: Some(model_id.to_owned()),
        max_output_tokens: Some(16),
        temperature: Some(0.0),
        x_grok_req_id: Some(format!(
            "agentmesh360-{purpose}-{}",
            Uuid::new_v4().simple()
        )),
        ..ConversationRequest::default()
    }
}

async fn run_minimal_inference(
    client: xai_grok_sampler::SamplingClient,
    request: ConversationRequest,
) -> (ProviderProbeStatus, String, String) {
    match tokio::time::timeout(
        MINIMAL_INFERENCE_TIMEOUT,
        client.conversation_collect(request),
    )
    .await
    {
        Ok(Ok(response)) if !response.assistant_text().trim().is_empty() => (
            ProviderProbeStatus::Passed,
            "minimal_inference_responded".into(),
            "The selected model returned a non-empty response.".into(),
        ),
        Ok(Ok(_)) => (
            ProviderProbeStatus::Failed,
            "minimal_inference_empty_response".into(),
            "The Provider returned success without model text.".into(),
        ),
        Ok(Err(_)) => (
            ProviderProbeStatus::Failed,
            "minimal_inference_request_failed".into(),
            "The Provider rejected or failed the minimal inference request.".into(),
        ),
        Err(_) => (
            ProviderProbeStatus::Failed,
            "minimal_inference_timeout".into(),
            "The minimal inference request timed out.".into(),
        ),
    }
}

fn endpoint_origin(base_url: &str) -> Result<String> {
    let url = Url::parse(base_url).context("parse Provider Probe endpoint")?;
    if url.host_str().is_none() {
        anyhow::bail!("Provider Probe endpoint host is unavailable");
    }
    Ok(url.origin().ascii_serialization())
}

fn protocol_str(protocol: ProviderProtocol) -> &'static str {
    match protocol {
        ProviderProtocol::OpenaiResponses => "openai_responses",
        ProviderProtocol::OpenaiChat => "openai_chat",
        ProviderProtocol::AnthropicMessages => "anthropic_messages",
    }
}

fn classification_str(classification: ProviderClassification) -> &'static str {
    match classification {
        ProviderClassification::Official => "official",
        ProviderClassification::Aggregator => "aggregator",
        ProviderClassification::Gateway => "gateway",
        ProviderClassification::Custom => "custom",
        ProviderClassification::Local => "local",
    }
}

fn parse_classification(value: &str) -> Result<ProviderClassification> {
    match value {
        "official" => Ok(ProviderClassification::Official),
        "aggregator" => Ok(ProviderClassification::Aggregator),
        "gateway" => Ok(ProviderClassification::Gateway),
        "custom" => Ok(ProviderClassification::Custom),
        "local" => Ok(ProviderClassification::Local),
        _ => anyhow::bail!("unsupported Provider Probe endpoint classification"),
    }
}

fn parse_protocol(value: &str) -> Result<ProviderProtocol> {
    match value {
        "openai_responses" => Ok(ProviderProtocol::OpenaiResponses),
        "openai_chat" => Ok(ProviderProtocol::OpenaiChat),
        "anthropic_messages" => Ok(ProviderProtocol::AnthropicMessages),
        _ => anyhow::bail!("unsupported Provider Probe protocol"),
    }
}

fn parse_level(value: &str) -> Result<ProviderProbeLevel> {
    match value {
        "local_validation" => Ok(ProviderProbeLevel::LocalValidation),
        "metadata" => Ok(ProviderProbeLevel::Metadata),
        "minimal_inference" => Ok(ProviderProbeLevel::MinimalInference),
        _ => anyhow::bail!("unsupported Provider Probe level"),
    }
}

fn sql_conversion_error(error: anyhow::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )),
    )
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentmesh360::credential_vault::{
        CredentialRef, MemoryCredentialVault, SecretValue,
    };
    use crate::agentmesh360::model_assignments::{AssignmentScopeKind, ModelAssignmentInput};
    use crate::agentmesh360::provider_profiles::ProviderAuthKind;
    use crate::agentmesh360::provider_profiles::ProviderProfileInput;

    const ACCOUNT_ID: i64 = 41;
    const SECRET: &str = "sentinel-probe-secret-1234";

    fn setup(
        base_url: &str,
    ) -> (
        tempfile::TempDir,
        ProviderProbeService<MemoryCredentialVault>,
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let vault = MemoryCredentialVault::default();
        let credential_ref = CredentialRef::generate();
        vault
            .put(
                &credential_ref,
                &SecretValue::new(SECRET.into()).expect("secret"),
            )
            .expect("put credential");
        ProviderProfileStore::in_home(temp.path())
            .insert(
                ACCOUNT_ID,
                "pp_probe",
                credential_ref.as_str(),
                "1234",
                &ProviderProfileInput {
                    preset_id: None,
                    display_name: "Probe Provider".into(),
                    protocol: ProviderProtocol::OpenaiResponses,
                    base_url: base_url.into(),
                    auth_kind: ProviderAuthKind::BearerApiKey,
                    enabled_models: vec!["model-probe".into()],
                }
                .normalized()
                .expect("normalize profile"),
            )
            .expect("insert profile");
        ModelAssignmentStore::in_home(temp.path())
            .upsert(
                ACCOUNT_ID,
                ModelAssignmentInput {
                    scope_kind: AssignmentScopeKind::Global,
                    scope_id: None,
                    role: "main".into(),
                    provider_profile_id: "pp_probe".into(),
                    model_id: "model-probe".into(),
                },
            )
            .expect("assignment");
        let service = ProviderProbeService::in_home(temp.path(), vault);
        (temp, service)
    }

    fn request(level: ProviderProbeLevel, confirm_paid_inference: bool) -> RunProviderProbeRequest {
        RunProviderProbeRequest {
            profile_id: "pp_probe".into(),
            model_id: "model-probe".into(),
            level,
            confirm_paid_inference,
        }
    }

    #[tokio::test]
    async fn local_and_metadata_probes_are_zero_network_and_persist_non_secret_results() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let (_temp, service) = setup(&format!("http://{address}/v1"));

        let local = service
            .run(
                ACCOUNT_ID,
                request(ProviderProbeLevel::LocalValidation, false),
                &|| Ok(()),
            )
            .await
            .expect("local validation");
        let metadata = service
            .run(
                ACCOUNT_ID,
                request(ProviderProbeLevel::Metadata, false),
                &|| Ok(()),
            )
            .await
            .expect("metadata result");

        assert_eq!(local.status, ProviderProbeStatus::Passed);
        assert!(!local.network_attempted);
        assert_eq!(metadata.status, ProviderProbeStatus::Unsupported);
        assert!(!metadata.network_attempted);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "zero-network levels must not connect"
        );
        let history = service.list(ACCOUNT_ID, None).expect("probe history");
        assert_eq!(history.len(), 2);
        let serialized = serde_json::to_string(&history).expect("serialize history");
        assert!(!serialized.contains(SECRET));
        assert!(!serialized.contains("Reply with"));
    }

    #[tokio::test]
    async fn minimal_inference_requires_confirmation_before_network() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let (_temp, service) = setup(&format!("http://{address}/v1"));

        let result = service
            .run(
                ACCOUNT_ID,
                request(ProviderProbeLevel::MinimalInference, false),
                &|| Ok(()),
            )
            .await
            .expect("confirmation result");

        assert_eq!(result.status, ProviderProbeStatus::ConfirmationRequired);
        assert!(!result.network_attempted);
        assert!(result.may_incur_cost);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "unconfirmed inference must not connect"
        );
    }

    #[tokio::test]
    async fn unsaved_connection_test_requires_confirmation_and_persists_nothing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let temp = tempfile::tempdir().expect("tempdir");
        let service = ProviderProbeService::in_home(temp.path(), MemoryCredentialVault::default());
        let request = TestProviderConnectionRequest {
            profile: ProviderProfileInput {
                preset_id: None,
                display_name: "Unsaved Provider".into(),
                protocol: ProviderProtocol::OpenaiResponses,
                base_url: format!("http://{address}/v1"),
                auth_kind: ProviderAuthKind::BearerApiKey,
                enabled_models: vec!["model-probe".into()],
            },
            api_key: SECRET.into(),
            model_id: "model-probe".into(),
            confirm_paid_inference: false,
        };

        assert!(
            service
                .test_connection(request, &|| Ok(()))
                .await
                .expect_err("confirmation must be required")
                .to_string()
                .contains("explicit confirmation")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "unconfirmed connection test must not connect"
        );
        assert!(
            service
                .profiles
                .list(ACCOUNT_ID)
                .expect("profiles")
                .is_empty()
        );
        assert!(service.list(ACCOUNT_ID, None).expect("history").is_empty());
    }

    #[tokio::test]
    async fn confirmed_unsaved_connection_test_uses_ephemeral_secret_and_persists_nothing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).await.expect("read");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let text = String::from_utf8_lossy(&request);
                    let content_length = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or_default();
                    let header_end = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|index| index + 4)
                        .unwrap_or(request.len());
                    if request.len() >= header_end + content_length {
                        break;
                    }
                }
            }
            let completed = r#"{"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"model-probe","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}"#;
            let body = format!("data: {completed}\n\ndata: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.expect("write");
            String::from_utf8_lossy(&request).into_owned()
        });
        let temp = tempfile::tempdir().expect("tempdir");
        let service = ProviderProbeService::in_home(temp.path(), MemoryCredentialVault::default());

        let result = service
            .test_connection(
                TestProviderConnectionRequest {
                    profile: ProviderProfileInput {
                        preset_id: None,
                        display_name: "Unsaved Provider".into(),
                        protocol: ProviderProtocol::OpenaiChat,
                        base_url: format!("http://{address}/v1"),
                        auth_kind: ProviderAuthKind::BearerApiKey,
                        enabled_models: vec!["model-probe".into()],
                    },
                    api_key: SECRET.into(),
                    model_id: "model-probe".into(),
                    confirm_paid_inference: true,
                },
                &|| Ok(()),
            )
            .await
            .expect("connection test");
        let wire = server.await.expect("server");

        assert_eq!(result.status, ProviderProbeStatus::Passed);
        assert!(result.network_attempted);
        assert!(result.may_incur_cost);
        assert!(wire.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(
            wire.to_ascii_lowercase()
                .contains(&format!("authorization: bearer {SECRET}").to_ascii_lowercase())
        );
        assert!(wire.contains("\"model\":\"model-probe\""));
        assert!(
            service
                .profiles
                .list(ACCOUNT_ID)
                .expect("profiles")
                .is_empty()
        );
        assert!(service.list(ACCOUNT_ID, None).expect("history").is_empty());
        let serialized = serde_json::to_string(&result).expect("serialize result");
        assert!(!serialized.contains(SECRET));
        assert!(!serialized.contains("OK"));
    }

    #[tokio::test]
    async fn confirmed_minimal_inference_uses_only_the_selected_profile_lease() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).await.expect("read");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let text = String::from_utf8_lossy(&request);
                    let content_length = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or_default();
                    let header_end = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|index| index + 4)
                        .unwrap_or(request.len());
                    if request.len() >= header_end + content_length {
                        break;
                    }
                }
            }
            let completed = r#"{"type":"response.completed","sequence_number":0,"response":{"id":"resp_probe","object":"response","created_at":0,"status":"completed","model":"model-probe","output":[{"id":"msg_probe","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}}"#;
            let body = format!("data: {completed}\n\ndata: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.expect("write");
            String::from_utf8_lossy(&request).into_owned()
        });
        let (_temp, service) = setup(&format!("http://{address}/v1"));

        let result = service
            .run(
                ACCOUNT_ID,
                request(ProviderProbeLevel::MinimalInference, true),
                &|| Ok(()),
            )
            .await
            .expect("probe result");
        let wire = server.await.expect("server");

        assert_eq!(result.status, ProviderProbeStatus::Passed);
        assert!(result.network_attempted);
        assert!(result.may_incur_cost);
        assert!(wire.starts_with("POST /v1/responses HTTP/1.1"));
        assert!(
            wire.to_ascii_lowercase()
                .contains(&format!("authorization: bearer {SECRET}").to_ascii_lowercase())
        );
        assert!(wire.contains("\"model\":\"model-probe\""));
        let serialized =
            serde_json::to_string(&service.list(ACCOUNT_ID, Some("pp_probe")).expect("history"))
                .expect("serialize history");
        assert!(!serialized.contains(SECRET));
        assert!(!serialized.contains("OK"));
    }

    #[tokio::test]
    async fn access_failure_blocks_before_probe_network() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let (_temp, service) = setup(&format!("http://{address}/v1"));

        assert!(
            service
                .run(
                    ACCOUNT_ID,
                    request(ProviderProbeLevel::MinimalInference, true),
                    &|| anyhow::bail!("subscription unavailable"),
                )
                .await
                .expect_err("access must fail")
                .to_string()
                .contains("subscription unavailable")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "denied access must not connect"
        );
        assert!(service.list(ACCOUNT_ID, None).expect("history").is_empty());
    }
}
