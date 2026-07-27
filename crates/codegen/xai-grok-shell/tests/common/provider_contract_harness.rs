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
    ConversationToolChoice, OpaqueThoughtSignature, ProviderExtensionEnvelope, ReasoningEffort,
    ToolSpec, conversation_item_to_chat_message,
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
        // Current Gemini 3.5+ models deprecate sampling parameters such as
        // temperature. The contract should exercise the product default
        // (provider-selected sampling) rather than send a soon-invalid field.
        config.temperature = None;
        config.top_p = None;
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleThoughtSignatureContractReport {
    pub provider: String,
    pub model: String,
    pub tool_signature_bytes: usize,
    pub final_message_signature_bytes: usize,
    pub restarted_tool_loop: bool,
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

/// Exercise Google's provider-specific thought-signature contract through the
/// same streaming `SamplingClient` path used by a persisted AgentMesh360
/// session.
///
/// The contract makes exactly two provider requests. Between them it
/// serializes and deserializes the first response as session JSON, then
/// replays the restored assistant tool call and its tool result. No signature
/// value is included in the report or error text.
pub async fn run_google_thought_signature_tool_loop_contract(
    target: &OpenAiChatContractTarget,
) -> Result<GoogleThoughtSignatureContractReport> {
    target.validate()?;
    let client = target.client()?;
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
    let user = ConversationItem::user(
        "Call report_marker exactly once with marker agentmesh360-f0b. \
         After its result is provided, reply with exactly: tool-loop-ok",
    );
    let first = collect(
        &client,
        "google_thought_signature_first_turn",
        ConversationRequest::from_items(vec![user.clone()])
            .with_tools(vec![tool.clone()])
            .with_tool_choice(ConversationToolChoice::Required)
            .with_max_output_tokens(64),
    )
    .await?;
    let first_assistant = first
        .assistant()
        .ok_or_else(|| anyhow!("first turn returned no assistant item"))?;
    let first_call = first_assistant
        .tool_calls
        .first()
        .ok_or_else(|| anyhow!("first turn returned no tool call"))?;
    if first_call.name != "report_marker" {
        bail!("first turn returned an unexpected tool");
    }
    let first_arguments: Value = serde_json::from_str(first_call.arguments.as_ref())
        .context("first turn returned invalid tool arguments")?;
    if first_arguments.get("marker").and_then(Value::as_str) != Some("agentmesh360-f0b") {
        bail!("first turn returned the wrong tool marker");
    }
    let original_extension = first_assistant
        .provider_state
        .tool_call(first_call.id.as_ref())
        .cloned()
        .ok_or_else(|| anyhow!("first turn omitted the tool thought signature"))?;
    let tool_signature_bytes = original_extension
        .thought_signature()
        .map(OpaqueThoughtSignature::len)
        .ok_or_else(|| anyhow!("first turn omitted the reviewed Google signature field"))?;
    let tool_call_id = first_call.id.to_string();

    let persisted =
        serde_json::to_vec(&first.items).context("serialize first turn for restart simulation")?;
    let restored_items: Vec<ConversationItem> = serde_json::from_slice(&persisted)
        .context("restore first turn after restart simulation")?;
    let restored_assistant = restored_items
        .iter()
        .find_map(|item| match item {
            ConversationItem::Assistant(assistant) => Some(assistant),
            _ => None,
        })
        .ok_or_else(|| anyhow!("restart simulation lost the assistant item"))?;
    let restored_extension = restored_assistant
        .provider_state
        .tool_call(&tool_call_id)
        .ok_or_else(|| anyhow!("restart simulation lost the tool thought signature"))?;
    if restored_extension != &original_extension {
        bail!("restart simulation changed the opaque tool thought signature");
    }
    let replay_message = conversation_item_to_chat_message(
        restored_items
            .iter()
            .find(|item| matches!(item, ConversationItem::Assistant(_)))
            .cloned()
            .ok_or_else(|| anyhow!("restart simulation lost replayable assistant state"))?,
    );
    let replayed_extension = replay_message
        .tool_calls
        .first()
        .and_then(|call| call.extra_content.as_ref())
        .ok_or_else(|| anyhow!("request conversion lost the tool thought signature"))?;
    if replayed_extension != &original_extension {
        bail!("request conversion changed the opaque tool thought signature");
    }

    let mut history = vec![user];
    history.extend(restored_items);
    history.push(ConversationItem::tool_result(
        tool_call_id,
        r#"{"accepted":true}"#,
    ));
    let second = collect(
        &client,
        "google_thought_signature_second_turn",
        ConversationRequest::from_items(history)
            .with_tools(vec![tool])
            .with_tool_choice(ConversationToolChoice::Auto)
            .with_max_output_tokens(64),
    )
    .await?;
    if second.assistant_text().trim() != "tool-loop-ok" {
        bail!("second turn did not return the exact completion marker");
    }
    let final_message_signature_bytes = second
        .assistant()
        .and_then(|assistant| assistant.provider_state.message.as_ref())
        .and_then(ProviderExtensionEnvelope::thought_signature)
        .map(OpaqueThoughtSignature::len)
        .ok_or_else(|| anyhow!("second turn omitted the final message thought signature"))?;

    Ok(GoogleThoughtSignatureContractReport {
        provider: target.name.clone(),
        model: target.model.clone(),
        tool_signature_bytes,
        final_message_signature_bytes,
        restarted_tool_loop: true,
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
