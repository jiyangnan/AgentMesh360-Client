# 官方 Provider 与动态模型发现 V1

更新时间：2026-07-30  
状态：已实现，等待本轮内部包验收

## 1. 产品结论

Provider 配置不应要求普通用户理解协议、认证 Header 或 Base URL。官方供应商统一采用：

```text
选择供应商
→ 输入该供应商的 API Key
→ Host 向官方模型目录验证 Key 并读取模型
→ 用户选择当前 Key 可见的模型
→ Host 发起一次最小真实推理
→ 成功后才允许保存 Profile 与 Key
```

“模型目录读取成功”和“模型真实可调用”是两个不同门：

- 模型目录读取不执行推理，通常不产生 Provider 推理费用；
- 连接测试调用用户选中的模型，可能产生极小 Provider 费用，必须再次明确确认；
- 只有两个门都通过，Renderer 才解锁“安全保存”；
- Key、供应商、协议、认证、地址或模型变化后，旧结果立即失效。

## 2. V1 官方供应商矩阵

| Preset | 用户看到的名称 | 协议 | 官方 Base URL | 模型目录 |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI | Responses | `https://api.openai.com/v1` | `GET /models` |
| `xai` | xAI | Responses | `https://api.x.ai/v1` | `GET /language-models` |
| `anthropic` | Anthropic | Messages | `https://api.anthropic.com/v1` | `GET /models` |
| `google-gemini` | Google Gemini | OpenAI Chat 兼容 | `https://generativelanguage.googleapis.com/v1beta/openai` | `GET /models` |
| `deepseek` | DeepSeek | OpenAI Chat 兼容 | `https://api.deepseek.com/v1` | `GET /models` |
| `glm` | 智谱 GLM API | OpenAI Chat 兼容 | `https://open.bigmodel.cn/api/paas/v4` | `GET /models` |
| `glm-coding-plan` | 智谱 GLM Coding Plan | OpenAI Chat 兼容 | `https://open.bigmodel.cn/api/coding/paas/v4` | `GET /models` |
| `kimi` | Kimi API（国际） | OpenAI Chat 兼容 | `https://api.moonshot.ai/v1` | `GET /models` |
| `kimi-cn` | Kimi API（中国） | OpenAI Chat 兼容 | `https://api.moonshot.cn/v1` | `GET /models` |
| `kimi-coding-plan` | Kimi Coding Plan | OpenAI Chat 兼容 | `https://api.kimi.com/coding/v1` | `GET /models` |

目录顺序只影响用户选择，不把任意兼容网关冒充官方端点。自定义、聚合和本地接口继续
留在“高级”分组，由用户手工填写模型 ID。

## 3. Coding Plan 专项处理

### 3.1 GLM Coding Plan

- Coding Plan 使用专属 OpenAI 兼容端点
  `https://open.bigmodel.cn/api/coding/paas/v4`；
- 个人或团队 Coding Plan Key 可能与普通智谱平台 Key 不通用；
- 客户端把普通 GLM API 与 GLM Coding Plan 拆成两个入口，避免用户选错地址；
- UI 明确提醒使用 Coding Plan 专属 Key；
- 套餐额度能否用于 AgentMesh360 Client，以智谱当时的官方支持工具和条款为准。

### 3.2 Kimi Coding Plan

- Coding Plan 使用专属端点 `https://api.kimi.com/coding/v1`；
- 官方稳定模型 ID 为 `kimi-for-coding` 与
  `kimi-for-coding-highspeed`；
- HighSpeed 需要相应会员等级，没有权限时官方会拒绝请求；
- Catalog 保留两个稳定 ID 作为能力声明，实际选择仍以当前 Key 的 `/models`
  返回为准；
- 套餐权益能否用于 AgentMesh360 Client，以 Kimi 当时的官方支持工具和条款为准。

这两个预设提供技术兼容能力，但客户端不得把“端点可连接”解释为“第三方产品已获得
套餐商业授权”。

## 4. Host 安全合同

模型发现只能在本机 Host 内执行：

1. Renderer 把 Key 一次性提交到 Main/Preload 的窄 IPC；
2. Provider Controller 校验 Profile、Key 长度和公开字段；
3. Host 再次检查订阅准入；
4. 仅允许 `classification=official`、协议/认证/Base URL 与内置可信 Catalog
   完全一致的 Profile 请求模型；
5. Key 进入 `SecretValue` 零化内存，只用于本次请求；
6. HTTP 禁止重定向，超时 12 秒，响应上限 1 MiB，模型上限 512；
7. 不写 Credential Vault、Provider Profile、Assignment、Session Binding、
   Turn Route 或 Probe history；
8. 不向 Renderer 返回 Header、原始错误正文、Key 或模型响应内容。

成功后只投影：

- 脱敏状态码；
- 是否验证身份；
- 模型 ID 与公开显示名；
- 是否截断；
- 官方 endpoint origin、耗时和时间戳。

## 5. 真实连接测试

模型发现后，连接测试继续复用 Grok Build Sampling Client：

- OpenAI/xAI 使用 Responses；
- Gemini、DeepSeek、GLM、Kimi 使用 Chat Completions；
- Anthropic 使用 Messages、`x-api-key`，并强制注入
  `anthropic-version: 2023-06-01`；
- 请求最多输出 16 tokens，不使用工具，不写 Agent 会话；
- 智谱官方文档确认 `glm-5.2` 默认开启思考，而 16-token 的连接测试可能只收到
  `reasoning_content`、来不及产生可见 `content`。因此只有经过 Catalog 复验的
  `glm` / `glm-coding-plan` 官方路由在测试 `glm-5.2` 时注入
  `reasoning_effort=none`；其他 Provider、其他 GLM 模型和自定义兼容端点不接收该
  专属参数；
- 测试结果区分 Key 被拒绝、权限不足、模型不存在、限流、网络、超时和空响应；
- 任何失败都保持保存按钮禁用。

## 6. 用户界面合同

- 官方供应商隐藏协议、认证和 Base URL，只显示“已自动配置”；
- Provider、名称、Key、模型控件高度至少 48px，输入字号至少 13px；
- 模型不是预填文本框，而是 Key 验证成功后才启用的单选框；
- 配置期间切屏、focus 复验或暂时离开不能重建表单或清空未保存 Key；
- 错误信息不得出现 `provider:get-snapshot`、`HostRequestError` 或 Electron
  remote method 文本；
- 保存后 Key 输入框立即清空，Renderer 无法读回 Vault 中的 Key。

## 7. 错误码

模型发现：

- `model_discovery_authentication_failed`
- `model_discovery_rate_limited`
- `model_discovery_endpoint_not_found`
- `model_discovery_provider_unavailable`
- `model_discovery_network_failed`
- `model_discovery_timeout`
- `model_discovery_invalid_response`
- `model_discovery_no_models`

最小推理：

- `minimal_inference_authentication_failed`
- `minimal_inference_permission_denied`
- `minimal_inference_model_not_found`
- `minimal_inference_rate_limited`
- `minimal_inference_network_failed`
- `minimal_inference_timeout`
- `minimal_inference_empty_response`

UI 根据稳定错误码给出中文行动建议，不依赖可能变化且可能包含敏感信息的原始正文。

## 8. 官方依据

- [OpenAI Models API](https://platform.openai.com/docs/api-reference/models/list)
- [xAI Models API](https://docs.x.ai/developers/rest-api-reference/inference/models)
- [Anthropic API overview](https://platform.claude.com/docs/en/api/overview)
- [Google Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [DeepSeek List Models](https://api-docs.deepseek.com/api/list-models/)
- [GLM Coding Plan 快速开始](https://docs.bigmodel.cn/cn/coding-plan/quick-start)
- [GLM 深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)
- [GLM 对话补全](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8)
- [Kimi API Overview](https://platform.kimi.ai/docs/api/overview)
- [Kimi List Models](https://platform.kimi.ai/docs/api/list-models)
- [Kimi Code membership guide](https://www.kimi.com/help/kimi-code/membership-guide)
- [Kimi Code third-party agents](https://www.kimi.com/help/kimi-code/third-party-agents)

## 9. 后续边界

V1 不做自动路由推荐、价格比较、余额读取、模型能力推断或无确认付费 Probe。模型能力
仍需 Catalog 声明或后续独立的 capability probe，不能仅凭 `/models` 出现某个 ID
就推断它支持工具、视觉、结构化输出或特定上下文长度。
