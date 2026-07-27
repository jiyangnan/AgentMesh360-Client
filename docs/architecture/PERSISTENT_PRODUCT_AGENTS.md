# 持久化产品 Agent 架构

状态：基础实现完成，已接入 Host 订阅门禁和多 Agent 桌面对话恢复通路
建立日期：2026-07-21
最近更新：2026-07-27

相关的产品结构、流程、Package、Provider 与信任边界图见：
[`PRODUCT_BLUEPRINT.md`](PRODUCT_BLUEPRINT.md)。CC Switch Provider 调研、Host Vault、
Session Binding 和实施顺序见：
[`CC_SWITCH_PROVIDER_RESEARCH.md`](CC_SWITCH_PROVIDER_RESEARCH.md)。
账户隔离与 Binding 迁移决策见：
[`ADR_ACCOUNT_SCOPED_SESSIONS_AND_BINDINGS.md`](ADR_ACCOUNT_SCOPED_SESSIONS_AND_BINDINGS.md)。
后台 Host 的 ownership、socket/lock、attach/detach 和版本策略见：
[`ADR_BACKGROUND_HOST_LIFECYCLE.md`](ADR_BACKGROUND_HOST_LIFECYCLE.md)。

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
远端 Agent Package 签名文档使用更窄的时间门禁：成功 bootstrap 后以 `server_time`
为锚、只用 `Instant` 推进，最多新鲜 10 分钟且不超过会员剩余时间。`SystemTime`
仅用于检测超过 2 分钟的墙钟漂移、回退或休眠差异并失败关闭，不能推进可信时间。
Trust Bundle 与 Registry 验证都在当下重新检查 Access 仍 Granted；进程重启、
invalidate 或锚 stale 都必须重新 bootstrap。

远端 Package 信任元数据使用 `state.db` v9 的单行缓存：Trust Bundle 与 Registry
Snapshot 只能在同一个 `IMMEDIATE` 事务内验签、比较旧最高 sequence/revision 并原子
替换。低版本和同版本不同摘要都失败关闭；进程重启后必须用新的 Core 时间锚重新验签，
不能把“曾经验证过”当作永久有效。对外状态只包含 root、版本、有效期、Package 数量和
验证时间，不返回原始文档、URL、路径或账户数据。Registry 中的 Artifact/Envelope URL
不得携带 credentials、query 或 fragment；未来授权走内存 Header/短期 lease。

`state.db` v10 继续加入非秘密条件请求状态。Host 只从固定生产 HTTPS origin 获取
Trust Bundle 与 Registry，禁止重定向并限制连接/总超时和解码后响应字节；ETag 与
Last-Modified 只有在两份文档被 Trust Cache 接受后才更新。304 仍使用当前
`ClientAccess` 重新验签缓存原文，不延长签名有效期或 Core 时间锚。远端失败只能返回
脱敏 `last_known_good`/`unavailable` 原因；生产 endpoint/root 未发布前 Fetcher 保持
`disabled`，不会访问测试地址。

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
Credential Lease 与三协议投影，D1b 已固化 actor 接收后写 Turn Route 的提交协调器和
失败/幂等时序，D1c0 已保证同一 Turn 的 tool/retry 多次调用保持同一 Binding。该路径
D1c1 已以 Host 可信 Session Route Context 接到产品 Session 主 Prompt 推理边界，同时
覆盖用户 Prompt 和 synthetic auto-wake，并在 actor 接收后记录实际 Turn Route。D1c2
已经用无 Grok 登录的真实 Job Agent 激活和 Prompt 跑通 Host ACP mock 成功链，订阅、
账户、Assignment 与 Vault 失败矩阵也已通过。图片、权限分类、压缩、后台任务和 subagent
等辅助推理旁路已经按 D1d 统一 Authority 计划收口；其中 D1d0 已实现辅助 role 的 main
Assignment fallback、实际 assignment role 审计和 Host role-aware Authority；D1d1 已验证
当前模板的图片随 main 多模态 Binding 提交，并加固休眠 Cursor twin 的 `vision` 路由；
自动权限分类、必要压缩与产品 subagent 路由均已接入 Host-owned Binding。Provider
设置页、Assignment 和三档 Probe 已实现；需要用户凭据与费用授权的外部真实 Provider
E2E 仍未执行。

G0 已把默认运行方式从 `--no-leader` 改为 AgentMesh360 专属 socket 上的 Grok
Leader。Electron 只持有可丢弃的 ACP stdio Bridge：应用退出时 Bridge detach，
Leader、Registry 与固定 Main Session 继续存在；重新打开客户端后可采用同一 Leader，
真实 Host 测试已经验证 Job Agent 的 Main Session ID 不变。Leader 单实例、lock/PID、
`LeaderReady`、版本门槛和有界重连直接复用上游机制，不另建平行 Supervisor 协议。

G2 已实现打包客户端的主应用 Login Item 控制、无窗口后台启动、单实例前台唤醒和
“客户端设置”开关；后台主进程继续持有 Electron `safeStorage` 的 Refresh Token，
Rust Host 不获得该凭据。G1 已在 Bridge 仍运行时完成真实 Leader
`SIGKILL`、替代进程重建、Refresh Token 轮换、Core/Host 双重 bootstrap 与同一 Main
Session 恢复；失败不会沿用旧 Access Token。Grok Session Store 根目录也暂未切换，
避免未迁移就让现有对话不可见。当前源码可以描述为“系统登录后由无窗口主进程恢复
Host 与 Agent”，但签名、公证安装包中的 macOS Login Item 注册/批准/升级仍需发布
验收，不能把开发 smoke 写成生产已验证。

循环 43-45 已完成固定 Main Session 文本对话、多 Agent 通用化与标准 ACP 单次权限
确认。Renderer
继续只用 `agentId` 与文本，由主进程与 Host 解析账户绑定的 Main Session；标准 ACP
replay / live update 只投影有界的用户与 Agent 文本，本机路径、Session authority、
Provider 凭据、thought/tool/meta 和原始 Host 错误不暴露给页面。账户切换、订阅
失效、Host 不可用、Leader 重连和 Prompt 超时都会撤销临时 authority，重新打开后再
从 Host 恢复同一持久 Session。Host Catalog 当前账号返回的全部 Agent 都使用同一
入口；真实 Host 已验证 Job、LectureCast、Deploy 在 detach 与 Leader 替换后保持
各自唯一 Main Session，动态 Agent 仅有本地通用化 fixture。权限请求由主进程持有
原始 Request/Session/Tool/Option authority，页面只能选择经精确白名单过滤的一次性
允许、拒绝或取消；身份和生命周期变化均失败关闭。下一轮只审计并实现安全、只读的
Harness 工具活动状态投影。生产 Package 与桌面发布硬门见
[`PRODUCT_PLAN_AND_PRODUCTION_RELEASE_GATE.md`](PRODUCT_PLAN_AND_PRODUCTION_RELEASE_GATE.md)。

## 上游同步规则

AgentMesh360 代码集中在 `xai-grok-shell::agentmesh360`。与上游的集成点只包括模块
导出、ACP 分发、`MvpAgent` 状态、Session 创建 / 加载 / Prompt 门禁、活动可见性和
idle eviction。保持这条窄接缝，可以在显式合并或 rebase 上游 Grok Build 更新时清楚
审查差异，同时让产品状态与商业契约继续由本 Fork 管理。
