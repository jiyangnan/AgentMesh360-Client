# Gemini 官方 OpenAI 兼容端点契约 Spike

状态：F0a 已完成；F0b 真实 Provider 契约与 thought state 仍未通过  
核验日期：2026-07-24

本文记录 Google Gemini 通过官方 OpenAI 兼容端点接入 AgentMesh360 Client 的事实、
本地实现、未验证项和 Catalog 准入结论。它不能被“某次请求返回了文本”替代；未来
升级模型、Sampling 类型或 Google 兼容层时，应重新运行本文定义的契约。

相关实现：

- [`test_provider_contracts.rs`](../../crates/codegen/xai-grok-shell/tests/test_provider_contracts.rs)；
- [`provider_contract_harness.rs`](../../crates/codegen/xai-grok-shell/tests/common/provider_contract_harness.rs)；
- [`provider_catalog.rs`](../../crates/codegen/xai-grok-shell/src/agentmesh360/provider_catalog.rs)；
- [`CC_SWITCH_PROVIDER_RESEARCH.md`](CC_SWITCH_PROVIDER_RESEARCH.md)。

## 1. 当前结论

截至 2026-07-24：

1. Google 官方文档确认 Gemini 提供 OpenAI Chat Completions 兼容端点，使用 Bearer
   API Key，并记录了 Streaming、Function Calling、Structured Output 和
   `reasoning_effort`；
2. Grok Build 现有 `ApiBackend::ChatCompletions` 能生成这些基础请求形状，本地 mock
   契约已通过；
3. 已增加可复用的 OpenAI Chat Provider Harness，以及双重显式 opt-in 的 Gemini
   真实测试入口；
4. 当前没有用户提供的 Gemini API Key，因此没有发起真实 Google 请求，也没有产生
   Provider 费用；
5. 更关键的是，当前 Chat Completions 类型不能保真保存并跨轮回传 Gemini thought
   signature，也不能发送 Google `extra_body`。对持久、多轮、带工具的产品 Agent，
   这是 Catalog 准入阻断项；
6. 因此 Gemini **尚未加入内置官方 Catalog**。用户仍可用自定义
   OpenAI Chat Compatible Profile 做自行承担风险的测试，但不能把它解释为
   AgentMesh360 已正式验证。

## 2. 官方协议事实

证据仅采用 Google 一手文档：

- [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)；
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)；
- [Gemini 3 Developer Guide](https://ai.google.dev/gemini-api/docs/gemini-3)。

### 2.1 端点与认证

官方 OpenAI 兼容 Base URL：

```text
https://generativelanguage.googleapis.com/v1beta/openai/
```

Chat Completions 端点：

```text
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
Authorization: Bearer <GEMINI_API_KEY>
Content-Type: application/json
```

这正好映射到现有：

- `ProviderProtocol::OpenAiChat`；
- `ApiBackend::ChatCompletions`；
- `AuthScheme::Bearer`。

官方页面当前示例使用 `gemini-3.6-flash`，但模型目录会变化。F0 不据此把任何模型 ID
硬编码进 Catalog；正式预设必须在真实契约当日重新确认模型及能力。

### 2.2 官方文档覆盖的能力

| 能力 | Google 官方状态 | 当前本地 Harness 状态 | 当前准入状态 |
| --- | --- | --- | --- |
| Bearer API Key | 已记录 | 请求 Header mock 已验证 | 基础通过 |
| Chat Completions | 已记录 | endpoint 组合与解析已验证 | 基础通过 |
| Streaming | 已记录 | SSE 文本收集已验证 | mock 通过，真实未测 |
| Function Calling | 已记录 | tool schema、auto choice、参数解析已验证 | mock 通过，真实未测 |
| Structured Output | 已记录 | strict JSON Schema 请求与 JSON 解析已验证 | mock 通过，真实未测 |
| `reasoning_effort` | 已记录并映射到 Gemini thinking 配置 | `low` 请求形状已验证 | mock 通过，真实未测 |
| Thought summary | 需 Google `extra_body` 开启 | 当前无 `extra_body` 通道 | 未支持 |
| Thought signature 跨轮回传 | 多轮推理连续性需要 | 当前 Chat 类型不保真 | **阻断** |
| Models list/retrieve | 已记录 | E3 Catalog 未声明免费 metadata | 本轮不自动调用 |
| OpenAI Responses | 官方兼容页未作为当前主路径记录 | 本轮不外推 | unknown |
| Gemini Native / Interactions | Google 推荐用于完整新能力 | 尚未实现 | 后置 Spike |

Google 将 OpenAI 兼容支持标为 beta，并建议不受 OpenAI SDK 约束的新应用优先使用
Gemini Direct API；当前文档顶部还推荐 Interactions API 获取最新功能和模型。因此
OpenAI 兼容路径适合作为 M1 的复用候选，但不能推导出它等价于 Gemini 全能力。

## 3. 为什么 thought signature 是持久 Agent 的硬门槛

Google 官方 thinking 文档说明：thought signature 是加密的模型内部推理状态，多轮
推理连续性需要它。客户端若采用无状态全历史请求，必须把收到的 thought block 和
signature 原样回传，不能修改或删除；某些内置工具的调用和结果也可能携带独立
signature。

AgentMesh360 的 Job Agent、LectureCast Agent 和 Deploy Agent 都是固定 Main Session
的持久产品 Agent，不是一次性聊天框。它们会：

- 多轮持续工作；
- 调用本地工具并回传 Tool Result；
- 休眠、恢复和重放 Session；
- 在压缩、记忆和子 Agent 后继续主会话。

因此只验证“首轮文本能返回”会制造高风险假阳性：短对话看起来可用，长任务或 Tool
Loop 才发生推理连续性丢失、400 错误或质量突降。这正是 Harness 契约必须高于普通
API Ping 的原因。

当前源码差距：

- `ChatCompletionRequest` 没有 Provider-specific `extra_body`；
- `ChatCompletionChunkDelta` / `ChatResponseMessage` 没有 Gemini thought signature
  字段；
- `AssistantItem` / `ToolCall` 没有可持久化、可原样回放的 signature；
- Chat 历史转换无法把 signature 放回下一轮请求。

在没有观察真实 Google wire shape 并建立 round-trip fixture 前，不应凭猜测添加字段，
也不应把 signature 塞进普通文本或未受约束的 JSON 扩展。

## 4. 已实现的 Provider Harness

`run_openai_chat_contract` 是 Provider-neutral 的真实 SamplingClient 契约，不直接手写
另一套 HTTP 客户端。它依次检查：

1. Streaming 文本非空；
2. Tool 定义能发出、模型能返回指定函数和合法 JSON 参数；
3. strict JSON Schema 能生成并解析指定结构；
4. `reasoning_effort=low` 能被发送且模型返回非空结果。

默认测试使用 `MockInferenceServer`，验证：

- 四次请求都只命中 `chat/completions`；
- Bearer Header 正确；
- `stream=true`；
- Tool、`tool_choice`、`response_format.json_schema.strict` 与
  `reasoning_effort` 的 wire shape；
- SSE、Tool Call 和 JSON 输出能由现有 Grok Sampling 数据面解析；
- Target 的 `Debug` 只输出 `credential_present`，不输出 BYOK Key。

这套 Harness 可复用于 DeepSeek、Kimi、GLM、Qwen、OpenRouter 等 OpenAI Chat
Compatible Provider。每个正式预设仍需自己的真实 Target、模型和能力证据。

默认零费用命令：

```bash
cargo test -p xai-grok-shell --test test_provider_contracts
```

预期结果为 3 项本地测试通过，1 项真实 Gemini 测试忽略。

## 5. 真实 Gemini 测试的安全入口

真实测试可能消耗用户的 Google 配额或费用，因此同时需要：

1. 测试本身被 `#[ignore]`；
2. `AGENTMESH360_GEMINI_CONTRACT=1` 显式授权；
3. 专用 `AGENTMESH360_GEMINI_API_KEY`；
4. 显式 `AGENTMESH360_GEMINI_MODEL`。

运行方式：

```bash
AGENTMESH360_GEMINI_CONTRACT=1 \
AGENTMESH360_GEMINI_API_KEY='<用户明确提供的测试 Key>' \
AGENTMESH360_GEMINI_MODEL='<当日确认的模型 ID>' \
cargo test -p xai-grok-shell --test test_provider_contracts \
  gemini_openai_chat_live_contract -- --ignored --exact
```

约束：

- 绝不自动读取 AgentMesh360 Provider Vault；
- 绝不复用机器上其他 Gemini/GCloud 环境秘密；
- 失败信息不得打印 Key；
- 当前每次完整运行最多发四个短请求，但具体账单仍由 Provider 决定；
- 即使四项基础真实契约通过，也不能绕过 thought signature round-trip 阻断。

## 6. Catalog 准入门

Gemini 官方预设只有同时满足以下条件才能加入内置 Catalog：

1. 真实 Streaming、Function Calling、Structured Output 与 Reasoning 契约通过；
2. 对真实 Gemini 3 Tool Loop 抓取脱敏 fixture，明确 signature 的响应和下一轮请求形状；
3. 实现 signature 在 stream decode → `ConversationItem` → Session persistence →
   history replay → 下一轮 request encode 的字节保真；
4. 重启 Session 后继续 Tool Loop 的真实契约通过；
5. 模型 ID、context window、output limit 和能力证据在加入当日重新核验；
6. Profile 保存仍保持零网络；真实 Probe 和契约测试仍需用户明确确认；
7. Catalog 能力只标记实测项，其他保持 `unknown`。

内置 Catalog 单元测试现已加入显式门禁：在上述条件未关闭前，出现 Google 官方
`generativelanguage.googleapis.com` 预设会使测试失败。

## 7. 后续实现建议

下一技术切片不应直接“加 Gemini 预设”，而应是 F0b：

1. 由用户明确提供仅用于契约测试的 Gemini Key 和模型；
2. 先运行当前四项基础真实契约，保存不含正文与秘密的结果；
3. 用最小真实 Tool Loop 捕获脱敏 wire fixture；
4. 设计 Provider Extension Envelope，范围只覆盖受审查的 request/response 扩展，
   不能变成任意 Agent 注入 JSON 的逃逸通道；
5. 为 thought signature 建立持久化和跨重启 round-trip 测试；
6. 复核兼容层是否足以支持产品 Main Session；若不足，再评估 Gemini
   Native/Interactions Adapter。

F0b 之前可以并行推进不依赖外部 Key 的切片 G：独立后台 Host、自启动、UI 重连与崩溃
恢复。它是所有持久产品 Agent 的共同价值，不应被单个 Provider 的外部凭据门槛阻塞。
