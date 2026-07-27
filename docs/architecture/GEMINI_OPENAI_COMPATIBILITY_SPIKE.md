# Gemini 官方 OpenAI 兼容端点契约 Spike

状态：F0b 实现、自主验证与本机 Kimi 独立交叉测试已完成
核验日期：2026-07-27

本文记录 Google Gemini 通过官方 OpenAI Chat 兼容端点进入 AgentMesh360 Client 的
真实契约、Provider thought state 设计、持久化边界、Catalog 准入证据和后续复验门。
“首轮能返回文本”不能替代本文的多轮 Tool Loop 契约。

相关实现：

- [`types.rs`](../../crates/codegen/xai-grok-sampling-types/src/types.rs)；
- [`conversation.rs`](../../crates/codegen/xai-grok-sampling-types/src/conversation.rs)；
- [`client.rs`](../../crates/codegen/xai-grok-sampler/src/client.rs)；
- [`chat_completions.rs`](../../crates/codegen/xai-grok-sampler/src/stream/chat_completions.rs)；
- [`provider_contract_harness.rs`](../../crates/codegen/xai-grok-shell/tests/common/provider_contract_harness.rs)；
- [`test_provider_contracts.rs`](../../crates/codegen/xai-grok-shell/tests/test_provider_contracts.rs)；
- [`provider_catalog.v1.json`](../../crates/codegen/xai-grok-shell/src/agentmesh360/provider_catalog.v1.json)。

## 1. F0b 结论

截至 2026-07-27，原 Catalog 七项准入门已经取得对应证据：

1. `gemini-3.5-flash-lite` 的真实 Streaming、Function Calling、Structured Output
   和 `reasoning_effort=low` 均通过现有 `SamplingClient`；
2. 真实 Tool Loop 的脱敏 wire 位置已经确认；
3. thought signature 已在 stream decode → `ConversationItem` → Session JSONL →
   history replay → request encode 中字节保真；
4. 两次真实请求之间执行序列化/反序列化模拟进程重启，恢复后的工具调用继续成功，
   第二轮严格返回 `tool-loop-ok`；
5. Google 当日官方模型页确认 Stable Model ID、1,048,576 输入上限和 65,536 输出
   上限；
6. Profile 保存、Catalog 浏览继续零网络；真实 Probe 和本契约仍需用户明确确认；
7. Catalog 只把真实测过的 Tools、Structured Output、Reasoning、Streaming 标为
   `supported`，Parallel Tool Calls 与 Vision 保持 `unknown`。

因此 `Google Gemini / gemini-3.5-flash-lite` 已满足加入内置声明式 Catalog 的条件。
这只说明 AgentMesh360 的 OpenAI Chat 主会话路径通过，不代表 Gemini Native、
Interactions、内置 Search/Maps/Computer Use 或全部多模态能力已经接入。

## 2. 官方协议与模型事实

证据只采用 Google 一手文档：

- [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)；
- [Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)；
- [Gemini 3.5 Flash-Lite 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)；
- [最新模型迁移说明](https://ai.google.dev/gemini-api/docs/latest-model)。

官方 OpenAI 兼容 Base URL 为：

```text
https://generativelanguage.googleapis.com/v1beta/openai
```

AgentMesh360 使用：

```text
POST /chat/completions
Authorization: Bearer <GEMINI_API_KEY>
```

对应现有 `ProviderProtocol::OpenaiChat`、`ApiBackend::ChatCompletions` 和
`AuthScheme::Bearer`。

2026-07-23 更新的官方模型页与最新模型说明确认：

- Model ID：`gemini-3.5-flash-lite`；
- 状态：GA / Stable；
- 输入上限：1,048,576 tokens；
- 输出上限：65,536 tokens；
- Function Calling、Structured Outputs 与 Thinking：官方支持；
- `temperature`、`top_p`、`top_k` 已弃用。产品路由保持这些参数为空，由 Provider
  使用默认采样；契约 Harness 也不再主动发送这些字段。

Catalog 不保存价格，也不把官方文档声明但本轮未真实执行的 Vision、Parallel Tool
Calls 等能力写成已验证。

## 3. 真实测试与请求预算

用户明确授权使用已保存测试 Key、指定 `gemini-3.5-flash-lite`，本轮最多 12 次短
请求，并同意可能消耗免费额度或产生 Provider 费用。

自主验证分为：

| 阶段 | 请求数 | 结果 |
| --- | ---: | --- |
| 四项基础真实契约 | 4 | Streaming、Function Calling、Structured Output、Reasoning 全部通过 |
| 脱敏 wire 定位 | 3 | 非流式工具响应、下一轮回放、流式工具响应位置确认 |
| 首次持久化 Tool Loop | 2 | 重启模拟与第二轮严格输出通过 |
| 最终代码 Tool Loop 复验 | 2 | 去除弃用采样参数后的同一契约复验 |
| 合计 | 11 / 12 | 剩余 1 次未使用 |

测试没有调用 Models list/retrieve，没有读取 AgentMesh360 Provider Vault，也没有自动
重试真实契约。Key 只从 macOS Keychain 注入测试子进程；Key 和真实 signature 值不
进入仓库、文档或测试输出。早期用于脱敏结构检查的 `/tmp` 原始响应必须在本轮收尾时
删除。

## 4. 脱敏 wire fixture

真实工具调用的 signature 位于工具调用本身：

```json
{
  "delta": {
    "tool_calls": [
      {
        "id": "call_<redacted>",
        "type": "function",
        "function": {
          "name": "report_marker",
          "arguments": "{\"marker\":\"agentmesh360-f0b\"}"
        },
        "extra_content": {
          "google": {
            "thought_signature": "<opaque>"
          }
        }
      }
    ]
  }
}
```

本次真实 SSE 的首个工具 chunk 未提供显式 `index`；现有类型按 OpenAI 兼容约定将其
安全默认成 `0`。下一轮请求必须把同一 signature 放回同一个 assistant tool call：

```json
{
  "role": "assistant",
  "tool_calls": [
    {
      "id": "call_<same>",
      "type": "function",
      "function": {
        "name": "report_marker",
        "arguments": "{\"marker\":\"agentmesh360-f0b\"}"
      },
      "extra_content": {
        "google": {
          "thought_signature": "<same opaque bytes>"
        }
      }
    }
  ]
}
```

工具结果之后的最终 assistant signature 位于 message-level
`delta.extra_content.google.thought_signature`，可能出现在没有正文的末尾 chunk。
因此 message state 和 per-tool-call state 不能共用一个最后写入值。

## 5. Provider Extension Envelope

F0b 没有增加任意 `extra_body: JSON` 逃逸通道，而是建立受限类型：

```text
ProviderExtensionEnvelope
└── google
    └── thought_signature: OpaqueThoughtSignature
```

约束：

1. 每个 signature 必须非空且不超过 16 KiB；
2. 序列化必须原样保留 UTF-8 bytes，不做 trim、重编码或规范化；
3. `Debug` 只显示 byte length，不显示值；
4. 未审核 Provider 或 Google 子字段在 decode 时忽略，且不会重新发送；
5. `AssistantProviderState` 分开保存 message extension 与
   `tool_call_id → extension` 有序映射；
6. 冲突 chunk、没有 Tool Call ID 的工具 signature 或同 ID 不同 signature 均使该
   stream 失败关闭；
7. Chat SSE 诊断只记录 payload byte length，反序列化错误也不打印原始 chunk。

## 6. 路由隔离与持久化

Conversation 可能比 Provider Profile 或模型选择存活更久，因此回放采用双门：

1. Base URL 必须精确匹配 HTTPS 官方 origin 与
   `/v1beta/openai` 路径；代理、自定义域、HTTP、userinfo、query、fragment 和其他
   path 均不允许 Google extension；
2. assistant `model_id` 必须与当前请求 model 完全一致。

非 Google Chat 路由会同时清除：

- 出站 message/tool-call provider extension；
- 入站 non-stream message/tool-call provider extension；
- 入站 streaming message/tool-call provider extension。

这避免自定义兼容端点伪造 Google state，也避免会话切换 Provider 或模型后把不透明
状态发送到错误数据接收方。

`AssistantItem.provider_state` 使用现有 `ConversationItem` JSONL 持久化，不建立第二
套 Session 数据库。旧 Session 缺少该字段时默认为空；本地真实存储适配器测试已经
覆盖“写入 JSONL—新实例加载—重新编码请求”。

## 7. 契约入口

默认零费用测试：

```bash
cargo test -p xai-grok-shell --test test_provider_contracts
```

真实基础契约每次四个短请求：

```bash
AGENTMESH360_GEMINI_CONTRACT=1 \
AGENTMESH360_GEMINI_API_KEY='<用户明确授权的测试 Key>' \
AGENTMESH360_GEMINI_MODEL='gemini-3.5-flash-lite' \
cargo test -p xai-grok-shell --test test_provider_contracts \
  gemini_openai_chat_live_contract -- --ignored --exact
```

真实持久化 Tool Loop 每次严格两个请求：

```bash
AGENTMESH360_GEMINI_CONTRACT=1 \
AGENTMESH360_GEMINI_API_KEY='<用户明确授权的测试 Key>' \
AGENTMESH360_GEMINI_MODEL='gemini-3.5-flash-lite' \
cargo test -p xai-grok-shell --test test_provider_contracts \
  gemini_google_thought_signature_live_contract -- --ignored --exact
```

真实入口继续保持 `#[ignore]` 与环境 gate；普通 `cargo test --ignored` 也不能在缺少
明确 opt-in 时产生费用。

## 8. Catalog 声明

内置 Catalog revision 从 1 升到 2，新增：

- Preset：`google-gemini`；
- Protocol：`openai_chat`；
- Auth：`bearer_api_key`；
- 官方 endpoint origin allowlist；
- Model：`gemini-3.5-flash-lite`；
- Context/Output：1,048,576 / 65,536；
- `tools/structuredOutput/reasoning/streaming = supported`；
- `parallelToolCalls/vision = unknown`。

Profile 保存仍不联网；用户必须明确提交 BYOK Key、创建 Assignment，并在显式 Probe
或真实对话时才调用 Provider。不存在静默 Provider fallback。

## 9. 复验条件与非目标

出现以下任一变化时，必须重新执行至少本地 fixture、JSONL restart 和两请求真实 Tool
Loop：

- Google 改变 OpenAI 兼容 signature 位置或字段名；
- Model ID、上下文或输出上限变化；
- Chat streaming/Conversation/Session storage 结构变化；
- Provider endpoint allowlist 或 Profile normalization 变化；
- Catalog 切换到新的 Gemini 模型。

本轮明确不实现：

- Gemini Native 或 Interactions Backend；
- Google 内置工具和完整多模态接入；
- 自动读取用户其他 Gemini/GCloud 凭据；
- 自动模型发现、自动真实 Probe 或自动计费请求；
- DeepSeek、Kimi、GLM、Qwen 等未经各自真实契约验证的正式预设；
- Scheduler、Subagent 产品面、Agent 专属 UI、Package H2d5 或生产发布。

F0b 关闭后，原产品计划的普通功能切片已经走到生产发布安全门前。R1-R6 仍未满足，
因此下一步只能先形成独立的生产准备/内部 canary 计划并等待单独授权，不能自动填入
生产 Root、endpoint、签名、公证或发布配置。

## 10. Kimi 独立交叉测试

Kimi CLI session `session_839105d3-70b3-4373-943c-8263c12bc8db` 只读审查完整
F0b diff、五份中文计划文档和全部安全边界，并独立执行：

- Types 279、Sampler 189、Chat State 339；
- 默认零费用 Provider 契约 3 pass / 2 个真实入口 ignored；
- JSONL restart 1/1、Catalog 4/4；
- 桌面 104 项为 101 pass、0 fail、3 个默认 real-host skip；
- Rustfmt、`git diff --check`、`npm run check` 与四组 Electron smoke。

它的新建完整 Shell target 达 18.8 GiB 后被主 Agent 为保护磁盘主动终止并清除；
该批次没有记录为成功或代码失败。Kimi 改用主 Agent 已构建的测试二进制完成上述
Provider/JSONL/Catalog 独立执行，并明确没有把仅由主 Agent 执行的完整 Shell 182 项
和 Clippy 冒充为自己的结果。

唯一 Low 是一个测试注释被机械新增字段污染，修复后同一 session 复核关闭。最终
Blocker/High/Medium/Low 全部为零并给出无条件 PASS；没有读取 Keychain、真实
signature 原始文件或调用任何真实 Provider。
