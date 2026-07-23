# 产品 Agent 辅助推理旁路审计与 D1d 接入计划

状态：持续审计，D1d0/D1d1/D1d2a/D1d2b 已实现，D1d2c 开发中

审计日期：2026-07-23

关联文档：

- [`CC_SWITCH_PROVIDER_RESEARCH.md`](./CC_SWITCH_PROVIDER_RESEARCH.md)
- [`ADR_PROVIDER_CONTROL_PLANE_VAULT.md`](./ADR_PROVIDER_CONTROL_PLANE_VAULT.md)
- [`../PROJECT_PROGRESS.md`](../PROJECT_PROGRESS.md)

## 1. 审计结论

D1c2 已经证明产品 Agent 的主 Prompt 可以在没有 Grok 登录的情况下，经过订阅门禁、
Session Binding、Credential Lease、SamplerActor 和 Turn Route 审计完成一次真实本机
Provider 请求。

但“主 Prompt 已绑定”不等于“产品 Agent 的所有推理都已绑定”。现有 Grok Harness 还存在
多类直接调用 `prepare_chat_completion`、`resolve_aux_sampler_config`、
`SamplingClient::new` 或向 subagent 复制默认 `sampling_config` 的辅助推理消费者。它们没有
经过 `ProductTurnRoute`，因此当前会出现两种结果：

1. 在 BYOK 产品 Session 没有 Grok 登录时调用失败，相关体验降级或中断；
2. 如果进程同时存在 Grok 凭据，未来可能静默使用 Grok 默认 Provider，违反用户选定的
   BYOK 路由，也使 Turn Route 审计不完整。

因此 D1d 的核心不是增加新的 Provider 协议，而是建立一个统一的 Session Sampling
Authority：产品 Session 的每一次 LLM 推理都必须由 Host 解析 Binding/Lease；普通 Grok
Session 继续使用原路径。

## 2. 不可破坏的约束

- Renderer、Agent Package、Skill 和客户端 `startupHints` 不能提供账户、Binding、Vault
  handle 或 credential；
- 产品 Session 不得回落到 Grok 默认 Provider，即使当前进程恰好存在 Grok 登录；
- Provider 请求实际使用的 endpoint、协议、Bearer/X-API-Key 和 model 必须与 Turn Route
  记录一致；
- Turn Route 只在 Sampling actor 接受请求后写入，准备失败和提交失败不能产生幽灵记录；
- 同一逻辑 Turn/role 的重试和 tool follow-up 复用不可变 Binding；
- 订阅失效、账户切换或 Vault 缺失时失败关闭，但不删除 Session 历史、Binding 或产物；
- 普通 Grok Session、现有 Harness 工具循环和 Grok 官方认证流程不受影响。

## 3. 调用点清单

| 优先级 | 消费者 | 现有入口 | 当前风险 | D1d 目标 |
| --- | --- | --- | --- | --- |
| P0 | 用户图片 | 当前模板 `is_cursor_harness() == false`，图片随 main 多模态请求；休眠 Cursor twin 为 `prompt_build::transcribe_user_images` → `resolve_aux_sampler_config` → `SamplingClient::new` | active 路径已受 main Binding 约束；未来若启用 Cursor twin，原实现会在主 Turn Route 前旁路采样 | active 路径固定为一条 main Turn Route；Cursor twin 使用 `vision` role，经统一 actor 接受和 Turn Route；无专用 Assignment 时回退 `main` Assignment |
| P0 | 自动权限分类 | `sampler_turn::wire_permission_auto_llm_classifier` → aux sampler / `prepare_chat_completion` | BYOK 无 Grok 登录时只能错误后退启发式；有 Grok 凭据时可能旁路用户 Provider | 使用 `permission_classifier` role；远端失败可回退本地启发式，但绝不换 Provider |
| P0 | 上下文压缩 | `compaction.rs`、`helpers/session_summary.rs` → `prepare_chat_completion` / `conversation_collect` | 持久 Session 越长越容易触发；旁路失败会使长期记忆体验退化 | 使用 `compaction` role；同一次压缩的 two-pass/single-pass 保持同一 Binding |
| P0 | Subagent 推理 | `mvp_agent::subagent_coordinator::build_subagent_spawn_context` 复制默认 `sampling_config`、AuthManager | 产品 Agent 能生成 subagent，但 subagent 没有产品 Binding/Lease，可能失败或走 Grok 默认路由 | 子 Agent 获得不可伪造的 Host 路由委托；默认使用 `subagent` role，缺省回退 `main` Assignment |
| P1 | Laziness 检测 | `acp_session_impl::laziness` → `prepare_chat_completion` | 可选质量检测在 BYOK 下失效或旁路 | 使用 `laziness` role；失败只跳过检测，不换 Provider |
| P1 | Recap/回顾 | `acp_session_impl::recap::handle_recap` 单次 collect | between-turn/background 推理未记录真实路由 | 使用 `recap` role和独立 synthetic turn id；失败保留原会话 |
| P1 | Memory dream | `acp_session_impl::memory_dream` 多处 collect/stream | 后台常驻 Agent 可能在用户不看窗口时旁路采样 | 使用 `memory` role和独立 synthetic turn id；订阅 Guard 每次重验 |
| P1 | `/btw` side question | `acp_session_impl::recap::handle_side_question` → direct collect | 用户可见的旁路问答可能使用 Grok 默认 Provider，且没有 Turn Route | 使用 `side_question` role和独立 synthetic turn id；缺省回退 main |
| P2 | AI shell command suggestion | `acp_session_impl::recap::handle_ai_suggest` → direct stream | 自动建议可能旁路 BYOK 路由 | 与 prompt suggestion 共用 `suggestion` role；失败保持现有无建议语义 |
| P2 | Prompt suggestion | `acp_session_impl::recap::handle_suggest_prompt` → direct collect | 自动建议可能旁路 BYOK 路由 | 使用 `suggestion` role；失败保持现有无建议语义 |
| P2 | Trace classifier | `trace_classifier` 直接 `SamplingClient::new` | 主要是诊断/上传分类，不一定属于产品 Session 的用户推理 | 先按调用来源隔离；只有绑定到产品 Session 的任务才纳入 Authority |

以下路径已经由 D1c1/D1c2 覆盖，不重复建设：主模型调用、tool follow-up、goal round、
completion recovery、401/compaction resubmit，以及 synthetic auto-wake 进入主 Prompt 时的
Sampling。

Web search、图片/视频生成和部署服务拥有不同的产品服务协议与计费边界，不应伪装成
通用 LLM Provider role；后续分别做服务级授权设计。

## 4. Role 与回退规则

首批稳定 role：

- `main`
- `vision`
- `permission_classifier`
- `compaction`
- `subagent`
- `laziness`
- `recap`
- `memory`
- `side_question`
- `suggestion`

Assignment 解析顺序保持 Session → Agent → Global，但辅助 role 增加一个明确、可审计的
缺省规则：

1. 先按辅助 role 执行 Session → Agent → Global；
2. 如果该 role 完全没有 Assignment，再按 `main` 执行 Session → Agent → Global；
3. 如果 `main` 也没有 Assignment，失败关闭；
4. 一旦为 `session + role` 创建 Binding，后续配置变化不得静默改变它；只能显式切换、
   兼容迁移或回滚。

这样用户只配置一次主模型就能使用完整产品，同时高级用户仍可为 vision、compaction 或
subagent 选择不同 Provider/model。

## 5. 统一执行边界

D1d 引入 Host 内部的 `SessionSamplingAuthority`，它不是新的 Sampling 实现，而是现有
SamplerActor 前的一层产品路由权限：

```text
产品 Session 消费者
  -> SessionSamplingAuthority.prepare(role, logical_turn_id)
  -> Access Guard + Assignment fallback + immutable Binding + Credential Lease
  -> existing SamplerActor accepts request with per-request config
  -> write non-secret Turn Route
  -> collect/stream existing Sampling events
```

普通 Session 仍直接使用现有 default config。产品 Session 的 Authority 只能由 MvpAgent
根据 Registry 注入，不通过 ACP serde 或 ToolContext JSON 传输。

对于同一用户 Prompt 内的辅助调用，`logical_turn_id` 使用主 prompt id，按不同 role 分别
形成至多一条 Turn Route；同 role 的重试复用 Active route。between-turn/background 调用
使用 `aux:<kind>:<uuid>`，并保留 parent session id。Subagent 使用 parent session、parent
turn 和 subagent invocation id 形成可追踪的逻辑 turn id。

## 6. 失败语义

| 类型 | 失败处理 |
| --- | --- |
| 主 Prompt、图片描述、必要压缩 | 返回结构化 `agentmesh360_provider_route_required`，保存用户输入与历史，不切换 Provider |
| 权限分类、laziness | 使用既有本地保守/启发式结果；记录非秘密降级原因，不调用其他 Provider |
| recap、memory dream | 跳过本次后台任务并保留待重试状态；订阅恢复后可再次执行 |
| side question、suggestion | 返回现有不可用/无建议结果；不切换 Provider，不修改主会话 |
| subagent | 拒绝该 subagent 启动并把原因返回父 Agent；父 Agent 可以继续主 Turn 或请求用户配置 |

## 7. D1d 实施顺序

### D1d0：Authority 契约与 role fallback

状态：**已实现（2026-07-23，`6b1de2d`）**

1. Model Assignment 已增加显式 auxiliary → main fallback，并返回实际采用的
   `assignmentRole`；
2. `AgentMeshSessionRouteContext` 已扩展为可按 role 准备 route 的 Host Authority；
3. Host `vision` 路由测试已固定产品 Session 只能得到 Binding/Lease 投影，不使用 Grok
   default config；
4. 既有提交状态机按 `session + role + logical turn` 保证重试幂等，不同 role 使用独立
   Binding 与 Turn Route。

### D1d1：Prompt 内 P0 消费者

状态：**已实现（2026-07-23，`7acc26f`、`a41b05b`、`1e1b705`）**

1. ~~审计 active 图片路径，并将休眠 Cursor twin 的 route 准备提前到图片描述之前，
   仍只在 actor 接受后写审计；~~ 已完成（`7acc26f`）
2. ~~图片描述与权限分类改经现有 SamplerActor side-query；必要压缩使用同一 actor 的
   side-query 收集语义；~~ 已完成
3. ~~覆盖有/无专用 role Assignment、Vault 丢失、订阅失效与重试不漂移。~~ 已完成

图片路径复核结论（2026-07-23）：当前构建并不执行独立图片描述，图片随 main 多模态
请求提交；Host E2E 已固定“一次 main Provider 请求、一条 main Turn Route、零 vision
幽灵记录”。Cursor twin 已接入 `vision` Authority，并通过不广播主事件的 SamplerActor
side-query 命令收集结果；该命令仍走现有 actor/HTTP/retry 栈，不创建常驻 actor 副本。

权限分类接入结论（2026-07-23）：产品 Session 每次分类都重新检查 Access Guard，并用
`permission_classifier` Binding/Lease 提交；成功后写该 role 的 Turn Route。失败只回退
既有本地保守/启发式分类，不调用 Grok default Provider。E2E 已覆盖 main Assignment
fallback、真实 Bearer/model、订阅失效和 Vault 丢失，失败路径零网络请求、零幽灵记录。
在 Host 尚未把 role capability 暴露给 Session 前，产品分类请求不继承 Grok session 的
`reasoning_effort`。

必要压缩接入结论（2026-07-23）：产品 Session 的 manual/auto、two-pass 与 single-pass
压缩统一使用 `compaction` Binding/Lease 和现有 SamplerActor；普通 Grok Session 保持
原直接采样路径。同一逻辑压缩的 pass/retry 共享非秘密 logical id，因此专用
`model-compact` 的退化重试只写一条 Turn Route；未配置专用 role 时可审计地回退 main。
Vault 丢失和订阅失效均在网络提交前失败并保留 Session。

### D1d2：后台消费者

状态：**开发中；D1d2a laziness（`9e84d75`）、D1d2b recap（`cc3020c`）已实现，
D1d2c memory 进行中**

1. ~~接入 laziness 与 recap；~~ 已完成。继续接入 memory dream；
2. 每次后台执行重新检查 Access Guard；
3. 使用 synthetic logical turn id 并验证 Session 历史不因失败被删除。

Laziness 接入结论（2026-07-23）：产品 Session 每次 classifier fire 使用独立
`aux:laziness:<uuid>`，由 `laziness` Binding/Lease 经现有 SamplerActor non-broadcast
side-query 提交；专用 role 与 main fallback 均已通过本机 Provider E2E。订阅失效与
Vault 丢失沿既有 `ClassifierError` 语义跳过检测，零网络、零幽灵 Route；普通 Session
仍走原 direct collect。

Recap 接入结论（2026-07-23）：真实 `handle_recap` 每次任务只有一次模型请求，并非
此前描述的多阶段调用。产品 Session 使用 `aux:recap:<uuid>` 和 `recap` Binding/Lease，
以实际 backend/model/context window 构建请求，再经既有 SamplerActor side-query 提交；
专用 role 与 main fallback 均已通过 E2E。订阅失效或 Vault 丢失时零网络、零幽灵 Route，
不推进 watermark、不修改 conversation，手动 spinner 仍按原协议清理。

持续审计修正（2026-07-23）：同一 `recap.rs` 的 `/btw`、AI shell command suggestion
和 prompt suggestion 是独立消费者，不能计入 recap 已完成范围。它们分别规划为
`side_question` 与 `suggestion` role，并在 D1d2d 收口。

### D1d2d：补充 Session 辅助消费者

1. `/btw` 使用 `side_question` Binding/Lease 与独立 synthetic id；
2. command/prompt suggestion 共用 `suggestion` role，保持失败时“不显示建议”的语义；
3. 三条路径都必须覆盖 main fallback、订阅/Vault 零网络和普通 Session 回归；
4. D1d2c memory 与本切片完成后再进入 D1d3。

### D1d3：Subagent 路由委托

1. 定义不可序列化、不可跨账户的 Host route delegation；
2. subagent Sampling 使用 `subagent` Binding/Lease，不复制 Grok 默认 credential；
3. 父/子调用可追踪，但不把 credential 或 Vault handle写入 ToolContext、日志或会话状态；
4. 真实 parent Prompt → tool call → subagent → Provider mock E2E 通过后，D1 才可整体关闭。

## 8. 非目标

- D1d 不实现 Provider 设置 UI、Probe、真实计费 Usage 或新协议；
- 不把 Web Search、图片生成、视频生成等专业服务强行纳入通用 LLM role；
- 不为每个产品 Agent 创建独立 Harness 进程；
- 不改变订阅硬门禁、账户隔离、持久 Main Session 或动态 Agent Package 的既定边界。
