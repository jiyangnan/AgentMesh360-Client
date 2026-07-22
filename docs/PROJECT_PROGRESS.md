# AgentMesh360 Client 项目进展

状态：持续开发中

最近更新：2026-07-23

本文档是当前仓库的实施进展账本。架构目标以
[`architecture/PRODUCT_BLUEPRINT.md`](architecture/PRODUCT_BLUEPRINT.md) 为准，
Provider 分阶段计划以
[`architecture/CC_SWITCH_PROVIDER_RESEARCH.md`](architecture/CC_SWITCH_PROVIDER_RESEARCH.md)
为准；本文只记录已经落地的事实、验证证据、计划复盘和紧接着要做的工作。

## 固定开发闭环

每完成一个可独立验收的模块或功能，都必须按以下顺序继续：

1. 更新本文档，记录实现边界、提交和验证证据；
2. 对照产品蓝图和专项计划，检查是否出现职责、顺序或安全边界漂移；
3. 明确下一轮目标、非目标和验收条件；
4. 把下一轮任务加入执行计划并开始开发；
5. 验证完成后再次进入本闭环。

“代码完成”不等于一轮工作结束；进展、计划复盘和下一轮启动都属于完成条件。

## 当前实施状态

| 领域 | 当前事实 | 下一验收点 |
| --- | --- | --- |
| 持久产品 Agent | Registry、Main Session、Workspace、历史可见性已按账户隔离；旧状态可认领 | 独立后台 Host、自启动与 UI 重连 |
| 订阅硬门禁 | Core、Host 与桌面身份外壳已经接通 | OAuth 不是当前 Provider 主线前置条件 |
| Provider Control Plane | 切片 A/B/C/D0/D1a/D1b/D1c0/D1c1 已完成；D1c2 成功链已覆盖 bootstrap、Provider、Assignment、Agent 激活、Prompt 与 Turn Route | 补齐 D1c2 失败门槛矩阵 |
| Provider Sampling | 无 Grok 登录的产品 Session 已通过 Binding/Lease 进入现有 Sampler actor，实际 endpoint、Bearer、模型和 Turn Route 一致；普通 Session 保持原认证路径 | 覆盖无效订阅、跨账户、缺失 Assignment/Vault，再审计辅助推理旁路 |
| Provider UI | 尚未向 Renderer 暴露 Provider 管理能力 | 切片 E：真实 Sampling 接通后实现最小设置 UI |
| 动态 Agent Package | 仍是目标架构，三个内置 Agent 是契约脚手架 | Provider M1 主线稳定后推进 Package Registry |

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

状态：开发中；测试依赖注入与 Host ACP 成功链已完成，失败门槛矩阵开发中

阶段提交：

- `5cfc926 test: share host vault across provider routing`
- `9fa7350 test: cover host product prompt routing`

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

阶段计划复盘：

- D1c2 成功路径已经达到原计划的真实 MvpAgent/ACP 边界，不再只是模块组合测试；
- E2E 揭示并修复了两个计划内但单元测试无法发现的偏差：Grok 登录前置条件与请求模型
  漂移，证明继续使用真实 Host 链而不是另建测试路由是正确方向；
- 原计划的失效订阅、跨账户和缺失配置失败门槛仍未在 Host 全链测试覆盖，保持为本循环
  验收项，因此 D1c2 仍不能标记完成；下一子模块先补失败矩阵，再进入辅助推理审计；
- Provider UI、真实计费请求和辅助推理改造仍不是当前子模块范围。

本轮目标：

1. ~~为测试建立只在 `cfg(test)` 可用的 Memory Vault/本机 mock Provider 注入缝，不在
   生产暴露 Vault 读取或绕过 Keychain；~~ 已完成
2. ~~通过真实 MvpAgent/ACP 路径覆盖 Core bootstrap、Provider 创建、Model Assignment、
   产品 Agent 激活/加载、Prompt、Sampler actor 和 Turn Route 查询；~~ 已完成成功路径
3. 断言订阅无效、跨账户、缺失 Assignment/Vault 都在 Prompt 提交前失败关闭且不产生
   Turn Route；
4. ~~断言成功路径只写一条实际路由，响应/管理 API/日志均不返回秘密；~~ 已完成
5. E2E 后审计所有辅助推理消费者，形成 D1d 的明确清单与接入顺序。

验收条件：无需真实账号、Keychain 或外部 Provider 即可重复验证完整 Host 链路；生产
代码没有测试后门；普通 Session 回归通过；格式、Clippy 和相关测试通过。

本轮非目标：不做真实计费请求、不实现 UI、不扩展协议或 Provider 预设。
