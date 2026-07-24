//! Reusable, provider-neutral contract checks for OpenAI Chat compatible APIs.
//!
//! The harness deliberately exercises only the public `SamplingClient` path
//! used by AgentMesh360 sessions. A provider does not qualify for the Catalog
//! merely because a hand-written HTTP request succeeds.

use std::fmt;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::time::timeout;
use xai_grok_shell::sampling::{
    ApiBackend, Client, ConversationItem, ConversationRequest, ConversationResponse,
    ConversationToolChoice, ReasoningEffort, ToolSpec,
};

use super::test_sampler_config;

const CONTRACT_TIMEOUT: Duration = Duration::from_secs(45);

/// Configuration for one live or mocked OpenAI Chat compatible provider.
///
/// The custom `Debug` implementation is intentional: test failures and CI
/// diagnostics must never print a BYOK credential.
#[derive(Clone)]
pub struct OpenAiChatContractTarget {
    pub name: String,
    pub base_url: String,
    pub model: String,
    api_key: String,
}

impl OpenAiChatContractTarget {
    pub fn new(
        name: impl Into<String>,
        base_url: impl Into<String>,
        model: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Result<Self> {
        let target = Self {
            name: name.into(),
            base_url: base_url.into(),
            model: model.into(),
            api_key: api_key.into(),
        };
        target.validate()?;
        Ok(target)
    }

    fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            bail!("provider contract target name is required");
        }
        if self.base_url.trim().is_empty() {
            bail!("provider contract base URL is required");
        }
        if self.model.trim().is_empty() {
            bail!("provider contract model is required");
        }
        if self.api_key.trim().is_empty() {
            bail!("provider contract API key is required");
        }
        Ok(())
    }

    fn client(&self) -> Result<Client> {
        let mut config = test_sampler_config(&self.base_url, ApiBackend::ChatCompletions, &[]);
        config.api_key = Some(self.api_key.clone());
        config.model = self.model.clone();
        config.max_completion_tokens = Some(96);
        config.temperature = Some(0.0);
        config.max_retries = Some(0);
        config.reasoning_effort = None;
        Client::new(config).context("construct OpenAI Chat contract client")
    }
}

impl fmt::Debug for OpenAiChatContractTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiChatContractTarget")
            .field("name", &self.name)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("credential_present", &!self.api_key.is_empty())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiChatContractReport {
    pub provider: String,
    pub model: String,
    pub streaming_text: bool,
    pub function_calling: bool,
    pub structured_output: bool,
    pub reasoning_effort: bool,
}

/// Exercise the minimum transport contract needed by the current AgentMesh360
/// Chat harness.
///
/// This function can call a real provider and may therefore incur provider
/// cost. Callers are responsible for placing it behind an explicit opt-in
/// gate. It does not test provider-specific opaque reasoning state; those
/// requirements need a separate lossless round-trip contract before Catalog
/// admission.
pub async fn run_openai_chat_contract(
    target: &OpenAiChatContractTarget,
) -> Result<OpenAiChatContractReport> {
    target.validate()?;
    let client = target.client()?;

    let text = collect(
        &client,
        "streaming_text",
        ConversationRequest::from_items(vec![ConversationItem::user(
            "Reply with exactly: agentmesh360-contract-ok",
        )])
        .with_max_output_tokens(48),
    )
    .await?;
    if text.assistant_text().trim().is_empty() {
        bail!("streaming_text returned no assistant text");
    }

    let tool = ToolSpec {
        name: "report_marker".to_string(),
        description: Some("Report the required contract marker.".to_string()),
        parameters: json!({
            "type": "object",
            "properties": {
                "marker": {"type": "string"}
            },
            "required": ["marker"],
            "additionalProperties": false
        }),
    };
    let called = collect(
        &client,
        "function_calling",
        ConversationRequest::from_items(vec![ConversationItem::user(
            "Call report_marker once with marker agentmesh360. Do not answer normally.",
        )])
        .with_tools(vec![tool])
        .with_tool_choice(ConversationToolChoice::Auto)
        .with_max_output_tokens(64),
    )
    .await?;
    let tool_call = called
        .tool_calls()
        .first()
        .ok_or_else(|| anyhow!("function_calling returned no tool call"))?;
    if tool_call.name != "report_marker" {
        bail!(
            "function_calling returned unexpected tool {}",
            tool_call.name
        );
    }
    let arguments: Value = serde_json::from_str(tool_call.arguments.as_ref())
        .context("function_calling returned invalid JSON arguments")?;
    if arguments.get("marker").and_then(Value::as_str) != Some("agentmesh360") {
        bail!("function_calling returned the wrong contract marker");
    }

    let structured = collect(
        &client,
        "structured_output",
        ConversationRequest::from_items(vec![ConversationItem::user(
            "Return the requested contract status.",
        )])
        .with_json_schema(json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["agentmesh360-contract-ok"]
                }
            },
            "required": ["status"],
            "additionalProperties": false
        }))
        .with_max_output_tokens(64),
    )
    .await?;
    let structured_value: Value = serde_json::from_str(structured.assistant_text().trim())
        .context("structured_output returned invalid JSON")?;
    if structured_value.get("status").and_then(Value::as_str) != Some("agentmesh360-contract-ok") {
        bail!("structured_output returned the wrong contract status");
    }

    let mut reasoning_request = ConversationRequest::from_items(vec![ConversationItem::user(
        "Reply with exactly: reasoning-contract-ok",
    )])
    .with_max_output_tokens(64);
    reasoning_request.reasoning_effort = Some(ReasoningEffort::Low);
    let reasoning = collect(&client, "reasoning_effort", reasoning_request).await?;
    if reasoning.assistant_text().trim().is_empty() {
        bail!("reasoning_effort returned no assistant text");
    }

    Ok(OpenAiChatContractReport {
        provider: target.name.clone(),
        model: target.model.clone(),
        streaming_text: true,
        function_calling: true,
        structured_output: true,
        reasoning_effort: true,
    })
}

async fn collect(
    client: &Client,
    capability: &'static str,
    request: ConversationRequest,
) -> Result<ConversationResponse> {
    timeout(CONTRACT_TIMEOUT, client.conversation_collect(request))
        .await
        .with_context(|| format!("{capability} timed out"))?
        .map_err(|error| anyhow!("{capability} failed: {error}"))
}
