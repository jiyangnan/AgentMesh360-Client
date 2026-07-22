# 持久化产品 Agent 架构

状态：基础实现完成，已接入 Host 订阅门禁
建立日期：2026-07-21
最近更新：2026-07-23

相关的产品结构、流程、Package、Provider 与信任边界图见：
[`PRODUCT_BLUEPRINT.md`](PRODUCT_BLUEPRINT.md)。CC Switch Provider 调研、Host Vault、
Session Binding 和实施顺序见：
[`CC_SWITCH_PROVIDER_RESEARCH.md`](CC_SWITCH_PROVIDER_RESEARCH.md)。
账户隔离与 Binding 迁移决策见：
[`ADR_ACCOUNT_SCOPED_SESSIONS_AND_BINDINGS.md`](ADR_ACCOUNT_SCOPED_SESSIONS_AND_BINDINGS.md)。

## 核心决策

AgentMesh360 将 Job Agent、LectureCast Agent、Deploy Agent 以及未来的第一方
Agent 视为由 Grok Build Harness 承载的持久化产品身份。它们不是一次性聊天 Session
的别名，也不是各自运行一份完整 Harness 的独立进程。

每个已激活的产品 Agent 拥有：

- 稳定的产品 `agent_id`；
- 确定性的 Main Session UUID；
- 保存在 Grok 既有 Session Store 中的持久主对话；
- 产品专属的 Grok `AgentDefinition`；
- 独立的本地工作目录；
- 存储在轻量本地 Registry 中的期望状态与运行状态。

顶层产品 Agent 可以调用 Grok subagent 完成边界清晰的任务，但 subagent 仍是临时
Worker，不能取代产品 Agent 的长期身份与固定主对话。

## Runtime 边界

Grok Build 继续负责 Agent Loop、Sampling 数据面、工具、权限、对话记录、压缩、记忆、
后台任务与 subagent 执行。AgentMesh360 增加产品身份、目录、激活、订阅准入、恢复、
常驻策略，以及目标 Provider Control Plane；后者只把 Profile/Vault/Binding 编译成
Grok 现有 Sampling 配置，不重写推理循环。

本地 Registry 位于 `~/.agentmesh360/state.db`。测试和受管安装可以通过
`AGENTMESH360_HOME` 覆盖根目录。Grok Session 数据仍使用上游 Session Store；
Registry 只引用稳定 UUID，不复制对话记录。

AgentMesh360 Core 的默认地址为 `https://api.agentmesh360.com`；本地开发可以通过
`AGENTMESH360_CORE_URL` 覆盖。该变量只允许改变服务地址，不改变 Core 返回的
`schema_version = 1` 契约与 Host 的失败关闭策略。

## 生命周期

1. 激活前，Agent 状态为 `inactive / available`。
2. 客户端用用户 JWT 调用 Core 的 `/v1/account/client-bootstrap`；Host 只接受 Core
   给出的最终 `can_enter_client`，不自行拼装订阅与 credits 结论。
3. 只有有效订阅或有效历史体验期才能列出和激活产品 Agent。激活时写入
   `desired_state = running`，创建工作目录，并创建或加载确定性的 Main Session。
4. 已激活的 Main Session 在客户端窗口断开后仍保持 pin；普通聊天与临时 subagent
   继续沿用 Grok 的有界 idle-unload 行为。
5. Harness 初始化时不再无条件恢复产品 Agent。Core 准入成功后，Host 才恢复所有
   `desired_state = running` 的 Agent，并重新 pin 它们。
6. 准入缺失、过期、暂停或 Core 无法验证时，Host 立即失败关闭并清除产品 Session
   的常驻 pin；本地 Registry 与对话数据继续保留，但不能加载、浏览或运行。
7. 恢复失败会记录为 `error`，不会删除持久 Session，也不会改变期望状态，后续有效
   bootstrap 可以重试。

Host 使用 Core 的 `server_time` 与 `period_end` 计算单调时钟截止点，避免客户端时钟
偏差导致越权；即使 UI 没有及时刷新，当前准入也不会超过服务端返回的会员周期。

## ACP 接口

当前客户端接口包括：

- `x.agentmesh360/account/bootstrap`，请求
  `{ "accessToken": "<AgentMesh360 user JWT>" }`；
- `x.agentmesh360/agents/list`；
- `x.agentmesh360/agents/activate`，请求
  `{ "agentId": "job-agent" }`。

bootstrap 成功响应会把 Core 的 snake_case 契约转换为 camelCase，并继续使用标准
Extension Result envelope。JWT 只存在于本次请求内存和 HTTPS Authorization Header
中，不写入 `state.db`、Grok Session、日志或错误消息。

未验证时，Host 返回 `agentmesh360_access_required`；订阅失效时返回
`agentmesh360_subscription_required` 以及 Core 原因码。除 Agent 目录外，Host 还会在
产品 Main Session 的新建、加载、Prompt 以及携带 `sessionId` 的扩展调用入口再次
检查准入，防止绕开 UI 直接调用底层 ACP。

## 当前实现边界

Core 契约、Host 强制执行和桌面身份外壳已经接通：桌面端已有邮箱密码登录、Refresh
Token 轮换、Electron `safeStorage` 加密保存、启动/聚焦/唤醒/定时重验、订阅拦截页和
官网跳转。这里的 `safeStorage` 服务于桌面身份 Token；Provider 切片 A 已另行实现由
Host 直接拥有的 macOS Keychain `CredentialVault` 与非秘密 Profile Store，两者不是
同一个凭据通道。Provider 切片 B/C 已继续实现声明式 Catalog、Capability、三层
Model Assignment、非秘密 RouteCompiler、账户隔离的不可变 Session Binding 和 Turn
Route 可信存储接口；D0 已完成现有 Harness 的凭据诊断安全加固，D1a 已完成 Host
Credential Lease 与三协议无网络投影。Turn 写入尚未接到产品 Session Sampling，D1b
正在固化提交协调器与失败/幂等时序，Provider UI 和真实推理接入仍未实现。

当前 Grok Host 仍由 Electron 通过 ACP stdio 作为子进程启动，应用退出时会停止。
因此“窗口关闭后后台 Agent 继续在线、系统登录自启、UI 重连同一 Host、崩溃恢复”和
Host 独立访问 Provider Vault 仍属于目标能力。独立 Host/Supervisor 完成前，不能把
产品状态描述为已经达到最终的“激活即长期在线”。

## 上游同步规则

AgentMesh360 代码集中在 `xai-grok-shell::agentmesh360`。与上游的集成点只包括模块
导出、ACP 分发、`MvpAgent` 状态、Session 创建 / 加载 / Prompt 门禁、活动可见性和
idle eviction。保持这条窄接缝，可以在显式合并或 rebase 上游 Grok Build 更新时清楚
审查差异，同时让产品状态与商业契约继续由本 Fork 管理。
