# AgentMesh360 Client 项目进展

状态：持续开发中

最近更新：2026-07-24

本文档是当前仓库的实施进展账本。架构目标以
[`architecture/PRODUCT_BLUEPRINT.md`](architecture/PRODUCT_BLUEPRINT.md) 为准，
Provider 分阶段计划以
[`architecture/CC_SWITCH_PROVIDER_RESEARCH.md`](architecture/CC_SWITCH_PROVIDER_RESEARCH.md)
为准；本文只记录已经落地的事实、验证证据、计划复盘和紧接着要做的工作。

## 固定开发闭环

每完成一个可独立验收的模块或功能，都必须按以下顺序继续：

1. 先完成本机自主测试，记录测试范围、命令和结果；
2. 把变更范围、架构约束和测试要求交给本机 Kimi，由它独立审查代码并执行交叉测试；
3. Kimi 发现任何未关闭的问题时，修复后重新执行自主测试和 Kimi 复测，直到双方验证
   都通过；不得把“仅审查未执行”“建议以后处理”冒充交叉测试通过；
4. 更新本文档，记录实现边界、提交、自主测试和 Kimi 交叉测试证据；
5. 对照产品蓝图和专项计划，检查是否出现职责、顺序或安全边界漂移；
6. 明确下一轮目标、非目标和验收条件；
7. 把下一轮任务加入执行计划并开始开发；
8. 验证完成后再次进入本闭环。

“代码完成”不等于一轮工作结束；自主测试、本机 Kimi 交叉测试、问题闭环、进展更新、
计划复盘和下一轮启动都属于完成条件。Kimi 的结论必须记录其实际检查范围、执行过的
命令和可复核结果，不记录或要求暴露模型的隐藏推理。

## 当前实施状态

| 领域 | 当前事实 | 下一验收点 |
| --- | --- | --- |
| 持久产品 Agent | Registry、Main Session、Workspace、历史可见性已按账户隔离；G0/G1/G2 已覆盖 UI detach、Leader 崩溃恢复与隐藏登录启动源码 | 签名安装包 Login Item 平台 E2E；当前主线回到动态 Package |
| 订阅硬门禁 | Core、Host 与桌面身份外壳已经接通 | OAuth 不是当前 Provider 主线前置条件 |
| Provider Control Plane | 切片 A/B/C/D0/D1/E1/E2/E3 已完成；F0a 官方边界与零费用契约 Harness 已完成 | F0b：真实 Gemini 契约与 thought signature 保真 |
| Provider Sampling | 无 Grok 登录的产品主 Prompt、已审计 Session 辅助消费者、subagent 与显式 Probe 均复用实际 Provider 路由 | 保持真实链路回归，建立可复用的 Provider 兼容契约套件 |
| Provider UI | Profile、global/agent Assignment、三档显式 Probe、付费确认与非秘密历史已完成 | 外部 Provider 契约通过后再增加正式预设 |
| 动态 Agent Package | H0/H1、H2a1 与 H2a2 已完成自主测试和两轮 Kimi 交叉测试：可信安装/回滚、启动复验、共享 Catalog 快照、显式 refresh、只读脱敏状态；生产入口仍关闭 | H2b：生产信任根、远端 Registry 与权限确认 |

## 开发循环记录

### 循环 1：Provider 切片 A——Vault 与 Profile Store

状态：已完成

本地提交：`012e6a5 feat: add provider control plane foundation`

已经实现：

- 共享 `state.db v2` 与账户隔离的 Provider Profile Store；
- macOS Keychain `CredentialVault`，其他平台尚无安全 Backend 时失败关闭；
- 不透明 Credential Ref、route revision 和跨 Vault/SQLite 补偿顺序；
- Provider 列表、创建、更新、替换秘密和删除 ACP API；
- 桌面 Host Client 管理方法，但尚未暴露给 Renderer；
- ACP debug 日志对 API Key、Token、Authorization 等字段递归脱敏；
- Provider ADR、CC Switch 调研和产品蓝图同步。

验证证据：

- `xai-acp-lib`：23 个测试通过；
- `xai-grok-shell agentmesh360`：16 个测试通过；
- 桌面：17 个测试通过、1 个可选真实 Host 测试默认跳过；
- 真实 Grok Host ACP 契约：1 个测试通过；
- Rustfmt、Clippy `-D warnings` 和 Host 构建通过。

明确未实现：Provider UI、Catalog、Assignment、Session Binding、RouteCompiler、
Sampling 路由和独立后台 Host。生产 Keychain Backend 已编译，本轮没有写入用户真实
Keychain 做破坏性验证。

计划复盘：

- 没有建立第二套 Agent Loop 或 Sampling HTTP 栈，仍符合 Grok-first 边界；
- Provider 秘密仍由 Host Vault 独占，没有进入 SQLite、Session 或响应；
- 订阅准入仍先于 Provider 操作，BYOK 没有绕过 AgentMesh360 硬门禁；
- `SessionProviderBinding` 没有被错误塞进 Profile，仍按计划留在切片 C；
- Electron 当前仍会随应用退出停止 Host，因此不能把“最终长期在线”标记为已完成。

### 循环 2：Provider 切片 B——Catalog 与 RouteCompiler

状态：已完成

本地提交：`010c16d feat: add provider catalog and routing control plane`

本轮目标：

1. 建立版本化、声明式、只读的内置 Provider Catalog；
2. 定义保守的 Model Capability、Agent Model Policy 和独立 Model Assignment；
3. 将 Catalog、Profile、Policy 与 Assignment 编译成不含秘密的 `PreparedRoute`；
4. 验证 Assignment 优先级、强制能力拒绝、Quirk 白名单和 Catalog 失败回退。

本轮非目标：

- 不向 SamplingClient 注入真实 Key，不发起任何可能计费的模型请求；
- 不实现 Session Provider Binding 或跨 Provider 迁移；
- 不实现 Renderer Provider 设置界面；
- 不实现远端动态签名 Catalog；
- 不为追求 Provider 数量硬编码未经官方验证的最新模型 ID。

计划审查补充发现：Grok 上游 Sampling 与 subagent 诊断日志仍有记录认证值前缀/后缀的
路径。切片 A 的秘密尚未注入 Sampling，因此当前 Provider Vault 不经过这些路径；但在
切片 D 接入真实 BYOK 之前，必须先把相关诊断改成仅记录 `credential_present`、认证类型
和相等性等非秘密信号，并加入“日志不含测试 Key 任意片段”的回归测试。这是切片 D 的
硬前置条件，不能靠日志级别规避。

验收条件：

- Catalog 数据通过 Schema 校验，非法文档失败并回退到内置基线；
- Provider Quirk 只能来自代码允许的枚举白名单；
- Assignment 与 Agent Package Policy、Provider Profile 保持独立；
- `PreparedRoute` 不序列化 API Key、Credential Ref 或认证 Header；
- 不满足 required capability 时在调用模型前失败；
- 单元测试、Rustfmt、Clippy 和相关桌面回归全部通过。

已经实现：

- `state.db v3` 和从 v2 保留 Provider Profile 的无损迁移；
- 版本化 JSON 内置 Catalog，首批提供 OpenAI、xAI、Anthropic、三类通用兼容入口和
  本地 OpenAI Compatible 模板；目录不硬编码未经验证的具体模型 ID；
- Model Capability 的 `supported / unsupported / unknown` 保守语义和证据来源；
- Agent Model Policy 的 required/preferred/optional 检查，unknown 对 required 失败关闭；
- 全局、Agent、Session 三层独立 Model Assignment，解析优先级为
  `Session > Agent > Global`；
- 非秘密 `PreparedRoute`，可映射到 Grok 现有 `ApiBackend / AuthScheme`，但尚未注入
  Sampling；
- 官方 Origin 显式白名单、自定义端点降级标记、Quirk 枚举白名单和非法 Catalog
  回退内置基线；
- 受订阅门禁保护的 Catalog/Assignment ACP 管理方法和桌面 Host Client 方法。

验证证据：

- `xai-grok-shell agentmesh360`：30 个测试通过，包括 v2→v3 迁移、账户隔离、
  Assignment 优先级、Policy 失败关闭和非秘密 Route；
- 桌面：18 个测试通过、1 个可选真实 Host 测试默认跳过；
- 真实 Grok Host ACP 契约：Catalog/Assignment 在准入有效时可用，失效后被门禁拒绝；
- Rustfmt、Clippy `-D warnings`、桌面语法检查和 Host 构建通过。

计划复盘：

- RouteCompiler 只生成非秘密路由，没有提前改写 Grok Sampling 或建立平行 HTTP 栈；
- Session 级 Assignment 只是“用户选择”，不是持久 Session Binding；两者仍保持独立；
- Catalog 模型能力未知时不会猜测支持，required 能力会在发起模型调用前被拒绝；
- Profile 的官方 Preset 指向自定义 Origin 时会标记为 `custom`，不会误导数据去向；
- 远端签名 Catalog、Provider UI 和真实模型调用仍按计划后置；
- 上游认证片段日志问题仍是切片 D 之前必须解决的安全门槛。

### 循环 3：Provider 切片 C——不可变 Session Binding

状态：已完成

本轮目标：

1. 先完成 C0：产品 Agent Registry、Main Session 与 Workspace 按 `account_id` 隔离，
   旧单账户状态由首次有效账号认领；
2. 固化 `SessionProviderBinding` 的追加式 revision 与非秘密快照契约；
3. 首次绑定保存完整 `PreparedRoute` 快照，Profile/Catalog/Assignment 更新不改写它；
4. 显式切换时生成新 binding revision，同时保留旧 revision；
5. 建立每 Turn 的非秘密实际路由记录接口，为切片 D 调用；
6. Profile 删除或 Key 失效时保留 Binding 与历史，但执行必须失败关闭。

本轮计划复盘发现：现有 Registry 只按 `agent_id` 全局唯一，同机切换两个有效账号可能
复用同一产品 Agent 历史。直接实现 Binding 会把该问题固化，因此把账户隔离列为 C0
硬前置。决策与迁移语义见
[`architecture/ADR_ACCOUNT_SCOPED_SESSIONS_AND_BINDINGS.md`](architecture/ADR_ACCOUNT_SCOPED_SESSIONS_AND_BINDINGS.md)。

#### C0 检查点：账户隔离的持久产品 Agent

状态：已完成

本地提交：`29fa33f feat: isolate persistent agents by account`

已经实现：

- `state.db v4` 将产品 Agent 唯一键改为 `(owner_account_id, agent_id)`；
- 新 Main Session UUID 与 Workspace 同时包含账户边界；
- v3 旧 Registry 行先迁移为 unowned，由第一次通过订阅门禁的账号原子认领，原
  Main Session、Workspace 和激活状态不丢失；
- 有效账号切换时清除旧 pin/restore 视图，只恢复当前账号的运行中 Agent；
- Session 列表隐藏其他账号与未认领的产品 Session，直接用其 ID 访问也返回不可见；
- 订阅失效、退出登录和账号切换均只撤销访问与驻留，不删除磁盘历史；
- Bootstrap 后的账户状态初始化如果失败，会撤销本次 Host 准入并失败关闭。

验证证据：

- `xai-grok-shell agentmesh360`：33 个测试通过；
- 持久 Session disconnect 回归：1 个测试通过；
- 桌面：18 个测试通过、1 个可选真实 Host 测试默认跳过；
- 真实 Grok Host ACP 契约：v3 旧会话由账号 A 认领，切到账号 B 不可见，切回 A
  仍恢复同一 Main Session；订阅失效后继续被硬门禁拒绝；
- Rustfmt、Clippy `-D warnings`、桌面语法检查和真实 Host 构建通过。

计划复盘：

- 账户隔离被放在 Binding 之前完成，没有把跨账号复用风险写入新协议；
- Session 磁盘状态没有随门禁或账号切换删除，符合“失效时保留可恢复状态”的产品边界；
- 账户 ID 只作为 Host 内部范围和 Session 元数据使用，不进入产品 Agent API 响应；
- C0 使用了 `state.db v4`，因此 Binding schema 顺延为 v5，不能覆盖或伪装成 v4；
- 当前 Electron 仍随 UI 退出停止 Host，C0 只解决身份隔离，不把后台常驻误标为完成。

#### C1 检查点：不可变 SessionProviderBinding

状态：已完成

本地提交：`ae07801 feat: persist immutable session provider bindings`

目标：

1. 用 `state.db v5` 建立追加式 Binding revision，完整保存非秘密 `PreparedRoute` 快照；
2. 首次获取当前 Binding 时只创建一次，后续 Profile/Catalog/Assignment 变化不静默漂移；
3. 显式切换创建下一 revision，旧 revision 与历史继续可读；
4. Profile 被删除后 Binding 仍保留，但执行路由解析失败关闭；
5. 提供账户隔离的 ACP 读取/显式切换入口和桌面 Host Client 合同。

验收条件：并发/重复首次绑定幂等、revision 单调递增、跨账号不可见、快照不含
Credential Ref/API Key/Header、删除 Profile 不级联 Binding，并通过 v4→v5 无损迁移测试。

已经实现：

- `state.db v5` 新增 `session_provider_bindings` 与 `turn_route_records`，v4→v5
  只增表，不改写账户隔离的 Agent、Profile 或 Assignment；
- Binding 保存完整、非秘密 `PreparedRoute` JSON、BLAKE3 snapshot hash、Profile /
  Assignment / Catalog revision 和数据去向信息；读取时校验 hash，篡改失败关闭；
- 首次绑定在 SQLite Immediate transaction 与 busy timeout 下并发幂等，只产生 revision 1；
- 当前 Binding 不随 Profile、Catalog 或 Assignment 更新漂移；显式切换、兼容迁移和
  回滚均追加新 revision，旧快照永久保留；
- 删除 Profile 会级联当前 Assignment，但不级联 Binding/Turn 历史；没有当前
  Assignment 时无法编译新路由；
- 产品 Session 的 Binding/Turn 读取再次校验 Registry 账户归属，其他账号不可见；
- 新增 resolve/history/switch Binding ACP、Turn Route 只读 ACP 与桌面 Host Client 合同；
- Turn Route 写入接口只接受已持久化且 hash 匹配的 Binding，同一 Turn 不能改写路由；
  当前没有调用该接口，因此不会把计划路由伪装成实际模型请求。

验证证据：

- `xai-grok-shell agentmesh360`：42 个测试通过；
- 桌面：19 个测试通过、1 个可选真实 Host 测试默认跳过；
- 真实 Grok Host ACP 契约：当前账号可读空 Binding/Turn 历史，其他账号的产品
  Session 在 ACP 外层即返回不可见，订阅失效后继续被硬门禁拒绝；
- Rustfmt、Clippy `-D warnings`、桌面语法检查和真实 Host 构建通过。

计划复盘：

- Binding 复用切片 B 的 `PreparedRoute`，没有建立第二套路由结构或 Sampling 客户端；
- `Model Assignment` 仍表示当前选择，Binding 才表示 Session 已冻结事实，两者没有合并；
- `TurnRouteRecord` 表和可信写入接口不等于已有实际调用记录；切片 D 必须在真正提交
  Sampling 请求时才调用；
- `compatible_migration` 当前只是追加 revision 的审计原因，尚未实现历史转换、摘要或
  Provider 私有推理状态兼容流程，不能对外宣称已经完成跨 Provider 迁移；
- 动态 Agent Package 的 Model Policy 尚未落地，Binding ACP 当前使用保守默认 Policy；
  切片 D 只接现有内置 Agent，Package Policy 仍按动态 Package 主线补齐；
- C1 没有读取 Vault Key、发送模型请求或实现 Renderer UI，仍符合切片边界。

C1 非目标保持不变：不发送真实模型请求；不在“准备路由”时写实际 Turn；不实现
Renderer 设置 UI。

### 循环 4：Provider 切片 D0——认证日志安全门槛

状态：已完成

本地提交：`260d5c1 fix: remove credential material from harness diagnostics`

已经实现：

- 清除了 Sampling、subagent、认证恢复、OIDC、工具、文件上传、relay、billing 与 feedback
  路径中认证值的前缀、后缀、Header value、响应正文和秘密 URL 日志；
- tracing、统一日志和错误只保留 `credential_present`、认证类型、来源、相等性、状态码、
  响应字节数和 endpoint 是否配置等非秘密信号；
- 为 `GrokAuth`、`GrokAuthCredentials`、`SamplerConfig`、`SamplingClient`、Provider/模型
  配置、上传配置以及图像、视频、搜索配置补充安全 `Debug`；
- 401 attribution 只允许在内存中瞬时比较本次发送凭据，接口文档明确禁止格式化、记录或
  持久化；`DiagnosticUploader` 改为自己解析实时凭据，不再接收凭据片段；
- Provider 错误正文会清除活动凭据和默认 Header 值，reqwest 错误去除 URL；OIDC 日志只
  保留 Origin，并清除本次发送的 code/refresh token；
- Web Search 的脱敏副本同时清除 endpoint 路径、查询、userinfo 和所有额外 Header 值；
- 建立高辨识度 sentinel 回归，覆盖 Sampling、OIDC、billing、Provider Config、上传配置、
  工具配置和认证对象，断言完整秘密及稳定片段均不进入 Debug 或诊断文本。

验证证据：

- `cargo fmt --all -- --check`：通过；
- `cargo clippy --manifest-path crates/codegen/xai-grok-shell/Cargo.toml --all-targets -- -D warnings`：通过；
- `xai-grok-sampler --lib`：156 项通过；
- `xai-file-utils --lib`：233 项通过、6 项忽略；
- `xai-grok-tools --lib`：2674 项在沙箱内通过、6 项忽略；仅两项 wiremock 测试因沙箱
  禁止绑定端口失败，放宽该限制后两项均通过；
- 四项新增 Shell sentinel 定向测试全部通过；
- 旧认证前缀/后缀模式、Sampling `body_preview/raw_body` 静态扫描无秘密命中；唯一
  `key_prefix` 命中是视频对象存储的普通路径前缀，不是凭据片段。

计划复盘：

- 没有读取 AgentMesh360 Vault、注入用户真实 Key 或调用外部 Provider；
- 没有降低日志级别来掩盖泄露，也没有建立第二套 Sampling/Agent Loop；
- URL、Header、错误正文和 `Debug` 被纳入同一安全边界，修复范围比最初只检查
  Sampling/subagent 更完整，但没有改变 Provider 路由职责；
- 完整 auth 测试套件仍有 23 项受进程全局 `jsonwebtoken CryptoProvider` 初始化冲突
  影响；对应 manager 定向套件 109 项已通过。该已知测试隔离问题不冒充 D0 回归，也不
  在本轮顺手扩张修复范围。

本轮非目标保持不变：不注入用户真实 Key、不调用外部 Provider、不实现 UI、不把日志
级别降低当作修复。

### 循环 5：Provider 切片 D1a——Credential Lease 与无网络路由投影

状态：已完成

本地提交：`0bfce56 feat: add host credential lease projection`

已经实现：

- Host 自有 `CredentialLease` 不实现 `Clone` 或 `Serialize`，秘密保存在会清零的
  `SecretValue` 中，`Debug` 只输出 Profile、revision 和 presence；
- 账户范围的不可变 Binding 解析当前 Profile，校验 owner、Profile ID、revision 下界和
  同 revision 路由一致性，再按 Profile 内部 Credential Ref 从 Vault 读取秘密；
- 秘密不写入 `SamplerConfig.api_key`，只放入 serde 跳过的内存 `BearerResolver`；
- Responses、Chat Completions、Anthropic Messages 都投影到原有 `SamplingClient`，构造
  Client 不发网络请求，也没有新增 HTTP 栈；
- 当前 Profile 有更新 revision 时，旧 Binding 继续使用冻结的 endpoint、protocol、model；
  Profile revision 不可能倒退或同 revision 内容不一致时失败关闭；
- 缺失 Vault 项、跨账户访问和伪造未来 revision 都会在进入 Sampling 前失败关闭；
- D1 接入复盘时补掉 D0 一个漏网点：流式请求 span 不再记录可能携带 URL 的原始
  `reqwest::Error`，只记录静态 transport 分类。

验证证据：

- Credential Lease 契约 4 项通过；
- AgentMesh360 回归 46 项全部通过（订阅门禁的 3 项 mock server 测试需允许本机临时
  端口；沙箱内其余 43 项已先通过）；
- `xai-grok-sampler --lib` 156 项全部通过；
- `cargo fmt --all -- --check`、Shell 全 target Clippy `-D warnings`、`git diff --check`
  全部通过；
- 测试明确断言序列化的 Sampler Config 与 Lease/Config Debug 都不含 sentinel 秘密。

计划复盘：

- D1a 只建立 Host 内存权限和现有数据面的投影，没有通过 Renderer/Agent Package 暴露
  Lease，也没有发送真实或计费请求；
- 旧 Binding 使用冻结路由、当前 Profile 只提供同一 Profile 的 Vault 句柄，符合“已有
  Session 不随 Profile 更新静默漂移”；
- 把 Lease 放入 serde 跳过的 resolver，而不是 `SamplerConfig.api_key`，避免为接入方便
  重新打开持久化泄露面；
- 真实产品 Session 仍走 Grok 原配置，不能把本轮描述成 BYOK 已经端到端可用；
- 现有 `run_turn_via_sampler` 在 `submit_and_collect` 前具备单一提交点，但
  `SessionActor` 尚未持有 AgentMesh 绑定上下文。直接塞入所有 SessionActor 测试构造器会
  扩大改动面，因此先用 D1b 提交协调器固定时序，再在 D1c 做窄接缝接入。

本轮非目标保持不变：不发送真实或计费请求，不实现 Gemini/Bedrock Native 协议，不
实现 Provider UI、动态 Package Policy 或 compatible migration 的历史状态转换。

### 循环 6：Provider 切片 D1b——请求提交协调器与 Turn Route 时序

状态：已完成

本地提交：`6cbd824 feat: record routes after sampler acceptance`

已经实现：

- Grok `SamplerHandle` 新增同步 `begin_submit_and_collect(_with_config)`：只有 Submit 命令
  成功进入 actor channel 才返回 `PendingSamplingRequest`；
- `PendingSamplingRequest` 保持原有 RAII 语义，等待完成期间被 drop 会向 actor 发送取消；
- 原 `submit_and_collect` 已复用 begin + collect，不改变现有调用方行为；
- Host `BoundTurnSubmission` 把账户、turn ID、Lease 投影、不可变 Binding 和可信
  `TurnRouteStore` 保持在同一对象中；
- 写 Turn Route 前先检查同 turn 是否已被另一 Binding 占用，避免明知冲突仍提交；并发
  竞争仍由提交后的事务检查兜底；
- 提交器返回成功后才写记录；准备失败、actor channel 拒绝或提交器失败均不产生幽灵
  Turn；若提交已接收但审计写入失败，Pending receipt 被 drop 并取消请求；
- 同一 turn、同一 Binding 的重试返回原记录，不插入第二条；不同 Binding 不能覆盖。

验证证据：

- `BoundTurnSubmission` 时序契约 5 项全部通过；
- Sampler acceptance/RAII 契约 2 项通过，Sampler 全套 158 项通过；
- AgentMesh360 回归 51 项全部通过；
- Shell 全 target Clippy `-D warnings`、Rustfmt 和 diff 检查通过；
- 所有测试使用假提交器或 actor channel，不访问外部 Provider、不产生费用。

计划复盘：

- `TurnRouteRecord` 现在证明命令已进入 Sampling actor，不再把“已准备配置”误记成提交；
- 协调器仍在 Host 私有模块，Renderer、Agent Package 和普通 Session 不能拿到 Lease；
- D1b 没有修改 `SessionActor` 或 Prompt 队列，避免尚未解决多模型调用生命周期时提前
  扩散接入；
- 一个 Prompt Turn 可能包含 tool loop、401 retry、compaction resubmit 和 completion
  recovery。D1c 不能只消费一次 Lease 后让后续请求退回 Grok 默认路由；必须先建立同一
  Turn 的可复用绑定上下文，再贯通队列。

本轮非目标保持不变：不直接改造全部 SessionActor 构造器，不发送真实模型请求，不
处理 Usage/计费，不实现 UI 或新的协议 Backend。

### 循环 7：Provider 切片 D1c0——同一 Turn 的绑定上下文复用

状态：已完成

本地提交：`5cc4ed9 feat: reuse bound provider route within a turn`

已经实现：

- 首次 actor acceptance 和 Turn Route 写入后，协调器返回不可序列化的
  `ActiveBoundTurn`；
- Active 上下文保留同一 Binding 的 resolver-backed `SamplerConfig`，后续调用只在 Host
  内克隆该内存配置，不重新解析 Assignment/Profile；
- tool follow-up、401/compaction resubmit 和 completion recovery 可以复用同一路由，但
  不能修改 Binding，也不会再次写 Turn Route；
- `ActiveBoundTurn` 的 Debug 继续使用安全 `SamplerConfig::Debug`，内部 config 序列化
  会跳过 resolver，sentinel 秘密不会出现。

验证证据：

- Turn Submission 契约增至 6 项全部通过；新增用例执行首次提交、tool follow-up 和认证
  重试三次调用，只产生一条 Turn Route；
- AgentMesh360 回归增至 52 项全部通过；
- Shell 全 target Clippy `-D warnings`、Rustfmt、diff 检查全部通过；
- 全程使用假提交器，不发送网络请求。

计划复盘：

- 同一 Prompt 的所有模型调用现在可以保持同一不可变 Binding，不会在 retry 时退回
  Grok 默认配置；
- Active 上下文没有暴露给 Renderer/Package，也没有成为可序列化 Session 字段；
- 产品 Session 和 synthetic auto-wake 都需要同一 Host 路由，单纯把 Bound Turn 塞进
  用户 `SessionCommand::Prompt` 会漏掉后台唤醒。D1c1 应把可信、非秘密账户路由上下文
  注入 `StartupHints` 的 serde-skip 字段，让 SessionActor 每个 Prompt 都从 Host 准备
  Bound Turn；
- `StartupHints` 的该字段必须由 MvpAgent 根据 Registry/当前账户覆盖，不能接受客户端
  反序列化输入，防止伪造账户作用域。

本轮非目标保持不变：不修改 Prompt 队列和全部测试构造器，不发送真实请求，不处理 UI。

### 循环 8：Provider 切片 D1c1——产品 Session Prompt 真实接入

状态：已完成

本地提交：

- `1d8bb70 feat: route product turns through provider bindings`
- `e401dcf test: cover bound turn sampler acceptance`

已经实现：

- `ClientAccess` 改为共享实时状态，并提供账户锁定的 `ClientAccessGuard`；账号切换、
  订阅过期或 access invalidate 后，已有产品 Session 的 Guard 立即失败关闭；
- `AgentMeshSessionRouteContext` 只含 owner、agent、role 和共享 Access Guard，不含秘密；
- MvpAgent 在 Session spawn 时根据 Registry 和当前账户可信注入 Route Context；字段使用
  `#[serde(skip)]`，客户端构造的 `startupHints` 无法伪造账户或 Agent；
- 每个产品 Prompt 在推理前确保不可变 Session Binding，解析当前 Vault Lease 并创建
  `ProductTurnRoute`；因此用户 Prompt、queued Prompt 和 synthetic auto-wake 共用同一
  SessionActor 路径；
- `run_turn_via_sampler` 对产品 Turn 使用
  `begin_submit_and_collect_with_config`，普通 Grok Session 继续原来的 refresh + default
  config 路径；
- 产品 Turn 的 tool loop、compaction/401 resubmit、goal round 与 completion recovery 都
  透传同一个 ProductTurnRoute；
- 缺少 Assignment、Profile、Binding 或 Vault Key 时在提交前返回
  `agentmesh360_provider_route_required`，不静默回落到 Grok 默认 Provider；本地历史和
  Binding 数据不删除；
- bound submit 失败会清理 stream-drain barrier；审计写入失败仍通过 Pending RAII 取消
  已接收请求。

验证证据：

- AgentMesh360 回归 54 项全部通过；
- 外部 `startupHints` 伪造 Route Context 测试通过；普通 Session 的既有 conversation
  recovery 定向测试通过；
- 真实 SamplerActor + 本机 mock Provider 测试通过：actor 接收后已有 Turn Route，请求
  命中 `/v1/responses` 并使用 Lease Bearer，mock 401 后审计记录仍保持；
- Shell 全 target Clippy `-D warnings`、Rustfmt、测试编译和 diff 检查通过；
- 测试只访问本机临时端口，没有调用外部或计费 Provider；构建期间只清理了本仓库可再
  生成的 `target/debug/incremental` 缓存以解除磁盘满阻塞。

计划复盘：

- 路由上下文由 Host Registry/Access 生成而不是从 Prompt 元数据接受，账户和订阅边界
  没有下放给 Renderer；
- 用户 Prompt 与后台 synthetic wake 都在 SessionActor 内部准备 ProductTurnRoute，避免
  只覆盖前台对话却让后台 Agent 偷走默认 Provider；
- 产品 Session 现在确实接到 Sampling actor，但只做了模块组合与本机 mock Provider
  验证；尚未完成从 bootstrap、Provider ACP、Assignment、Agent 激活到 Prompt 的完整
  Host ACP E2E，不能描述成 Provider M1 已经可交付；
- Provider UI 尚未实现，因此当前用户若没有先通过管理 ACP 配置 Profile/Assignment，
  产品 Prompt 会按设计失败关闭。这是安全语义，不是最终产品体验；
- 自动权限分类、压缩/摘要、图像描述和 subagent 等辅助推理消费者仍需逐一审计，防止
  主 Turn 已绑定而旁路继续使用默认 Provider。

本轮非目标保持不变：没有真实 Provider E2E、Provider UI/Probe、计费 Usage 或新协议。

### 循环 9：Provider 切片 D1c2——完整 Host ACP mock E2E

状态：已完成

阶段提交：

- `5cfc926 test: share host vault across provider routing`
- `9fa7350 test: cover host product prompt routing`
- `a5df190 test: cover host provider failure gates`

已完成子模块：

- `AgentMesh360Runtime` 显式持有同一份 state home 与 `RuntimeCredentialVault`，Provider
  管理、Model Routing、Session Route Context 和 Credential Lease 不再各自重新读取
  环境默认值；
- 生产构建中的 `RuntimeCredentialVault` 只有系统 Vault 变体；共享 Memory Vault 变体、
  `for_host_test` 构造器和秘密读取能力全部受 `cfg(test)` 限制，没有环境变量测试后门；
- 测试 Memory Vault 改为线程安全的共享实例，使 ACP 创建 Provider 时写入的凭据可由
  SessionActor 所在线程的 Prompt Lease 使用；其 Debug 与 Runtime Vault Debug 均脱敏；
- 新增 Host 组合测试，已经覆盖本机 Core bootstrap、Provider ACP 创建、Agent 级 Model
  Assignment、产品 Main Session 身份、Prompt 路由准备、提交接受和 Turn Route 管理 ACP
  查询；Provider secret 不出现在 Provider/Turn Route 响应或 Debug 中。
- 新增真实 Host ACP 成功链：初始化无 Grok 登录的 Host、验证 AgentMesh360 订阅、创建
  BYOK Provider、写入 Agent Assignment、调用 `agents/activate` 创建常驻 Job Agent，
  再通过真实 `session/prompt`、SessionActor、SamplerActor 和本机 SSE Provider 完成回复；
- 产品 Session 仅在 Host 可信 Route Context 存在时免除 Grok 原生认证要求；普通 Grok
  Session 在同一 E2E 中仍返回认证错误，订阅门禁和 BYOK 路由没有被扩散为全局绕过；
- `begin_submit_and_collect_with_config` 现在强制用 Binding 的 model 覆盖
  ConversationRequest 中预填的 Grok 默认 model，确保实际 HTTP 请求、Lease 和 Turn Route
  审计一致；stale model 回归已固定该语义。

阶段验证：

- AgentMesh360 模块回归 56 项全部通过；
- Host 共享 Vault 定向测试通过，credits 为 0 的有效订阅仍允许进入；
- Shell 全 target Clippy `-D warnings`、Rustfmt 与 diff 检查通过；
- 完整成功链只访问本机临时 Core/Provider 端口，已启动真实产品 SessionActor 和
  SamplerActor，但没有调用真实或计费 Provider；
- 构建再次触发磁盘满后，只删除了本仓库约 13 GB 可重建的
  `target/debug/incremental`，并以 `CARGO_INCREMENTAL=0` 完成验证。
- Host 失败矩阵覆盖订阅拒绝、跨账户、缺失 Assignment 和缺失 Vault secret；所有 Provider
  路由失败都发生在网络提交前，失败 Session 的 Turn Route 数为 0；
- AgentMesh360 模块最终回归 57 项全部通过，Shell 全 target Clippy `-D warnings` 通过。

阶段计划复盘：

- D1c2 成功路径已经达到原计划的真实 MvpAgent/ACP 边界，不再只是模块组合测试；
- E2E 揭示并修复了两个计划内但单元测试无法发现的偏差：Grok 登录前置条件与请求模型
  漂移，证明继续使用真实 Host 链而不是另建测试路由是正确方向；
- 原计划的失效订阅、跨账户和缺失配置失败门槛已在 Host 全链测试覆盖，D1c2 可以关闭；
- 主 Prompt 以外仍存在直接 SamplingClient/subagent 默认配置旁路，这不属于 D1c2 主链
  缺陷，但必须在 Provider M1 前解决；审计结果和 D1d 顺序已写入
  [`architecture/PROVIDER_AUXILIARY_INFERENCE_AUDIT.md`](architecture/PROVIDER_AUXILIARY_INFERENCE_AUDIT.md)；
- Provider UI、真实计费请求和辅助推理改造仍不是当前子模块范围。

本轮目标：

1. ~~为测试建立只在 `cfg(test)` 可用的 Memory Vault/本机 mock Provider 注入缝，不在
   生产暴露 Vault 读取或绕过 Keychain；~~ 已完成
2. ~~通过真实 MvpAgent/ACP 路径覆盖 Core bootstrap、Provider 创建、Model Assignment、
   产品 Agent 激活/加载、Prompt、Sampler actor 和 Turn Route 查询；~~ 已完成成功路径
3. ~~断言订阅无效、跨账户、缺失 Assignment/Vault 都在 Prompt 提交前失败关闭且不产生
   Turn Route；~~ 已完成
4. ~~断言成功路径只写一条实际路由，响应/管理 API/日志均不返回秘密；~~ 已完成
5. ~~E2E 后审计所有辅助推理消费者，形成 D1d 的明确清单与接入顺序。~~ 已完成

验收条件：无需真实账号、Keychain 或外部 Provider 即可重复验证完整 Host 链路；生产
代码没有测试后门；普通 Session 回归通过；格式、Clippy 和相关测试通过。

本轮非目标：不做真实计费请求、不实现 UI、不扩展协议或 Provider 预设。

### 循环 10：Provider 切片 D1d0——统一辅助 Sampling Authority

状态：已完成

本地提交：`6b1de2d feat: add auxiliary provider role fallback`

审计依据：

- [`architecture/PROVIDER_AUXILIARY_INFERENCE_AUDIT.md`](architecture/PROVIDER_AUXILIARY_INFERENCE_AUDIT.md)

已完成：

- `ModelAssignmentStore` 先完整解析请求 role 的 Session → Agent → Global；仅在该 role
  完全缺失时，再完整解析 `main` 的 Session → Agent → Global，不跨 Session 偷用配置；
- `PreparedRoute` 同时记录请求 role 所属 Binding 和实际 `assignmentRole`；旧 Binding
  snapshot 缺少新字段时按 `main` 兼容读取，不修改已有不可变 snapshot 或 schema；
- `RouteCompiler` 对辅助 role 使用 main Assignment 的情况输出非秘密 warning，使回退
  可见、可测、可审计，不允许无 Assignment 时退回 Grok default config；
- `AgentMeshSessionRouteContext::prepare_turn_for_role` 已成为 Host 内部按 role 准备
  Binding、Lease 和 Turn Route 的统一入口；原 `prepare_turn` 保持 main role 兼容；
- Host 共享 Vault 测试已用 `vision` role 验证 main Assignment fallback：生成独立
  `vision` Binding，实际模型来自 main，Provider secret 不进入 Binding、Route 或 Debug；
- 既有 Turn Submission 状态机继续保证同一 session + role + logical turn 重试只记录一条
  Turn Route，不同 role 通过独立 Binding 隔离。

验证证据：

- `agentmesh360::` 模块回归 59 项全部通过；
- 当前代码通过 `cargo check --tests`、Rustfmt、`git diff --check`；
- 清理本仓库可重建 Cargo 缓存后，以 `CARGO_INCREMENTAL=0` 从干净依赖构建完成
  library + tests 的 Clippy `-D warnings`；
- 测试只访问本机 mock Core/Provider，没有调用真实或计费 Provider。

计划复盘：

- D1d0 仍复用现有 `SamplerActor`、Binding、Lease 和 Turn Route，没有建立平行 Sampling
  栈，符合 Grok-first 约束；
- 回退顺序是“先完整请求 role，再完整 main role”，与审计计划一致；专用全局 vision
  Assignment 会优先于 Session main，避免 main 覆盖显式专用配置；
- 新字段只进入非秘密 PreparedRoute snapshot，Vault handle、credential 和账户身份仍不由
  Renderer、Agent Package 或 startup hints 提供；
- D1d0 只完成 Authority 基础，不代表图片描述、权限分类和压缩已经接入。下一轮必须从
  真实消费入口改造，不能把基础契约误报为 Provider M1 完成。

验收条件：role fallback 有独立契约测试；Binding/Turn Route 明确记录请求 role 与实际采用
的 Assignment；订阅/账户/Vault 失败继续在 actor 接收前关闭；格式、Clippy 和 AgentMesh
回归通过。

本轮非目标：D1d0 不一次性改完所有消费者，不实现 UI/Probe/Usage，不扩展 Provider 协议。

### 循环 11：Provider 切片 D1d1——Prompt 内 P0 辅助推理

状态：已完成

阶段提交：

- `7acc26f feat: bind auxiliary image sampling`
- `a41b05b feat: bind automatic permission classification`
- `1e1b705 feat: bind product compaction sampling`

已完成子模块 D1d1a：

- 复核真实编译路径后确认，当前 Grok Build 模板的 `is_cursor_harness()` 恒为 `false`：
  用户图片作为多模态 content 随 main 请求提交，已经受 main Binding/Lease/Turn Route
  约束，并不存在运行中的独立图片描述旁路；
- Host 多模态 E2E 已加入合法 PNG，断言真实 Provider 请求携带图片、model 与 main
  Binding 一致，只产生一条 main Turn Route，且不会产生幽灵 vision 请求或记录；
- 休眠的 Cursor 图片转写路径已预先接入 `vision` Authority；主 Prompt 使用 prompt id，
  interjection 优先复用当前 prompt id，没有活动 Turn 时使用独立 synthetic id；
- `ImageDescribeCache` 抽出可注入描述执行器，普通 Grok Session 仍使用原
  `SamplingClient`，产品 Session 的 Cursor 转写路径改由 Host Binding config 提交；
- `SamplerActor` 新增 side-query 收集模式：命令仍由 actor 接受、支持 per-request
  config 与 completion receipt，但辅助 token/Completed 事件不进入主会话事件通道；
- 首次 E2E 试验发现辅助回复会被主 Session 误认成主回复，新增 side-query 隔离后已用
  SamplerActor 回归固定；没有用测试特判或第二套 HTTP Sampling 栈绕过问题。

阶段验证：

- SamplerActor 回归 15 项全部通过，包含 side-query“可收集、不广播主事件”测试；
- image describe 模块回归 27 项全部通过，包含注入执行器与缓存同语义测试；
- AgentMesh360 模块回归 59 项全部通过；Host 多模态 E2E 只使用本机 mock；
- `cargo check --tests`、Rustfmt、`git diff --check` 和 library + tests Clippy
  `-D warnings` 通过。

阶段计划复盘：

- 原审计把图片描述列为当前 P0 运行旁路，但真实编译配置表明它是休眠的 Cursor twin；
  计划已修正为“验证 active main 多模态路径 + 加固未来可能启用的 vision 路径”；
- side-query 是同一个 SamplerActor 的显式命令语义，不是常驻副本，也不复制 credential，
  因此没有背离单一 Harness 和低内存目标；
- D1d1a 完成时确认下一入口是运行中的自动权限分类，其失败必须只回退本地策略，不能
  回退 Grok default Provider；该入口现已按这一约束完成，随后处理必要压缩。

已完成子模块 D1d1b：

- 产品 Session 的自动权限分类不再在 wiring 时创建 Grok/aux `SamplingClient`；每次需要
  LLM 判定时，由实时 `ClientAccessGuard` 为 `permission_classifier` role 准备
  Binding、Credential Lease 和 synthetic/当前 logical turn；
- 权限分类请求通过 SamplerActor side-query 命令提交，实际 model 强制来自 Binding；
  role 未单独配置时按 D1d0 契约回退 main Assignment，但仍生成独立 role Binding/Route；
- 远端成功结果继续进入既有 `LlmPermissionClassifier` JSON 解析；Authority、订阅、Vault、
  网络或解析失败时只触发现有本地保守/启发式策略，不尝试 Grok default Provider；
- 产品 role 的真实能力尚未暴露到 Session 时，不再从 Grok 默认 session model 推断并发送
  `reasoning_effort`，避免把不支持的 Grok 参数注入用户 BYOK endpoint；
- 新增真实产品分类 E2E：有效订阅下请求使用绑定 Bearer/model、写一条
  `permission_classifier` Turn Route；订阅失效和 Vault secret 删除后均零网络请求、零幽灵
  Route，恢复订阅不会恢复已删除秘密；bootstrap token 和 Provider secret 不进入请求正文。

D1d1b 验证：

- permission auto-mode 回归 16 项全部通过；
- AgentMesh360 模块回归 59 项全部通过；
- 产品权限分类 E2E 成功、订阅失效与 Vault 丢失矩阵通过，只使用本机 mock；
- Rustfmt、`git diff --check` 和 library + tests Clippy `-D warnings` 通过。

D1d1b 计划复盘：

- 分类器仍使用 Grok Harness 原有 Permission Manager、分类 prompt、JSON schema 和本地
  heuristic，只替换产品 Session 的 Sampling 授权入口，没有另建权限系统；
- Access Guard 在每次分类而不是 wiring 时检查，满足长期在线 Session 中订阅状态可变化
  的约束；失败保留对话与本地判断能力；
- side-query 的远端失败不会污染主 Session 的流式事件，也不会改变 main Binding；
- 下一轮只接必要压缩 `compaction` role；D1d1 完成前仍不能进入后台任务或 subagent。

已完成子模块 D1d1c：

- 产品 Session 的 manual/auto compaction、two-pass prefire/pass2 和 single-pass
  full-replace 不再读取 Grok default Provider；统一为 `compaction` role 准备
  Binding、Credential Lease 与 per-request `SamplerConfig`；
- 压缩请求复用现有 SamplerActor 的 side-query 收集命令，保留现有三协议 Backend、
  retry、cancellation、工具定义和 full-replace Harness；普通 Grok Session 仍走原
  `SamplingClient` 路径，没有建立第二套 HTTP 或压缩引擎；
- `PrefireState` 只保存非秘密 logical compaction id；同一次压缩的 pass1、pass2、
  退化重试与 single-pass fallback 使用同一 immutable Binding，并由 Turn Route 的
  幂等键只记录一次真实提交；
- 专用 `compaction` Assignment 优先；未配置时完整回退 `main` Assignment，但
  Binding/Turn Route 的请求 role 仍为 `compaction`，可从 Binding 的
  `assignmentRole` 审计实际回退；
- Credential Lease 与订阅 Guard 在压缩开始前重新解析；Vault 丢失返回结构化
  `agentmesh360_provider_route_required`，订阅无效返回准入错误，两者都在 actor
  接收前停止、零 Provider 网络请求，并保留 Session 历史。

D1d1c 验证：

- 新增专用 `model-compact` Host E2E：第一次返回退化摘要、第二次成功，两个请求都使用
  同一 Bearer/model，最终只有一条 `compaction` Turn Route；
- 既有 Host 主 Prompt E2E 增加显式 `/compact`，验证没有专用 role 时回退
  `model-main`，Binding 的 `assignmentRole` 为 `main`；
- Vault 删除和订阅失效矩阵均验证零网络请求；普通 Chat Completions 与 Responses
  compaction 回归各 1 项通过；
- AgentMesh360 模块 60 项全部通过；Rustfmt、`git diff --check` 与 library + tests
  Clippy `-D warnings` 通过。

D1d1 总计划复盘：

- 三个 P0 入口都复用 Grok Harness 已有的 Prompt、Permission Manager、Compaction
  Engine 和 SamplerActor；新增的是 Host Authority 与 side-query 命令语义，不是平行
  Agent Loop；
- main、vision、permission_classifier 与 compaction 的请求 role、fallback 和失败语义
  与专项审计一致，Provider 密钥仍只存在于 Vault/短生命周期内存 lease；
- 本轮没有提前实现 Provider UI、Probe、后台消费者或 subagent，也没有把 Web Search、
  图片生成等服务错误纳入通用 LLM role；
- D1d1 已满足验收条件，下一轮按既定顺序进入 D1d2，先处理失败可安全跳过的
  `laziness`，再处理需要可重试状态的 `recap` 与 `memory`。

本轮目标：

1. ~~审计并加固用户图片路径：当前模板验证图片随 main Binding 提交；休眠的 Cursor
   描述路径通过 `vision` Authority 获取 per-request config，并在 actor 接受后记录对应
   Turn Route；~~ 已完成
2. ~~接入 `permission_classifier`，远端失败时只使用既有本地保守/启发式策略，不切换
   Provider；~~ 已完成
3. ~~接入必要压缩的 `compaction` role，保证同一次压缩的多阶段调用复用同一
   Binding；~~ 已完成
4. ~~用 Host E2E 覆盖专用 role Assignment、main fallback、订阅失效、Vault 丢失和重试
   不漂移，并确认普通 Grok Session 不受影响。~~ 已完成

验收条件：三个 Prompt 内 P0 消费者不再直接取得产品 Session 的 Grok default config；
每个远端调用都有与真实 endpoint/model 一致的 role Turn Route；失败语义符合专项审计；
格式、Clippy 和相关回归通过。

本轮非目标：不接后台 laziness/recap/memory，不做 subagent 委托，不实现 Provider UI、
Probe、Usage 或真实付费 Provider E2E。

### 循环 12：Provider 切片 D1d2——后台消费者

状态：已完成；laziness、recap、memory、`/btw` 与 suggestion 均已接入 Host Authority

阶段提交：

- `9e84d75 feat: bind product laziness sampling`
- `cc3020c feat: bind product recap sampling`
- `0519733 feat: bind product memory sampling`
- `6a73df8 feat: bind remaining product session auxiliaries`

已完成子模块 D1d2a：

- 保留 Grok Harness 原有 laziness 启用/空闲门槛、分类 prompt、transcript 展平、
  用户输入/模型切换取消、超时、JSON 解析、nudge cap 和 reminder 注入逻辑；
- 普通 Grok Session 继续使用 direct `SamplingClient::conversation_collect`；产品 Session
  为每次 fire 创建 `aux:laziness:<uuid>`，通过实时 `laziness` Binding/Lease 与现有
  SamplerActor non-broadcast side-query 提交；
- 抽出 `begin_product_side_query_for_role`，统一 actor 接收、per-request config、实际
  model 返回和 Turn Route 写入边界；permission_classifier 同步复用该 helper，未改变其
  失败回退；
- 专用 `laziness` Assignment 优先，缺省可审计地回退 main；实际绑定 model 同时用于
  Provider 请求和分类 telemetry；
- 订阅、Vault、actor 或网络失败仍进入既有 `ClassifierError`，只跳过本次检测，不切换
  Provider、不注入 nudge、不删除历史。

D1d2a 验证：

- 产品 laziness E2E 2 项通过：专用 `laziness-model`/独立 Key 与 main fallback 分别
  生效；请求使用真实 Bearer/model，只有 `laziness` Turn Route；
- 同一专用 role E2E 连续验证订阅失效与 Vault 删除均零网络、零幽灵 Route，并各写一条
  `classifier_error` abort；
- laziness actor 集成 15 项全部通过，包含普通 Session、空闲门槛、用户输入/模型切换
  abort、debug log 与产品路由；
- permission auto-mode 16 项、AgentMesh360 60 项全部通过；`cargo check --tests`、
  Rustfmt、`git diff --check` 和 library + tests Clippy `-D warnings` 通过。

D1d2a 计划复盘：

- 本轮没有改变 laziness 何时启用，只替换产品 Session 真正发生远端分类时的 Sampling
  Authority；模型 Catalog 的 laziness 开关仍是 Harness 产品策略，不由 Provider
  Assignment 偷偷开启；
- side-query 复用同一 SamplerActor，Drop 仍触发现有 Cancel 命令，满足低内存和不可见
  辅助流要求；
- `aux:laziness:<uuid>` 不绑定用户 Prompt，符合 between-turn/background synthetic id
  约束；失败不缓存 credential，也不影响后续重新执行；
- 下一轮进入 D1d2b recap。

已完成子模块 D1d2b：

- 复核真实调用链后确认，一次 `handle_recap` 只有一次模型请求；此前“recap 多阶段调用”
  的描述不准确。每次手动/自动 recap 使用 `aux:recap:<uuid>` 和 `recap` role；
- 产品 Session 在构建请求前取得不可变 Host Route 与短生命周期内存配置快照，使用实际
  绑定 backend 决定 reasoning 清理、实际 context window 计算预算、实际 model 写入请求
  和 recap artifact；普通 Grok Session 保持原 `SamplingClient` 路径；
- 产品请求经现有 SamplerActor non-broadcast side-query 提交，只有 actor 接收后才写
  Turn Route；专用 `recap` Assignment 缺省时可审计地回退 main；
- 订阅失效或 Vault 凭据缺失在网络前失败，不推进 watermark、不修改 conversation；
  手动 `/recap` 仍发出 unavailable 事件清理客户端 spinner，后续可重新执行。

D1d2b 验证：

- 产品 recap E2E 2 项通过：专用 `recap-model`/独立 Key 和 main fallback 均使用实际
  Bearer/model，并只记录 `recap` Turn Route；
- recap display-only 16 项全部通过，验证成功和失败都不改变 Session conversation；
- laziness 15 项、permission auto-mode 16 项、AgentMesh360 60 项全部通过；
- `cargo check --tests`、Rustfmt、`git diff --check` 与 library + tests Clippy
  `-D warnings` 通过。

D1d2b 计划复盘：

- 代码复核发现同一 `recap.rs` 中的 `/btw`、AI shell command suggestion 和 prompt
  suggestion 是三个独立消费者，不属于 recap 的多阶段请求；原审计漏列了这些入口；
- 这些入口不能因文件同名而被误判为已经受 `recap` role 保护。它们已补入专项审计，
  计划在 memory 后以 D1d2d 收口，再进入 subagent；
- 下一轮进入 D1d2c memory。必须先确认每个 dream 阶段、重试边界、conversation/
  artifact 副作用和现有失败重试语义，再决定一次任务对应一条还是多条 logical route。

已完成子模块 D1d2c：

- 真实调用链不是一个多阶段 dream，而是三个彼此独立的单次推理消费者：
  dream consolidation、memory flush 和 memory note rewrite；三者统一使用 `memory`
  role，但分别创建 `aux:memory:dream:<uuid>`、`aux:memory:flush:<uuid>` 和
  `aux:memory:rewrite:<uuid>`；
- 产品 Session 的 `memory` Assignment 是模型权威：它覆盖普通 Session 的 ChatState
  dream model、可选 `flush_model` 和 rewrite 的 `grok-build` 默认值；普通 Session
  保留原有三条 direct SamplingClient/streaming 路径；
- Dream 与 Rewrite 通过现有 SamplerActor non-broadcast side-query 收集；Flush 先由
  actor 接收并写 Turn Route，再只把可取消的 Pending request 移入多线程 runtime，
  保留原“不阻塞 LocalSet”和 AbortOnDrop 语义；
- 每次调用重新执行 Access Guard、Binding/Lease 与 Vault 解析；失败保持原 dream 计数、
  flush error/锁释放、rewrite 错误返回语义，不回退 Grok default Provider。

D1d2c 验证：

- 产品 memory E2E 2 项通过：专用 `memory-model`/独立 Key 覆盖 Dream、Flush、Rewrite，
  main fallback 单独通过；三类 synthetic id 与实际 model 一致；
- 同一 E2E 验证订阅失效和 Vault 删除均零网络、零幽灵 Route；
- memory config 12 项、inline auto-compaction/memory flush 27 项、AgentMesh360 60 项
  全部通过；
- `cargo check --tests`、Rustfmt、`git diff --check` 与 library + tests Clippy
  `-D warnings` 通过。

D1d2c 计划复盘：

- 原计划只写了 memory dream，真实文件还包含 flush 和 note rewrite；三条路径现已同时
  收口，避免长期在线 Agent 在自动 flush 或用户保存 note 时旁路 BYOK；
- 三个操作互不重试、也不共享一次后台事务，因此各自一条 logical route 比人为复用
  Active route 更准确；只有单个操作内部未来增加重试时才复用对应 route；
- D1d2d 的范围保持为 `/btw`、command suggestion 和 prompt suggestion，不夹带
  subagent、Trace classifier 或 Provider UI。下一步从用户可见的 `/btw` 开始。

已完成子模块 D1d2d：

- `/btw` 为每次问题创建 `aux:side_question:<uuid>`，使用 `side_question`
  Binding/Lease；持久化的 BtwEntry model 改为实际 Host 绑定模型；
- AI shell command suggestion 与 prompt suggestion 共用 `suggestion` role，但分别使用
  `aux:suggestion:command:<uuid>` 和 `aux:suggestion:prompt:<uuid>`，失败继续返回 None；
- Product prompt suggestion 不再受 Grok 官方模型 Catalog 门槛影响，直接服从产品
  `suggestion` Assignment；普通 Grok Session 仍保留 env/config/client hint、
  Catalog guard、direct stream/collect 与 sanitize/repeat filter；
- 三条产品请求都走现有 SamplerActor non-broadcast side-query；专用 role 缺省时可审计
  回退 main，订阅或 Vault 失败不访问 Grok default Provider。

D1d2d 验证：

- 产品补充消费者 E2E 2 项通过：`side_question` 独立模型/Key、`suggestion` 独立
  模型/Key、main fallback、实际 Bearer/model 和三类 synthetic id 均正确；
- 同一 E2E 验证订阅失效和 suggestion Vault 删除零网络、零幽灵 Route；
- Recap/Session 辅助回归 18 项、prompt-suggest helper/config 28 项、AgentMesh360 60 项
  全部通过；
- `cargo check --tests`、Rustfmt、`git diff --check` 与 library + tests Clippy
  `-D warnings` 通过。

D1d2 总计划复盘：

- D1d2 没有建立额外 Agent 副本或 Sampling HTTP 栈，所有后台/旁路调用都复用当前
  Session 的 SamplerActor non-broadcast side-query，符合长期常驻与低内存约束；
- 最初只列 laziness/recap/memory，持续源码审计补出了 memory flush、note rewrite、
  `/btw` 与两类 suggestion；本轮已全部收口，没有用文件名替代真实调用点核验；
- Trace classifier 仍按调用来源决定是否属于产品 Session，不能在没有来源证据时强行
  绑定；D1d3 先处理已确认会复制默认 Grok config/AuthManager 的 subagent；
- 下一轮进入 D1d3。路由委托必须由 Host 注入、不可 serde、不可跨账户，父/子只共享
  非秘密关联标识，不能把 credential、Vault handle 或 bootstrap token放进 ToolContext。

本轮目标：

1. ~~D1d2a 先接 `laziness` role：产品 Session 的远端检测必须经实时 Access Guard、
   Binding/Lease 和 SamplerActor side-query；失败只跳过检测，不换 Provider；~~ 已完成
2. ~~D1d2b 接 `recap` role：每次任务使用独立 synthetic logical turn id，失败保留原会话
   与可重试状态；~~ 已完成
3. ~~D1d2c 接 `memory` role：后台 dream、flush 与 note rewrite 每次执行重新验证订阅，
   禁止从常驻 Session 缓存 credential 或 Grok default config；~~ 已完成
4. ~~D1d2d 收口复核新发现的 `/btw` 与 suggestion 辅助消费者；~~ 已完成
5. ~~为每个子模块分别覆盖专用 Assignment、main fallback、Vault/订阅失败零网络和普通
   Grok Session 回归。~~ 已完成

计划复盘后的顺序：

- laziness 是只读、可选质量检测，失败语义最窄，适合作为后台 Authority 的第一个接入点；
- recap 与 memory 可能跨用户 Turn 或在窗口不可见时运行，必须在 laziness 验证
  synthetic id、实时 Guard 和 side-query 隔离后再接入；
- D1d2b 已证明 request builder 可以安全读取同一租约的非持久化 config 快照，同时保持
  “actor 接收后才记账”；D1d2c 进一步确认每个 memory 操作是独立单次请求，不应在三个
  操作之间复用 route；
- D1d2 完成前不进入 subagent route delegation；Provider UI、Probe、Usage 和真实付费
  Provider E2E 仍不是本轮范围。

D1d2 验收条件已满足：所有已确认的 Session 后台/旁路消费者均使用对应 role 的真实
endpoint/model/credential，失败不切换 Provider，普通 Grok Session 原路径不变，专项
与全局回归通过。

### 循环 13：Provider 切片 D1d3——Subagent 路由委托

状态：已完成

本地提交：`a1628d1 feat: delegate product subagent provider routes`

本轮目标：

1. 追踪父 Session 从 tool call 到 `build_subagent_spawn_context`、子 Session spawn 和
   Sampling 的完整真实路径；
2. 定义 Host-only、不可序列化、账户绑定的 route delegation，使用 `subagent` role，
   缺省回退 main Assignment；
3. 子 Agent 每次模型请求仍由现有 SamplerActor 接收，父/子调用可审计但不复制默认
   Grok credential、AuthManager、Vault handle 或秘密配置；
4. 覆盖 parent Prompt → subagent spawn → mock Provider 成功链，以及订阅、账户、
   Assignment、Vault 和取消失败矩阵；
5. 完成代码后更新本进展文档、专项审计、产品蓝图并再次复盘 Provider M1 路线。

计划约束：

- 不为每个产品 Agent 或 subagent 创建常驻 Harness 副本；
- 不通过 ToolContext JSON、ACP startupHints serde 或 Session 持久化传递路由权力；
- 普通 Grok Session 的 subagent 继承逻辑保持不变；
- 本轮不实现 Provider UI、Probe、Usage、Trace classifier 或新协议。

D1d3 验收条件：产品父 Session 启动的 subagent 在无 Grok 登录时使用 `subagent`
Binding 的实际 endpoint/model/credential；actor 接收后记录可关联且不含秘密的 Turn
Route；专用 Assignment/main fallback 与失败矩阵通过；普通 Grok subagent 行为不变。

已经实现：

- `MvpAgent` 只从 Host 已认证的父产品 Session 派生 Rust-only
  `SubagentProductRoute::Delegated`；客户端 serde、ToolContext 和持久化状态均不能注入；
- 子 Session bootstrap 只保留 endpoint/model/backend/capability 等非秘密配置，主动清除
  API Key、Header、Bearer resolver、header injector、客户端身份与 attribution callback；
- 子 Agent 的每次主 Prompt 使用 `subagent` role 重新经过实时 Access Guard、
  Session Binding、Credential Lease 与既有 SamplerActor；未配置专用 Assignment 时按
  D1d0 规则回退 main，但 Turn Route 仍保留请求 role；
- 产品子 Agent 不继承 Grok `AuthManager`、auth method、API-key provider 或默认
  credential；普通 Grok subagent 保持原继承逻辑；
- 隐藏子 Session 的标题改为本地 fallback，不再为不可见标题额外发出一条无路由的
  Provider 请求；
- bootstrap/订阅/账户/Assignment/Vault 失败均在实际 Provider 提交前关闭，并保证
  Turn Route 为零；Session 历史和已有 Binding 不被删除。

验证证据：

- 真实 Host → 父产品 Prompt → `spawn_subagent` tool call → 子 Session Prompt →
  父 Prompt 续跑的本机 mock Provider E2E 通过；抓包分别验证父请求使用 main Bearer/
  model，子请求使用 subagent Bearer/model，且没有标题生成旁路；
- `xai-grok-shell agentmesh360 --lib`：62 项通过；
- `xai-grok-shell agent::subagent --lib`：288 项通过；
- subagent spawn context 专项：3 项通过；
- `cargo check -p xai-grok-shell --tests`、Rustfmt、`git diff --check` 与 Clippy
  `-D warnings` 通过。

D1d3 计划复盘：

- 没有建立新的 Agent Loop、常驻 Harness 副本或平行 HTTP 栈，子 Agent 仍是同一 Host
  内的隐藏 Session；
- 委托只传递账户绑定的 Host Authority，不传递 Vault handle 或秘密；子 Session
  bootstrap 的短暂 Lease 只用于验证路由和读取非秘密模型配置；
- 测试首次暴露出隐藏子 Session 标题会直接使用 bootstrap client；本轮没有掩盖抓包
  差异，而是取消这项无产品价值的模型调用，并用完整 E2E 固定为三次必要请求；
- 本轮没有提前实现 UI、Probe、Usage 或新协议，符合 D1d3 范围。

### 循环 14：D1 收口——Trace classifier 来源审计

状态：已完成；无需代码改造

源码审计结论：

- `trace_classifier` 只由独立的 `trace_classify` CLI 调用，用于读取离线 trace 文件并让
  操作者显式指定 `--api-key` / `XAI_API_KEY` / Grok `auth.json` 后做回放评估；
- 它不由 `MvpAgent`、产品 Session、Host ACP、后台 Agent 生命周期或桌面 Renderer 调用，
  也没有 Session/Agent/账户输入，不能合法解析产品 Assignment；
- 运行中产品 Session 的同类 laziness 检测已经在 D1d2a 接入 `laziness` Authority。
  因此把离线诊断 CLI 强行绑定产品 Provider 反而会混淆数据面和操作者工具边界。

计划复盘：D1 的产品 Session 推理旁路清单已经收口。外部真实付费 Provider 调用仍不是
这轮证明；当前证据是本机协议兼容 mock Provider。下一轮按既定路线进入切片 E，不跳到
动态 Package、后台 Supervisor 或新协议。

### 循环 15：Provider 切片 E1——最小 Renderer 管理桥

状态：已完成

本地提交：`f9a96a1 feat: expose secure provider management bridge`

本轮目标：

1. 复用现有 Host Provider 管理 ACP，不在 Electron/Renderer 建立第二份 Profile Store；
2. 向 Renderer 暴露账户内 Profile、Catalog、Assignment 与诊断状态的最小类型安全桥；
3. credential 只允许一次性写入/替换，提交后清空，任何读接口都不能返回秘密或
   Credential Ref；
4. 先完成本地格式校验与现有配置状态展示，不自动触发可能计费的模型 Probe；
5. 完成后再次更新本文档、产品蓝图与 Provider 专项计划，再决定 E2 设置页 UI 范围。

本轮非目标：不做付费 Probe、外部 Provider 计费 E2E、Catalog 在线更新、新协议或
Profile 自动迁移。

已经实现：

- 新增桌面 `ProviderController`，所有读写先检查 Identity 状态必须为 `ready`；订阅
  blocked/unavailable/signed_out 均不能借 Renderer IPC 管理 Provider；
- `getProviderSnapshot` 并行读取 Host 内的 Profile、Catalog 与 Assignment，不在
  Electron 创建副本数据库或缓存租户状态；
- 创建、更新、替换秘密、删除 Profile，以及 upsert/delete Assignment 均复用现有
  Host ACP；
- API Key 只存在于 create/replace 的一次性调用参数；输出递归删除 API Key、
  Authorization、Token、Header、Credential Ref 等秘密字段，同时保留
  `credentialConfigured` 与 `credentialLastFour` 供 UI 展示；
- 主进程对协议、认证方式、Base URL、模型 ID、scope/role、字段白名单和长度再次校验，
  Host Rust 校验仍是最终权威；
- preload 只暴露窄方法，不向 Renderer 暴露 Host client、access token 或通用 ACP
  调用能力。

验证证据：

- 桌面测试：24 项通过，1 项需真实 Host binary 的可选测试按原设置跳过；
- 新增测试覆盖 ready 门禁、递归脱敏、API Key 只写、credential-bearing URL/
  未知字段拒绝，以及 Assignment scope 约束；
- `npm run check` 与 `git diff --check` 通过。

E1 计划复盘：

- 现有 Host ACP 已具备完整管理操作，实际缺口是桌面安全桥；本轮据此缩小实现，没有
  重复 Provider Store、Catalog 或 Assignment 逻辑；
- Renderer 仍拿不到 Credential Ref，秘密字段即使因未来 Host 回归意外出现，也会在
  `ProviderController` 输出边界再次移除；
- 没有自动发 Probe 或外部模型请求，保存配置不会产生 Provider 费用；
- E1 只证明安全调用桥，不等于用户已经能在 UI 配置 Provider。

### 循环 16：Provider 切片 E2——最小设置页

状态：已完成

本地提交：`e42a06e feat: add provider routing settings workspace`

本轮目标：

1. 把侧边栏“设置”改为可访问的 Provider 设置视图，加载 E1 snapshot；
2. 展示预设/自定义 Profile、协议、Base URL、已配置凭据尾号与 enabled models；
3. 支持创建/编辑 Profile、替换 Key、删除，以及 global/agent role Assignment；
4. 提交成功后立即清空 DOM 中的 Key 输入，并从 Host 重新加载公开 snapshot；
5. 明确显示“保存不会测试模型或产生费用”，把付费最小推理 Probe 留到用户主动操作。

验收条件：登录与订阅门禁页面不回归；键盘可操作；错误不回显秘密；界面刷新后不保留
Key；桌面单测、语法检查和真实浏览器视觉 smoke 通过。

本轮非目标：不做 Session Binding 迁移 UI、自动 Provider fallback、付费 Probe、
Catalog 在线更新或外部 Provider 发布验收。

已经实现：

- 侧边栏新增可键盘操作的“Provider 设置”，登录/订阅页面和常驻 Agent 首页保持原入口；
- 设置页从 E1 snapshot 展示 Profile 数、Assignment 数、Catalog revision、公开端点、
  协议、enabled models、凭据配置状态和尾号；
- 支持按 Catalog 预设填充 OpenAI/xAI/Anthropic 等配置，也支持自定义三协议兼容端点；
- 支持创建/编辑/删除 Profile，编辑时可选替换 Key；Key 提交前即从当前表单值复制，
  随后立即清空输入，操作完成后重新从 Host 拉公开 snapshot；
- 支持 global/agent 范围和 `main`、`subagent`、`vision`、`compaction`、`memory`
  等稳定 role 的 Assignment upsert/delete；
- 界面明确标注“保存不自动测试模型，也不产生 Provider 费用”，没有实现静默 fallback
  或自动付费请求；
- 切换账户、退出、blocked 或 unavailable 时清除 Renderer 内存中的 Provider snapshot，
  防止跨账户保留公开配置。

验证证据：

- 桌面单元/契约测试：24 项通过，1 项可选真实 Host 测试按原配置跳过；
- Electron 交互 smoke 验证预设填充、一次性 Key 提交、提交后输入为空且 DOM 不含 Key，
  以及 global/main Assignment 参数；
- 1180×760 Retina 视觉 smoke 分别检查设置页首屏、滚动底部和原常驻 Agent 首页：
  Profile 卡片、路由矩阵、表单尾部均可见，无横向溢出，旧首页无回归；
- `npm run check`、smoke 脚本语法检查与 `git diff --check` 通过。

E2 计划复盘：

- 前端设计保持现有深色持久 Agent 工作台，新增的是“路由控制台”而非另一套应用；
  Profile→Role→Provider 的视觉关系与 Host Authority 状态被放在首屏；
- UI 没有持有 Host client、Vault handle 或 Credential Ref；重新加载只读取 E1 公共快照；
- 本轮实现了 global/agent Assignment，刻意没有提供 Session Binding 迁移入口，避免在
  没有兼容性预检时让用户误以为可以无损换 Provider；
- 真实外部 Provider、Probe、Usage、Catalog 在线更新和发布验收仍未实现，文案没有把
  本机 mock E2E 误写成外部 Provider 已验证。

### 循环 17：Provider 切片 E3——显式分级 Probe

状态：已完成

本轮目标：

1. 定义 Probe 请求/响应和审计记录，区分 `local_validation`、`metadata` 与
   `minimal_inference`，每一级都必须由用户明确触发；
2. `local_validation` 只做格式、协议、端点分类、模型/Assignment 一致性检查，零网络；
3. `metadata` 只有在 Provider 明确存在非计费元数据接口时才可启用，否则显示“不支持”，
   不把 401/404 伪装成模型不可用；
4. `minimal_inference` 显示可能产生 Provider 费用并二次确认，使用临时 Probe Turn，
   不改变任何产品 Session Binding 或历史；
5. 结果只保存非秘密诊断摘要、时间和级别，不保存请求正文、响应正文、Key 或 Header。

验收条件：保存 Profile 仍然零网络；blocked/订阅失效时不可 Probe；取消确认零网络；
失败不切换 Provider；请求只使用被测 Profile 的短时 Vault lease；UI 清楚区分“格式有效”
和“真实模型已响应”。

本轮非目标：不实现自动周期健康检查、后台付费 Probe、Session 自动迁移、Provider
fallback 或 Usage 计费汇总。

#### E3a Host Probe 合同检查点

本地提交：`b8f7ad0 feat: add explicit provider probe contract`

已经实现：

- `state.db v6` 新增账户隔离的 `provider_probe_results`，只保存级别、状态、Provider /
  Model 标识、端点分类、Assignment 数量、稳定摘要、时间与时延，不保存 Key、Header、
  请求正文或响应正文；
- 新增 `providers/probes/run` 与 `providers/probes/list` Host ACP 方法，并置于通用
  Provider 方法分发之前，避免被旧 Provider handler 误接；
- `local_validation` 校验 Profile、启用模型、端点、协议与 Vault credential，全程零网络；
- 当前 Catalog 未声明非计费元数据端点，因此 `metadata` 明确返回 `unsupported`，
  全程零网络，不用 401/404 猜测模型状态；
- 未二次确认的 `minimal_inference` 返回 `confirmation_required` 且零网络；确认后才使用
  被测 Profile 的非序列化短时 Vault lease 与既有 Grok Sampling Client 发出一次
  20 秒超时、16 token 上限、无工具的 Probe；
- Probe 不读取或创建 Session Provider Binding，不写 Turn Route，不改变产品 Agent
  的 Session 历史或路由；订阅不可用时在任何网络调用前失败关闭。

验证证据：

- 4 项 Provider Probe 定向测试通过：本地/元数据零网络、付费确认闸门、确认后真实
  Responses SSE mock 请求、订阅拒绝零网络；
- 1 项 Probe lease 定向测试通过：无需 Session Binding，可投影三协议所需配置且
  序列化与 Debug 均不含秘密；
- 1 项 `state.db v6` 初始化测试通过；`cargo fmt --all -- --check` 与
  `git diff --check` 通过。

E3a 计划复盘：

- Host 仍是订阅、Vault、网络权限、Provider 路由和审计摘要的唯一权威，Renderer
  不会拿到 credential ref 或 Host client；
- “保存 Profile”路径未接入 Probe，继续保证保存配置不联网、不测试模型、不产生费用；
- Catalog 没有足够证据时选择可审计的“不支持”，没有为了表面成功增加私有 Provider
  特判或隐式 fallback；
- 下一切片 E3b 只接公开 Probe 契约、用户确认和结果显示，不在前端复制鉴权或采样逻辑。

#### E3b 桌面显式 Probe 检查点

本地提交：`d7daae6 feat: add explicit provider probe controls`

已经实现：

- Desktop Host Client、主进程 IPC 与 preload 窄桥接通 Probe run/list；Provider
  Controller 在 `ready` 状态下才允许调用，并再次校验 Profile、Model、level 与
  `confirmPaidInference`；
- Provider snapshot 加入最多 100 条 Host 非秘密 Probe 记录，沿用递归秘密字段剥离与
  跨账户/blocked 时 Renderer snapshot 清理；
- 每个 Profile 可选择已启用模型，并显式触发“本地检查”“元数据”“真实响应”；
- “真实响应”按钮标记“可能计费”并在 Renderer 二次确认；用户取消时不调用 IPC，
  Host 仍保留第二道确认闸门；
- 最新结果独立显示“本地配置有效”“元数据检查不支持”“模型已真实响应”或失败，
  同时明确“零网络”或“已向 Provider 发出请求”，不把格式有效伪装成模型可用；
- Probe 完成后不自动切换 Assignment 或 Session Binding，保存 Profile 仍不自动联网。

验证证据：

- 完整 AgentMesh360 Rust 回归：67 项通过；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings` 通过；
- 桌面单元/契约测试：26 项通过，1 项可选真实 Host 测试按原配置跳过；
- Electron 交互 smoke 通过：取消付费确认零 IPC、本地检查参数、确认后最小推理参数、
  Key 清空和 DOM 无秘密；
- 1180×760 Retina 设置页首屏、底部与原常驻 Agent 首页截图已人工检查：Probe
  控件/结果无横向溢出，付费和网络语义可见，旧首页无回归；
- `npm run check`、Rustfmt 与 `git diff --check` 通过。

E3 完成复盘：

- E3 满足原验收条件，并且没有加入自动周期检查、后台付费 Probe、fallback、Session
  自动迁移或 Usage 汇总；
- 网络权限、Vault lease、超时、采样与审计仍全部属于 Host；Renderer 只负责显式意图
  与展示，没有复制 Provider client；
- 现有通过证据仍是本机协议级 mock，不等于 OpenAI、xAI、Anthropic 或 Gemini
  外部账号已完成付费 E2E；正式 Provider 预设继续以独立契约证据为准。

### 循环 18：Provider 切片 F0a——Gemini 官方边界与契约 Harness

状态：已完成；真实 Provider F0b 受外部凭据和 thought state 缺口阻断

本轮目标：

1. 以 Google 官方文档为准，固化 OpenAI 兼容端点、认证、模型与已知兼容边界；
2. 建立可复用的 Provider 兼容契约套件，覆盖 Streaming、Tool Call、Reasoning、
   Structured Output，并把 thinking 状态保真作为独立准入门，而不是只检查 `/models`；
3. 增加显式 opt-in 的真实 Gemini 契约入口，缺少用户提供的 Gemini Key 时明确跳过，
   不读取现有 Provider Vault 或其他环境秘密；
4. 只有真实兼容契约通过后才把 Gemini 加入内置官方预设；未通过期间用户仍可通过
   Compatible Profile 自行配置；
5. 单独记录哪些需求必须使用 Gemini Native / Interactions，不能把兼容端点能力外推。

验收条件：文档与测试不含 Key；默认测试零外部费用；真实测试必须显式环境开关、逐项
报告能力和安全脱敏；任何未验证能力保持 `unknown`；失败不修改 Catalog 或现有 Profile。

本轮非目标：不实现 Gemini Native / Interactions、Google Search/Files/Live、Vertex
ADC、远端 Catalog、自动 fallback，也不在没有真实契约证据时发布 Gemini 官方预设。

已经实现：

- 以 Google 2026-07-21 更新的一手文档核验官方 Base URL、Bearer 认证、Chat
  Completions、Streaming、Function Calling、Structured Output、`reasoning_effort`
  和兼容层 beta 边界；
- 新增 Provider-neutral `run_openai_chat_contract`，通过现有 Grok
  `SamplingClient` 依次检查 Streaming 文本、Tool Call/JSON 参数、strict Structured
  Output 和 Reasoning 请求，不建立平行 HTTP 栈；
- 默认 mock 契约验证四次请求的 endpoint、Bearer、stream、Tool、Schema 与
  `reasoning_effort` wire shape，并验证响应解析和 Target Debug 不泄露 Key；
- 新增真实 Gemini ignored test，同时要求
  `AGENTMESH360_GEMINI_CONTRACT=1`、专用 API Key 和显式模型，避免
  `cargo test --ignored` 意外花费或读取 Provider Vault；
- 源码审计确认 Chat request/response/Session 类型当前没有 Google `extra_body` 与
  thought signature 保真通道；Google 官方又要求无状态多轮场景原样回传 signature，
  因而将它列为持久 Agent Catalog 准入阻断项；
- 内置 Catalog 单测显式拒绝提前加入 Google 官方 endpoint；完整结论、运行方式和
  F0b 准入门见
  [`architecture/GEMINI_OPENAI_COMPATIBILITY_SPIKE.md`](architecture/GEMINI_OPENAI_COMPATIBILITY_SPIKE.md)。

验证证据：

- `test_provider_contracts`：3 项本机零费用测试通过，1 项真实 Gemini 测试按设计忽略；
- 完整 `xai-grok-shell agentmesh360 --lib`：67 项通过；
- 新契约测试目标的 Clippy `-D warnings`、Rustfmt 与 `git diff --check` 通过；
- 没有设置或读取任何 Gemini Key，没有对 Google 发网络请求，没有产生 Provider 费用；
- 真实 Gemini、跨轮 Tool Loop、跨重启 signature 回放仍未验证，因此 Catalog 保持不变。

F0a 计划复盘：

- 没有因为官方文档列出能力就伪造 `probe_verified`，也没有把当前示例模型硬编码进
  Catalog；
- 契约复用产品实际 SamplingClient，而不是用 curl 成功代替 Harness 兼容；
- 双重 opt-in、Key 脱敏和零重试减少了意外计费与秘密暴露风险；
- 发现的 signature 缺口直接改变准入结论：即使基础四项真实测试通过，Gemini 仍不能
  自动成为持久产品 Agent 的正式预设。

### 循环 19：独立后台 Host G0——生命周期现状审计与协议设计

状态：已完成

本地提交：`fa92433 feat: keep agent host alive across desktop sessions`

启动理由：F0b 需要用户明确提供外部 Gemini 测试凭据，而且 thought signature 的真实
wire shape 不能靠猜测；该外部门槛不应阻塞所有持久 Agent 共同需要的后台 Host。

本轮目标：

1. 画清 Electron、Host 子进程、Session Store、Vault 与订阅重验的实际生命周期；
2. 定义单实例 Host ownership、socket/lock、版本握手、UI attach/detach 和优雅退出协议；
3. 增加只读诊断，并固定 UI detach 后 Host 存活、第二个 UI 重连的真实验收脚本；
4. 先形成 ADR 与最小 Supervisor seam，再决定 macOS LaunchAgent/登录项实现范围；
5. 模块完成后再次更新本文档、复核蓝图并进入 G1。

本轮非目标：不立刻注册系统自启动、不改 Provider Vault 格式、不实现后台自动付费
Probe、不加入 Gemini 预设、不迁移动态 Agent Package。

验收条件：现状与目标态不混写；单实例/版本不匹配/孤儿 Host/订阅失效/桌面重连都有
明确状态机；诊断不含 access token、Provider Key 或用户对话；默认测试不改系统登录项。

已经实现：

- 源码审计确认 Grok Build 已有 `connect_or_spawn`、UDS/Named Pipe、文件锁、PID、
  `LeaderReady`、多客户端、版本门槛、旧 Leader 让位和有界重连；因此取消“另造
  Supervisor 协议”的假设，直接采用上游成熟 Leader；
- 桌面默认命令从 `agent --no-leader stdio` 改为 `agent --leader stdio`；Electron
  只拥有可丢弃 Bridge，`AcpHostClient.stop()` 不再终止独立 Leader；
- 默认把 `GROK_LEADER_SOCKET` 固定为
  `$AGENTMESH360_HOME/run/host.sock`，隔离用户日常 Grok Leader；保留显式
  `embedded` 诊断模式；
- 新增只读运行状态，只返回 mode、ownership、transport、Bridge 状态和 socket
  文件名，不返回环境、完整路径、Token、Key 或对话；
- 运行目录以 `0700` 创建；macOS/Linux 在 spawn 前拒绝超过 100 bytes 的 socket
  路径。真实测试最初确实触发了 macOS `SUN_LEN`，修复后不再等待 IPC 超时；
- 新增真实持久生命周期契约：第一个 Bridge bootstrap 并激活 Job Agent，记录
  Leader PID 与 Main Session；detach 后确认 PID 仍存活；第二个 Bridge 采用相同
  PID 并恢复相同 Main Session；结束后 TERM/KILL 兜底清理测试 Leader；
- 形成
  [`architecture/ADR_BACKGROUND_HOST_LIFECYCLE.md`](architecture/ADR_BACKGROUND_HOST_LIFECYCLE.md)，
  明确退出 UI、退出账号、订阅到期、Leader 崩溃、版本替换和系统启动的不同语义。

验证证据：

- `npm run check` 通过；
- 完整桌面测试（带真实 Host）：34 项通过、0 跳过；
- 其中 embedded 真实 Host 继续验证订阅准入/到期拒绝，持久 Leader 真实测试验证
  detach/re-attach 与固定 Main Session；
- `git diff --check` 通过；
- 测试使用专属临时 HOME、`GROK_HOME`、`AGENTMESH360_HOME`、socket 与 localhost
  Core，没有读取真实身份或 Provider 凭据；
- 测试结束后只读进程检查未发现残留的临时 Leader。

G0 计划复盘：

- 没有为 Job/LectureCast/Deploy 分别复制完整 Harness，仍是一份 Leader 承载多个
  产品 Agent；
- 没有重复实现 socket/lock/PID/版本协议，减少 Fork 长期同步面；
- 没有把“UI 可重连”夸大为“系统重启后已自动恢复”：登录项、后台身份刷新和
  Electron 不运行时的崩溃重启仍未完成；
- 没有顺手切换 `GROK_HOME`，避免 Registry 已引用的既有 Session 因缺少迁移而
  突然不可见；
- 普通测试显式使用 embedded 模式，不创建用户目录或后台进程；真实 Leader 测试
  才显式 opt-in。

### 循环 20：独立后台 Host G1——崩溃重建与准入恢复

状态：已完成

本地提交：`dcbc81a feat: restore host access after leader reconnect`

启动理由：G0 已证明 UI detach/re-attach，但 Leader 自身被杀死后，新 Leader 不会
自动继承只存在内存中的 AgentMesh360 准入。上游 Bridge 能重连和回放 ACP
initialize/session load，产品层还必须监听重连并通过现有 Refresh Token 再次向 Core
和新 Host bootstrap，否则会出现“进程恢复、产品 Agent 仍被门禁”的假恢复。

本轮目标：

1. 将上游 `x.ai/leader_reconnected` 提升为桌面 Host 生命周期事件；
2. Identity Controller 收到事件后复用现有串行 revalidate，重新刷新身份并 bootstrap
   新 Leader，不缓存或回放旧 Access Token；
3. 合并重连风暴，防止并发刷新 Token 或重复 bootstrap；
4. 增加 Leader SIGKILL 故障注入，验证新 PID、同一 Main Session 和有效订阅恢复；
5. 更新 ADR 与进展，再把系统登录启动/隐藏后台主进程拆为 G2。

本轮非目标：不注册系统登录项、不把 Refresh Token 移交 Rust Host、不新增后台付费
Probe、不迁移 `GROK_HOME`、不实现跨版本数据格式迁移。

验收条件：Leader 被终止后，Bridge 使用上游有界重连；桌面只用安全存储中的 Refresh
Token 获取新 Access Token；新 Host 重新执行订阅硬门禁；失败保持 `unavailable`，
不得沿用旧准入；真实故障测试不遗留进程或临时数据。

已经实现：

- ACP Client 识别上游 `x.ai/leader_reconnected`，只发出无 Session ID 的内部
  `reconnected` 生命周期事件；
- Identity Controller 监听生命周期事件，等待正在进行的身份操作结束，并把同一恢复
  窗口内的重复通知合并成一次 `revalidate('host_reconnected')`；
- 恢复不缓存旧 Access Token：重新读取安全存储中的 Refresh Token，向 Core 轮换新
  Token，校验 Core bootstrap，再 bootstrap 替代 Host 并刷新 Agent 列表；
- Core 刷新或 Host bootstrap 失败时清除公开 Agent 工作区并进入 `unavailable`，
  不让新 Leader 沿用旧准入；
- shutdown 会先移除重连监听并等待正在进行的恢复，再 detach Bridge，避免退出过程
  另起恢复；
- 真实生命周期测试现在包含 Leader `SIGKILL`：上游 Bridge 重连到新 PID，真实
  Identity Controller 完成第二次 Token 刷新和 Core/Host 双重验证，Job Agent Main
  Session 保持不变。

验证证据：

- `npm run check` 通过；
- 完整桌面测试（带真实 Host）：36 项通过、0 跳过；
- 单元测试证明三次重连通知只产生一次额外 refresh/bootstrap，并证明 Core 刷新失败
  后旧 Agent 状态和旧 Access Token 都不出现在公开状态；
- 真实故障注入验证 detach/re-attach、Leader PID 替换、产品准入恢复与固定 Session；
- `git diff --check` 通过；
- 真实测试仍使用临时 HOME/Grok Home/AgentMesh Home 与 localhost Core，清理路径
  覆盖“尚未读到 PID 就失败”和 TERM 超时后的 KILL 兜底。

G1 计划复盘：

- 没有把 Access Token 存入磁盘或 Host Registry，仍由 Electron 主进程短期持有；
- 没有因为上游进程恢复成功就默认放行产品 Agent，新 Leader 必须重新通过 Core 和
  Host 双重订阅验证；
- 没有建立第二套进程重启器，进程重建仍由 Grok Leader 完成，产品层只恢复身份；
- 没有提前注册登录项。系统登录启动涉及后台窗口、用户选择、退出语义与安全存储
  可用性，必须作为独立 G2 模块实现和验收。

### 循环 21：独立后台 Host G2——系统登录启动与隐藏后台主进程

状态：已完成源码与开发验收；签名安装包平台 E2E 保留为发布门槛

本地提交：`9524cca feat: add hidden login startup lifecycle`

启动理由：G0/G1 已覆盖 UI detach 和前台主进程存活时的 Leader 崩溃，但机器重启后
没有进程读取 Electron `safeStorage` 中的 Refresh Token，也就不能安全恢复订阅准入和
产品 Agent pin。不能只把 Host 二进制塞进登录项，因为 Rust Host 无权直接读取当前
Electron 身份存储。

本轮目标：

1. 定义显式的后台启动参数，系统登录启动时不创建可见 BrowserWindow；
2. 由轻量 Electron 主进程恢复 Refresh Token、执行 Core/Host bootstrap、维持周期
   订阅重验，并让 Renderer 保持未创建；
3. 用户正常打开应用时，单实例事件在同一主进程创建并聚焦窗口；
4. 建立可注入、默认不修改系统设置的 Login Item 控制器与单测，再决定首次启用时机；
5. 明确退出 UI、停用开机启动、退出账号、更新与卸载的不同语义。

本轮非目标：不把 Refresh Token 复制给 Rust Host、不创建第二份常驻 Harness、不实现
菜单栏产品、不改 Provider Vault、不在测试中修改真实 macOS Login Items。

验收条件：后台启动无可见窗口和 Renderer；订阅无效时不恢复 Agent；第二实例可打开
窗口；所有系统设置调用都可注入并在单测中零副作用；文档明确用户如何停用后台启动。

已经实现：

- 依据 Electron 43 官方契约，macOS 使用 `wasOpenedAtLogin`，不使用 macOS 13+
  已失效的 `openAsHidden`；Windows 使用 `--agentmesh360-background`；
- 单实例锁通过 `additionalData.openWindow` 区分系统后台启动和用户正常打开，避免
  依赖可能被 Chromium 修改/重排的 commandLine；
- 后台启动不创建 BrowserWindow/Renderer，并隐藏 Dock；正常第二实例或 Dock activate
  会在同一个主进程创建、恢复并聚焦窗口；
- 后台主进程继续通过 Electron `safeStorage` 恢复 Refresh Token，执行现有 Core/Host
  双重 bootstrap 和周期订阅重验；没有本机身份时自行退出；
- 正式打包版在 Agent 第一次从停止态激活为 `running` 时请求启用 Login Item；只是
  打开已经常驻的 Agent 不会反复覆盖用户的系统选择；
- 开发版拒绝 Login Item 写入；操作系统拒绝注册不会回滚已经成功的 Agent 激活；
- 新增只读 Host/Login Item IPC 与“客户端设置”页，展示 Leader/Bridge/socket 文件名、
  登录项启用/批准状态，并允许用户关闭；关闭不会删除 Session 或停止当前 Host；
- `requires-approval` 明确提示 macOS“系统设置 → 通用 → 登录项”批准。

验证证据：

- `npm run check` 通过；
- 完整桌面测试（带真实 Host）：46 项通过、0 跳过；
- Login Item/启动单测覆盖 macOS/Windows、开发版零写入、首次激活只写一次、OS 拒绝
  不回滚、后台零窗口和第二实例开窗；
- 实际 Electron 后台 smoke 使用隔离 `userData`，输出
  `background startup: no Renderer created` 后自行退出并清理；
- 1180×760 Retina 客户端设置页截图已人工检查：双栏层级、状态、关闭语义和安全说明
  清晰，无横向溢出；fixture 开关交互已断言从“已开启”切到“未开启”；
- 真实系统 Login Item 没有被测试修改；签名/公证安装包 E2E 未执行，因此不把平台
  注册、批准和升级行为标记为生产已验证。

G2 计划复盘：

- 没有把 Refresh Token 复制给 Rust Host，也没有为了开机恢复增加第二套 Harness；
- 没有用过时的 `openAsHidden` 假装实现后台启动；
- 用户可以在客户端和系统设置中关闭登录启动，激活失败与 Login Item 失败保持两个
  独立结果；
- Provider F0b 仍受外部 Gemini 凭据与 thought signature 缺口阻断；完成共同 Host
  生命周期后，应回到最初要求的动态 Agent 集成主线，而不是继续无限扩张桌面壳。

### 循环 22：动态 Agent Package H0——统一 Manifest 与内置目录迁移

状态：已完成

启动理由：共享 Host 生命周期和 Provider Control Plane 已有可验证基础。当前
Job/LectureCast/Deploy 仍硬编码在 Registry，无法满足“未来新增 Agent 同时可作为宿主
Skill 安装、又可无客户端发版进入持久 Agent 客户端”的原始要求。

本地提交：`b4c0be8 feat: derive product agents from package manifests`

本轮目标：

1. 对照现有三个 Agent Skill 安装方式与产品蓝图，定义版本化 Agent Package Manifest；
2. 让同一 Package 描述产品身份、Main Session、AgentDefinition、Workspace、Skill
   Adapter、权限和 Provider Policy，禁止桌面/Skill 两套元数据漂移；
3. 先把三个内置 Agent 改由内置 Manifest 载入，保持现有 agent_id、确定性 Session
   和账户隔离不变；
4. 建立只读 Package Catalog/Registry 与迁移测试，不在 H0 下载或执行远端代码；
5. 明确后续签名、安装事务、升级/回滚和宿主 Skill Adapter 的 H1/H2 边界。

本轮非目标：不接远端 Marketplace、不执行未签名脚本、不改变现有 Session UUID、
不自动更新 Agent、不实现 Package 付费、不把 Skill 运行时塞进 Renderer。

验收条件：三个内置 Agent 完全来自同一 Manifest Schema；旧 `state.db` 无数据丢失；
未知字段/版本/权限失败关闭；Package 元数据不含 Provider Key、Token 或用户业务数据；
文档明确客户端持久 Agent 与宿主 Skill 是同一 Package 的两个受控投影。

已经实现：

- 新增严格的 Agent Package Manifest v1：Package/Agent 身份、SemVer、发布来源、
  请求权限、Main Session/Workspace 策略、AgentDefinition、Model Policy、
  Canonical Workflow 与宿主 Skill Adapter 使用同一 Schema；
- Job Agent `0.4.7`、LectureCast Agent `0.4.0`、Deploy Agent `0.1.1` 各自拥有
  独立内置 Manifest；Adapter 完全来自现有仓库事实，不为 Deploy 虚构尚不存在的
  Skill；
- 删除 Registry 的 `BUILTIN_AGENTS` 和独立 `profiles.rs` 硬编码；Registry 目录、
  激活 Profile、确定性 Main Session、账户 Workspace 与 RouteCompiler Model Policy
  均从同一 Manifest 投影；
- 新增订阅门禁后的只读 ACP
  `x.agentmesh360/agent-packages/catalog`；它只返回 Package 公共元数据，不返回
  Vault 句柄、密钥、Token、账户、Session、Workspace 实际路径或用户数据；
- 未支持 Schema、未知字段/权限、非法 SemVer、重复身份/排序/Adapter、路径穿越和
  带凭据/参数的源 URL 全部失败关闭；内置 Catalog 无旧硬编码 fallback；
- 旧 `state.db` 认领/升级回归证明 Main Session、Workspace、激活时间和运行意图
  保持不变，同时 Package 管理的展示元数据和版本更新到 Manifest；
- 新增
  [`architecture/AGENT_PACKAGE_MANIFEST_V1.md`](architecture/AGENT_PACKAGE_MANIFEST_V1.md)，
  固定“一个 Package、客户端持久 Agent 与宿主 Skill 两个受控投影”的边界。

验证证据：

- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：72 项通过；
- Package 失败关闭专项：6 项通过；
- Registry/旧状态兼容专项：5 项通过；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings` 通过；
- Rustfmt（显式 workspace edition 2024）与 `git diff --check` 通过；
- 测试没有下载、解包或执行远端 Package，没有读取 Provider Key 或真实用户数据。

H0 计划复盘：

- 与蓝图一致：客户端持久 Agent 和宿主 Skill 已共享一个 Manifest 来源，稳定
  `agentId` 继续保护 Main Session 身份；
- Model Policy 不再停留在文档字段，Initial Binding 与显式切换都会读取对应
  Package Policy；
- `requestedPermissions` 仍是声明，不会绕过 Host/Sandbox/Core 权限边界；
- H0 没有把“可读取 Manifest”夸大为“已支持动态安装”：签名、staging、原子提交、
  权限差异确认、迁移与回滚均未实现；
- 三个内置 Package 仍随 Host 二进制发布，因此下一轮必须先建立可信本地安装事务，
  再连接远端 Registry。

### 循环 23：动态 Agent Package H1——签名产物与原子安装事务

状态：已完成源码、自主测试与两轮 Kimi 交叉测试；生产发布密钥和安装入口保持关闭

H1a 本地提交：`8d0a865 feat: verify signed agent package artifacts`

H1b 本地提交：`cde8195 feat: add atomic agent package registry`

H1c 修复提交：`1903b46 fix: harden agent package integrity lifecycle`

启动理由：H0 已消除 Agent 定义的双重硬编码，但 Package 仍是编译期资源。若现在直接
接远端 Registry，损坏、路径穿越、签名伪造或半完成升级都可能污染 Active Agent。
必须先完成本地可信安装边界，再允许任何网络分发。

本轮目标：

1. 定义确定性的 Package 文件清单、内容摘要、签名信封与受信发布者密钥；
2. 安装前在隔离 staging 校验签名、Schema、路径、解包大小、Host/Schema 兼容性和
   `agentId` 不变约束；
3. 建立 Active/Previous 版本的本地 Package Registry，通过原子目录切换提交，
   失败不改变当前 Active Package；
4. 权限集合增加时返回 `approval_required`，不得静默升级；
5. 增加篡改、未知密钥、Zip/Tar 路径穿越、断电式中断、升级与回滚回归；
6. 模块完成后再次更新本文档和产品蓝图，再规划 H2 远端 Registry 与宿主 Skill
   安装投影。

本轮非目标：不连接线上 Package Registry、不自动更新、不执行 Package 脚本或迁移、
不允许第三方自签名信任、不在 Renderer 解包、不把 Provider/订阅凭据写入 Package。

验收条件：只有受信签名且完全校验通过的 Package 才能成为 Active；安装失败和进程
中断保留旧 Active；权限增加必须显式批准；回滚不改变 `agentId` 或 Main Session；
所有测试使用临时目录和测试密钥，不修改真实安装目录。

H1a 已经实现：

- 定义外部 JSON 签名信封：Schema、`keyId`、publisher、Package 身份、版本、
  Artifact SHA-256 与 Ed25519 签名进入确定性签名文本；
- 采用 `ed25519-dalek 2.2` 的 strict verification，同时检查 scalar 与 group element
  malleability，不用“普通 verify 成功”降低 Package 唯一签名要求；
- `.ampkg.tar.zst` 完整 Artifact 先验签，再创建 staging；包内
  `package-files.v1.json` 对所有其他普通文件按唯一排序逐项核对路径、大小和 SHA-256；
- 限制 Artifact/单文件/解包总量/文件数，拒绝路径穿越、绝对路径、反斜杠、重复文件、
  symlink、hardlink、未知 entry 和缺失引用；
- 解包后再次交叉检查签名信封与 Manifest 的 publisher、`packageId`、version，并确认
  Canonical Workflow 和每个 Skill Adapter 都是真实文件；
- Unix staging 目录/文件分别设为 `0700`/`0600`；失败或未提交对象析构时删除 staging；
- 生产信任根保持空集合：正式发布公钥未审计前，外部 Package 一律拒绝；只有单测
  可以注入临时测试密钥。

H1a 验证证据：

- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：78 项通过；
- H1a 专项 6 项通过：合法签名、Artifact 篡改、未知 key、路径穿越、未列出文件、
  签名/Manifest 身份不一致；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt edition 2024 与
  `git diff --check` 通过；
- 验证完全离线，使用临时目录与固定测试私钥；未连接远端 Registry，未修改真实
  Package 安装目录，未读取用户或 Provider 凭据。

H1a 计划复盘：

- 顺序与蓝图一致：先建立 Host-owned 信任与 staging，再做安装入口或网络分发；
- 签名只证明受信发布者与 Artifact 完整性，不自动授予 Manifest 声明的权限；
- 没有伪造生产公钥或用测试 key 进入正式 Trust Store；
- 当前 `VerifiedStagedPackage` 仍是短生命周期验证对象，尚未成为 Active，也没有接入
  Agent Registry；因此 H1b 必须先完成文件系统提交与 Registry 指针的一致性。

H1b 紧接着实现：

1. 不可变版本目录和 Active/Previous 本地 Registry；
2. staging → 版本目录的同文件系统原子 rename，再以 SQLite transaction 提交指针；
3. `agentId` 不变与权限增量 `approval_required`；
4. 数据库提交失败留下的只能是未引用版本，旧 Active 指针保持不变；
5. 显式 rollback 交换 Active/Previous，保持产品 Main Session 身份。

H1b 已经实现：

- `state.db` 升级为 v8，增加并加固全客户端级 `agent_package_registry`；Package 安装状态
  不复制到每个订阅账户，产品 Agent 实例和 Main Session 仍按账户隔离；
- Registry 对每个 `packageId` 保存 Active/Previous 的版本、Artifact digest、相对
  不可变目录、批准权限和签名 key ID，并用 CHECK 约束 Previous 必须全有或全无；
- 首次安装和升级都计算权限增量；缺少显式批准时返回 `approval_required`，不创建
  Active 记录；
- staging 文件先同步，再以同文件系统 rename 进入版本目录；SQLite transaction
  使用 expected Active digest 防并发覆盖，数据库失败只留下未引用目录；
- 一个 `agentId` 不能被两个 Package 占用，升级不能改变稳定 `agentId`，同版本不能
  换 digest，低版本不能走普通升级；
- 显式 rollback 在一个事务中交换 Active/Previous，Manifest 身份必须仍与
  `packageId`、`agentId` 和 Previous 版本一致；
- v6→v8 迁移回归保留既有产品 Agent Main Session，H0 的旧 v2/v3/v4 数据回归继续
  通过；
- Package 根目录在 Unix 为 `0700`；重复安装同一 digest 只有在 Active 目录仍存在时
  才按幂等成功处理。

H1b 验证证据：

- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：83 项通过；
- Package Artifact + Installer 专项：10 项通过；
- state v7→v8 与 v2/v3/v4/v6→v8 迁移专项：8 项通过；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt edition 2024 与
  `git diff --check` 通过；
- 中断注入证明 rename 后 Registry 提交失败时，旧 Active/Previous 不变，新目录只
  是未引用 orphan；
- 所有安装/升级/回滚测试均使用临时目录和伪造 digest；生产 Trust Store、真实安装
  目录、网络、Provider Key 和用户数据均未触及。

H1c 本机 Kimi 独立交叉测试与修复：

- 本机 Kimi Code `0.26.0` 独立审查 `b4c0be8^..0c6f437`，实际执行
  `cargo test -p xai-grok-shell agentmesh360 --lib`（原实现 83 项通过）和
  `cargo clippy -p xai-grok-shell --lib -- -D warnings`（通过）；它没有修改仓库；
- Kimi 判定原 H1 不能关闭：Previous 回滚只重读 Manifest 身份，没有可信的整树内容
  锚点；同时指出验签摘要与解包两次打开 Artifact 的 TOCTOU、目录 entry 不计数、
  未知 Agent 路由语义未锁定和 SemVer build metadata 边界；
- 修复后 Artifact 只打开一次，摘要并验签后 rewind 同一文件句柄解包；Archive
  所有 entry（包括目录）受 2048 上限约束；
- `state.db v8` 为 Active/Previous 保存已签名 `package-files.v1.json` 的 SHA-256。
  rollback 和幂等重装先比对该锚点，再复核整树路径、类型、数量、大小、文件 digest、
  Manifest 身份与引用文件；任何篡改均保持 Registry 指针不变；
- 空 v7 Registry 可无损升级；已有 v7 开发记录因从未保存可信锚点而保留原数据并
  失败关闭，不能从可能已篡改的目录反向补写“可信”摘要；
- 相同 SemVer precedence 不得通过 build metadata 更换 Artifact，未知产品
  `agentId` 的 Provider 路由明确失败关闭并由回归测试固定。

H1c 自主复测证据：

- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：90 项通过、0 失败；14 项
  本机 mock Core/Provider 测试在默认沙箱因 localhost bind 被拒，按原测试边界允许
  本机临时端口后同一完整命令全部通过；
- Artifact 专项 8 项、Installer 专项 6 项、state v8 专项 8 项和未知 Agent 路由
  契约 1 项全部通过；新增覆盖同文件句柄、目录 entry 炸弹、Active/Previous 文件及
  清单篡改、Registry 指针不变、SemVer build metadata 和 v7 锚点迁移；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 与
  `git diff --check` 通过；
- Kimi 恢复同一审查 Session，重新读取全部修复 diff，并独立执行完整 90 项测试和
  Clippy；原 H-1/M-1/M-2/L-1/L-2 均判定已修复，没有新增 blocker/high/medium 或
  需本轮处理的 low，最终结论为 `PASS —— 允许 H0/H1 本轮关闭`；
- Kimi 只保留两个非阻塞观察：rollback 整树复验会延长本地 SQLite 写锁持有时间，
  以及同 UID 可理论竞争文件清单的 metadata/open；在同 UID 已可直接改 DB、Package
  大小受限且本地低竞争的威胁模型下不扩大暴露面。orphan 只读诊断与安全清理仍按计划
  留给 H2a。

H1 完整复盘：

- H0 Manifest → H1a 信任验证 → H1b 原子提交的顺序与产品蓝图一致，没有先开放远端
  下载或 Renderer mutation；
- 权限批准、签名信任、订阅准入是三个独立门槛，任一成功都不会代替另外两个；
- H1 只建立“可信 Package 可成为本地 Active”的内部能力；Agent Registry 当前仍以
  三个内置 Package 为生产目录，不能宣称动态 Agent 已经上线；
- 生产发布公钥不能用测试 key 代替；在公钥轮换、权限 UI 和发布流程验收前，正式
  Trust Store 保持空；
- 下一轮必须先解决本地 Active Catalog 合并、启动时失败关闭和运行中刷新，再接远端
  Package Registry。

### 循环 24：动态 Agent Package H2a——本地 Active Catalog 与只读管理

状态：第一切片 H2a1 已完成自主测试与本机 Kimi 交叉测试；H2a2 紧接着开发

启动理由：H1 已能安全产生本地 Active 指针，但 Agent Registry 尚未消费它。直接接
远端目录只会得到“下载和安装成功、客户端仍看不见 Agent”的半集成。H2a 必须先让本地
Active Package 成为可恢复、可诊断的运行时目录。

本轮目标：

1. 启动时读取本地 Active Registry，重新校验相对路径、Manifest 身份和文件清单；
2. 把 Active Package 与内置 Catalog 确定性合并：同 `packageId/agentId` 只能有一个
   Active，已安装升级可覆盖同一内置身份，新 Agent 可追加；
3. Agent Registry、Profile、Session/Workspace 和 Model Policy 使用合并后的 Catalog；
4. 安装/回滚成功后通过显式 refresh 生效，不重置稳定 Main Session；
5. 提供订阅门禁后的只读 ACP 状态，区分 built-in、installed-active、Previous、
   orphan/invalid，不暴露绝对路径；
6. 模块完成后更新本文档与蓝图，再进入 H2b 生产信任根、远端 Registry 和权限 UI。

本轮非目标：不下载远端 Package、不开放安装/回滚 mutation ACP、不嵌入未经审计的
生产公钥、不自动清理 orphan、不执行迁移脚本、不自动安装宿主 Skill。

验收条件：重启后本地 Active Agent 可见且使用同一 `agentId`/Main Session；损坏或
身份冲突的 Active 失败关闭且不污染内置 Catalog；只读状态不含绝对路径/用户数据；
内置三个 Agent 在没有安装记录时行为不变。

H2a1 计划复核：

- 继续复用 H1 的锚定整树复验，不建立第二套“启动时简化校验”；
- 先完成 Host 启动加载，不把 refresh、状态 ACP、远端下载和权限 UI 混进同一切片；
- 内置身份只能被相同 `packageId + agentId` 且不低于内置 SemVer precedence 的
  已验证 Active 覆盖；不同 packageId 不能抢占内置 agentId；
- 新 Agent 可追加，但仍必须满足 Catalog 的唯一 packageId、agentId 和 sortOrder。

H2a1 已经实现：

- `PackageInstallService` 在一个一致性读取事务中按 packageId 排序读取 Active Registry，
  对每个目录复用 `verify_installed_package_tree`，并再次核对 Registry 身份和已批准
  权限；任一错误使整个运行时 Catalog 失败关闭；
- `AgentRegistry::in_home` 启动时加载上述已验证 Manifest，再与三个内置 Package
  确定性合并；无安装记录时仍返回原内置 revision 与顺序；
- 同 packageId 的合法升级可替换内置 Manifest；不同 packageId 抢占内置 agentId、
  低版本、相同 precedence 的 build metadata 替换、重复 sortOrder 均拒绝；
- 合并 Catalog 的 revision 由排序后 packageId、version、agentId 的 SHA-256 前缀
  确定性生成，不依赖进程随机 Hash；
- Registry 列表、AgentDefinition、Model Policy、激活、账户 Workspace 与稳定 Main
  Session 全部消费同一合并 Catalog；新 Agent 重启后可见，内置升级也不重置 agentId；
- Catalog 缓存保留完整 anyhow 错误链，损坏 Active 不仅失败关闭，还能在后续只读状态
  中显示具体 digest/身份冲突原因，而不是只剩“Catalog unavailable”。

H2a1 自主验证：

- 实现提交：`90a135b feat: load verified active package catalog`；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：94 项通过、0 失败；
- 新增 4 项回归覆盖内置升级、新 Agent 追加、AgentDefinition/Model Policy 投影、
  稳定 Main Session、篡改 Active、agentId 抢占、内置降级与确定性 revision；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过；
- 本机 Kimi 恢复既有审查 Session，独立读取 `219b951` 后的完整 diff，重新执行
  94 项完整测试与 Clippy，确认启动复验、合并、失败关闭和新 Agent 全链均符合目标，
  没有 blocker/high/medium，最终结论为 `PASS —— 允许 H2a1 关闭`；
- Kimi 将两条 low 明确归入 H2a2：动态安装开放前，不能让每个产品 Turn 重新哈希
  全部 Active 树，应使用共享 Catalog 快照和显式 refresh；只读状态不得直接透传可能
  含本机绝对路径的内部 anyhow 错误链，必须输出稳定错误码和脱敏摘要。

H2a2 下一切片：

1. 让 AgentMesh360 Runtime 持有可原子替换的共享 Catalog 快照，Model Routing 与
   Session Turn 复用它，不在每 Turn 重读 SQLite 或重哈希 Package；
2. 增加 Host 私有 refresh service；安装/回滚成功后可显式刷新，失败保留旧快照且不
   重置既有 Main Session；
3. 增加订阅门禁后的只读 Package 状态 ACP，区分 built-in、installed-active、
   Previous、invalid、orphan，只返回相对身份、稳定错误码和脱敏摘要；
4. 不开放安装/回滚 mutation ACP，不自动删除 orphan，不嵌入生产公钥。

验收条件：同一 Runtime 内普通 Turn 不触发 Package 整树复验；refresh 成功后新 Agent
可见且 Main Session 稳定，refresh 失败保留旧 Catalog；状态响应不含 HOME、绝对路径、
Token、Key、账户 ID、Session ID 或用户数据；自主测试与 Kimi 交叉测试均通过。

H2a2 计划复核：

- 共享的是 Host 的 Catalog 控制面，不为每个产品 Agent 或每个 Turn 新建一份 Harness；
- 普通 Registry、Model Routing、Session Turn 只读取不可变内存快照；只有 Host 启动、
  未来安装/回滚成功后的显式 refresh，以及用户主动读取状态时才访问 Package 文件；
- refresh 必须先在锁外完成 SQLite 一致性读取和 Active 整树复验，再一次替换共享快照；
  失败只能记录诊断，不能清空最后可信 Catalog、重建 Session 或修改 Package；
- 管理 ACP 只读且沿用客户端订阅硬门禁；内部完整错误链只用于本机诊断，对 Renderer
  仅返回稳定错误码与固定脱敏摘要。

H2a2 已经实现：

- `AgentRegistry` 现在持有 Runtime 共享的 `ArcSwapOption<AgentPackageCatalog>`；克隆
  Registry、Runtime 管理路由与产品 Turn 路由均复用同一快照，普通 Turn 不再调用
  `AgentRegistry::in_home`，因此不会逐 Turn 读取 SQLite 或重哈希 Active 树；
- refresh 使用独立串行门闩，复验成功后在状态写锁内原子替换 Catalog 并递增
  generation；失败保留相同的最后可信 `Arc`，只更新脱敏故障状态；
- Host 提供 crate-private 的显式 refresh service，为以后安装/回滚 mutation 成功后的
  唯一生效点；当前仍没有对 Renderer 暴露 refresh、安装或回滚方法；
- 新增订阅门禁后的只读
  `x.agentmesh360/agent-packages/status`：报告 `catalogGeneration`、revision、built-in、
  installed-active、installed-previous、invalid 与 orphan；
- 状态扫描重新验证 Active/Previous，但不改变 Registry 和文件；orphan 仅按已校验的
  packageId/SemVer 输出相对身份，设置 1,024 项安全上限，不返回路径、artifact digest、
  signature key、权限明细、账户或 Session 数据；
- 完整内部错误链仍保留给 Host；状态面使用
  `package_integrity_failed`、`package_identity_conflict`、
  `approved_permissions_mismatch` 等稳定错误码和固定英文摘要，不拼接本机路径。
- 即使状态目录本身无法打开，状态 ACP 也会成功降级成固定
  `status-inventory/package_validation_failed` 条目；Catalog ACP 失败只返回固定
  `Agent Package Catalog is unavailable`，两者都不会经通用扩展错误信封透传原始
  anyhow/OS 文本。

H2a2 自主验证：

- 实现提交：`32a662e feat: share refreshable agent package catalog`；
- 新增 3 项回归，分别覆盖共享快照/显式 refresh/失败保留最后可信 Catalog 与稳定
  Main Session、Previous/invalid/orphan 分类与脱敏、订阅门禁和 Host 私有 refresh；
- 针对性测试第一次发现新 Host E2E 缺少 Tokio `LocalSet`，修正测试 Harness 后，
  三项全部通过；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：97 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过；
- 本机 Kimi 第一次独立通读 8 个文件的完整 diff，并实跑 97 项测试、Clippy 和
  `git diff --check`，结论为 `PASS —— 允许 H2a2 关闭`；仅记录并发安装 rename 到
  Registry commit 之间可能瞬时误报 orphan、以及按需状态全量复验的非阻塞观察；
- 我随后按更严格口径补上状态目录打不开时的真实故障注入和 Catalog/Status 固定公开
  错误，重新自主执行 97 项测试与全部静态检查；Kimi 第二次复测同样实跑 97 项测试、
  Clippy、Rustfmt 与 diff check，确认没有 raw error/path 出口，最终维持 `PASS`；
- Kimi 第二轮唯一 low 是把上述固定失败文案和 `status-inventory` 降级补入本文档，
  本条已经关闭；H2a2 正式完成。

H2b 预备方向（须等 H2a2 Kimi 闭环后再启动）：

1. 定义生产 Publisher Trust Store 的密钥注入、轮换、吊销和审计流程，不把测试 key
   或私钥带入客户端；
2. 设计订阅门禁后的远端 Package Registry 元数据获取与本地缓存，下载、验签、权限
   确认、安装、refresh 各自保持独立失败边界；
3. 设计用户可理解的权限增量确认与只读状态 UI，mutation 仍由 Host 窄接口控制；
4. 保持同一 Manifest 同时投影持久客户端 Agent 与外部宿主 Agent Skill Adapter。
