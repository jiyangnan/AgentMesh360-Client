//! AgentMesh360 Provider Catalog admission contracts.
//!
//! Default execution is local and zero-cost. The real Gemini check is ignored
//! and also requires an explicit environment gate, so `cargo test --ignored`
//! cannot accidentally spend a user's BYOK credit.

use serde_json::{Value, json};
use xai_grok_test_support::{MockInferenceServer, ScriptedResponse, SseEvent};

mod common;

use common::provider_contract_harness::{OpenAiChatContractTarget, run_openai_chat_contract};

const GEMINI_OPENAI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/openai/";

fn text_stream(text: &str) -> Vec<SseEvent> {
    vec![
        SseEvent::data(
            json!({
                "id": "chatcmpl-contract",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "contract-model",
                "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "content": text},
                    "finish_reason": "stop"
                }]
            })
            .to_string(),
        ),
        SseEvent::data(
            json!({
                "id": "chatcmpl-contract",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "contract-model",
                "choices": [],
                "usage": {
                    "prompt_tokens": 8,
                    "completion_tokens": 4,
                    "total_tokens": 12
                }
            })
            .to_string(),
        ),
        SseEvent::data("[DONE]"),
    ]
}

fn tool_stream() -> Vec<SseEvent> {
    vec![
        SseEvent::data(
            json!({
                "id": "chatcmpl-contract-tool",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "contract-model",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "role": "assistant",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_contract",
                            "type": "function",
                            "function": {
                                "name": "report_marker",
                                "arguments": "{\"marker\":\"agentmesh360\"}"
                            }
                        }]
                    },
                    "finish_reason": null
                }]
            })
            .to_string(),
        ),
        SseEvent::data(
            json!({
                "id": "chatcmpl-contract-tool",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "contract-model",
                "choices": [{
                    "index": 0,
                    "delta": {},
                    "finish_reason": "tool_calls"
                }],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 6,
                    "total_tokens": 18
                }
            })
            .to_string(),
        ),
        SseEvent::data("[DONE]"),
    ]
}

#[tokio::test]
async fn openai_chat_contract_is_reusable_and_zero_cost_by_default() {
    let server = MockInferenceServer::start().await.unwrap();
    let path = "/v1/chat/completions";
    server.enqueue_response(
        path,
        ScriptedResponse::sse(text_stream("agentmesh360-contract-ok")),
    );
    server.enqueue_response(path, ScriptedResponse::sse(tool_stream()));
    server.enqueue_response(
        path,
        ScriptedResponse::sse(text_stream("{\"status\":\"agentmesh360-contract-ok\"}")),
    );
    server.enqueue_response(
        path,
        ScriptedResponse::sse(text_stream("reasoning-contract-ok")),
    );

    let target =
        OpenAiChatContractTarget::new("mock-openai-chat", server.url(), "contract-model", "secret")
            .unwrap();
    let report = run_openai_chat_contract(&target).await.unwrap();

    assert!(report.streaming_text);
    assert!(report.function_calling);
    assert!(report.structured_output);
    assert!(report.reasoning_effort);
    assert_eq!(server.request_count(), 4);

    let requests = server.requests();
    assert!(
        requests
            .iter()
            .all(|request| request.path == "/v1/chat/completions")
    );
    assert!(
        requests
            .iter()
            .all(|request| request.header("authorization") == Some("Bearer secret"))
    );

    let bodies = server.request_bodies();
    assert!(bodies.iter().all(|body| body["stream"] == true));
    assert_eq!(bodies[1]["tools"][0]["function"]["name"], "report_marker");
    assert_eq!(bodies[1]["tool_choice"], "auto");
    assert_eq!(bodies[2]["response_format"]["type"], "json_schema");
    assert_eq!(
        bodies[2]["response_format"]["json_schema"]["strict"],
        Value::Bool(true)
    );
    assert_eq!(bodies[3]["reasoning_effort"], "low");
}

#[test]
fn gemini_openai_endpoint_matches_official_chat_compatibility_shape() {
    assert_eq!(
        format!(
            "{}/chat/completions",
            GEMINI_OPENAI_BASE_URL.trim_end_matches('/')
        ),
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
}

#[test]
fn contract_target_debug_output_redacts_byok_credential() {
    let target = OpenAiChatContractTarget::new(
        "debug-redaction",
        "https://provider.invalid/v1",
        "model",
        "super-secret-provider-key",
    )
    .unwrap();
    let debug = format!("{target:?}");
    assert!(debug.contains("credential_present"));
    assert!(!debug.contains("super-secret-provider-key"));
}

#[tokio::test]
#[ignore = "requires explicit Gemini BYOK opt-in and may consume provider credit"]
async fn gemini_openai_chat_live_contract() {
    assert_eq!(
        std::env::var("AGENTMESH360_GEMINI_CONTRACT").as_deref(),
        Ok("1"),
        "set AGENTMESH360_GEMINI_CONTRACT=1 to authorize a real, potentially billed contract run"
    );
    let api_key = std::env::var("AGENTMESH360_GEMINI_API_KEY")
        .expect("AGENTMESH360_GEMINI_API_KEY is required");
    let model =
        std::env::var("AGENTMESH360_GEMINI_MODEL").expect("AGENTMESH360_GEMINI_MODEL is required");
    let target =
        OpenAiChatContractTarget::new("gemini", GEMINI_OPENAI_BASE_URL, model, api_key).unwrap();

    let report = run_openai_chat_contract(&target).await.unwrap();
    assert!(report.streaming_text);
    assert!(report.function_calling);
    assert!(report.structured_output);
    assert!(report.reasoning_effort);
}
