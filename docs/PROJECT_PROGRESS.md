# AgentMesh360 Client 项目进展

状态：持续开发中

最近更新：2026-07-30

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

临时例外：自 2026-07-28 起 Kimi 因账户周期额度不足不可用。用户明确要求在其恢复并
另行通知前停止调用 Kimi；期间第 2-4 步改为主 Agent 的加强自主复核，包括完整 diff
审计、定向与负向测试、计划边界复盘、秘密扫描和执行后证据对账，并在每轮记录中明确
标注“非 Kimi 独立审查”。用户通知恢复后，再恢复原 Kimi 交叉门禁。

## 当前实施状态

| 领域 | 当前事实 | 下一验收点 |
| --- | --- | --- |
| 持久产品 Agent | Registry、Main Session、Workspace、历史可见性已按账户隔离；G0/G1/G2 已覆盖 UI detach、Leader 崩溃恢复与隐藏登录启动源码；所有当前账号 Host Catalog Agent 已复用固定 Main Session 文本对话、恢复通路、标准 ACP 单次权限审批、安全只读工具活动、Workspace Artifact、Project State、Harness 后台活动与 Session Plan 安全投影 | 通用工作区、Gemini F0b 与 Package P0-P5 已按原顺序完成；P6 首份 clean pushed arm64 内部 DMG/ZIP、11/11 隔离安装/生命周期矩阵及其留存证据已通过；种子下载无授权预检固定为 blocked，真实 quarantine 单应用“仍要打开”、Apple 签名/公证、生产 Desktop Candidate 和 P7/P8 继续关闭 |
| 订阅硬门禁 | Core、Host 与桌面身份外壳已经接通；Google/GitHub 桌面 OAuth 已发布生产；owner Google 账号在隔离客户端完成 Core/Host 双 active，并在新进程从系统加密 Refresh Token 恢复 | 保持共享产品 20/20 live regression；后续 canary 复用已验收准入，不再回退邮箱密码假设 |
| Provider Control Plane | 切片 A/B/C/D0/D1/E1/E2/E3/F0a/F0b 已完成；P5 owner canary 又通过真实 Gemini Profile/Assignment、最小推理、Agent 主 Turn Route、失败关闭与重启恢复；P5 临时 Profile/Assignment/Binding/Keychain 已完整销毁 | 后续 Provider 必须逐个复用同一契约门，不批量虚报兼容 |
| Provider Sampling | 无 Grok 登录的产品主 Prompt、已审计 Session 辅助消费者、subagent 与显式 Probe 均复用实际 Provider 路由 | 保持真实链路回归，建立可复用的 Provider 兼容契约套件 |
| Provider UI | Profile、global/agent Assignment、三档显式 Probe、付费确认与非秘密历史已完成；Catalog 已加入通过真实契约的 Google Gemini 预设 | 保持保存零网络、真实 Probe 双重确认和无静默 fallback |
| 动态 Agent Package | H0/H1 至 H2d4、P0-P5 已完成；P5 v2 baseline、隔离客户端、Grok Host、owner OAuth/订阅、真实 Gemini BYOK、双代 Release Chain、61/61 Registry-last 发布、21/21 Package canary、Registry-first 清理以及云端/本机资源归零均已真实通过；场景还暴露并修复四项真实合同问题 | P5 已关闭且生产 Trust/Registry 常量为空；P6 unsigned internal 子阶段不得修改生产 Trust/Registry，也不得被误写成 Package 或 Desktop 生产发布 |

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

H2b 预备方向：

1. 定义生产 Publisher Trust Store 的密钥注入、轮换、吊销和审计流程，不把测试 key
   或私钥带入客户端；
2. 设计订阅门禁后的远端 Package Registry 元数据获取与本地缓存，下载、验签、权限
   确认、安装、refresh 各自保持独立失败边界；
3. 设计用户可理解的权限增量确认与只读状态 UI，mutation 仍由 Host 窄接口控制；
4. 保持同一 Manifest 同时投影持久客户端 Agent 与外部宿主 Agent Skill Adapter。

### 循环 25：动态 Agent Package H2b0——Publisher Trust Bundle

状态：实现、自主测试与两轮本机 Kimi 交叉测试已完成；生产信任根和安装入口保持关闭

启动理由：H1 的 Artifact 签名已经能绑定 publisher、Package 身份、版本和 digest，
但正式 Trust Store 仍是空集合。若直接把一个发布公钥硬编码进去，就没有可审计的轮换、
吊销、有效期和防回滚机制；若让服务器直接下发任意公钥，则 TLS/服务端本身会变成
可静默改写 Package 的唯一信任根。H2b0 先建立“客户端内置不可变 root → root 签名
Publisher Trust Bundle → Publisher key 验证 Package”的两级信任链。

本切片目标：

1. 定义严格 JSON Publisher Trust Bundle v1，包含 schema、单调 sequence、rootKeyId、
   bundle 有效期、按 keyId 唯一排序的 Publisher keys 和 root signature；
2. Publisher key 支持 `active`、`retired`、`revoked`，允许两个 active key 重叠完成
   无停机轮换；只有当前有效的 active key 进入 Artifact Trust Store；
3. root 和 Publisher signature 均使用 Ed25519 strict verification；公钥与签名要求
   canonical Base64，Publisher 公钥还必须能解析成有效 Ed25519 verifying key；
4. API 接收 `minimumSequence` 和显式可信时间，拒绝旧 sequence、未来/过期 bundle、
   过期 active key、未知 root、篡改、乱序/重复 key 与未知字段；
5. 保留 `trustSequence/rootKeyId/activeKeyCount` 审计投影，不记录私钥；
6. 正式 root 与 bundle 继续为空，绝不把测试 key 伪装为生产 key。

本切片非目标：不访问网络、不缓存远端 Registry、不持久化最高 sequence、不依赖本机
时间作为未来远端信任时间、不下载 Artifact、不开放权限/安装/回滚/refresh mutation
ACP、不启用任何真实 Publisher key。

计划复核：

- root 只能随经审计客户端版本进入，不允许远端 Registry 自己引入新 root；
- Publisher key 可通过 root-signed bundle 动态轮换和吊销；`retired/revoked` 一律不能
  验证新的安装，已安装内容继续依赖 H1 的文件清单锚点恢复；
- bundle 先做 Schema、边界、时间、排序和 key 解析，再做 root strict signature；
- 签名载荷使用固定 domain separator 和逐行字段，不依赖 JSON 对象顺序；
- `minimumSequence` 当前是验证 API 参数；H2b1 必须把最高接受 sequence 持久化后，
  才能宣称远端更新具备跨重启防回滚。

H2b0 已经实现：

- 新增 `package_trust.rs`，把 H1 原有 Publisher key/store 从 Artifact 模块分离，
  Artifact 验签逻辑继续只消费 `TrustedPublisherStore`，没有第二套验签器；
- Bundle 最大 64 KiB、最多 64 个 Publisher key，严格拒绝未知字段；keyId、publisher
  采用 128 字节 ASCII 安全标识限制；
- Bundle 与每个 key 都有 RFC3339 时间窗，active key 必须在显式 `now` 时刻有效；
- key 记录必须按 keyId 严格递增，既阻止重复，也让签名 payload 唯一；algorithm 目前
  只接受 `ed25519`；
- Trust Store 只载入 active key，支持双 key 重叠；retired/revoked key 被保留在签名
  Bundle 语义中但不进入可验证集合；
- 正式 `TrustedRootStore::embedded()` 与
  `EMBEDDED_PUBLISHER_TRUST_BUNDLE` 仍为空，Artifact 外部安装继续失败关闭。

H2b0 自主验证：

- 新增 3 项测试，覆盖双 active 轮换、retired/revoked 排除、审计投影、Bundle 篡改、
  未知 root、过期、sequence 回滚、乱序 key、非法 Ed25519 公钥，以及生产 root/store
  仍为空；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：100 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过；
- 本机 Kimi 第一轮独立执行完整测试，得到 98 项通过、2 项失败，阻止 H2b0 关闭：
  Bundle 正向夹具把任意 32 字节直接当成压缩 Edwards 公钥，严格公钥解析后无法通过；
- 已把夹具改为从确定性 `SigningKey` 派生真实 verifying key。随后自主复测又发现原负例
  `[0xff; 32]` 在当前库中可解析，已替换为经实际解析验证无法解压的 `[2; 32]`，没有
  为迁就测试削弱生产校验；
- 修复后自主重跑完整 100 项测试与全部静态检查均通过；等待 Kimi 第二轮独立复测，
  H2b0 在其明确 PASS 前不关闭；
- 本机 Kimi 第二轮重新读取全部代码和三份中文文档，独立实跑完整 100 项测试、
  Clippy、Rustfmt 与 `git diff --check`，全部通过；确认正向 Bundle 与 tamper 路径已抵达
  预期验证阶段，Blocker/High/Medium/Low 均为零并明确给出 PASS，H2b0 正式关闭。

H2b0 代码提交：`92d67cf`（`feat: verify publisher trust bundles`）。

H2b1 下一切片：

1. 定义 root-signed 远端 Registry Snapshot，将 packageId/agentId/version、Artifact
   URL、Envelope URL/digest 和 Publisher Trust Bundle sequence 绑定到同一 revision；
2. 使用 Core bootstrap 的可信 server time 验证有效期，不把可任意修改的本机时钟作为
   唯一可信时间；
3. 在本地持久化已接受的 trust/registry 最高 sequence、原始签名文档和校验状态，
   实现跨重启防回滚与过期失败关闭；
4. 只提供订阅门禁后的只读远端可用更新状态；仍不开放下载或安装 mutation。

### 循环 26：动态 Agent Package H2b1a——签名远端 Registry Snapshot

状态：实现、自主测试与本机 Kimi 交叉测试已完成；网络、缓存、下载和安装仍关闭

计划复核与切片理由：原 H2b1 同时包含远端目录契约、Core 可信时间、跨重启缓存和只读
更新状态，任一层出错都可能模糊信任边界。本轮先只建立一个纯验证器，把“服务器宣称
有哪些版本”和“客户端愿意下载什么”之间的签名契约固定下来；它只接收调用方已经拿到
的文档，不主动访问网络，也不写本地状态。

H2b1a 已经实现：

1. 新增严格 JSON `PackageRegistrySnapshot` v1：包含正整数 `revision`、`rootKeyId`、
   `trustBundleSequence`、Snapshot 有效期、按 `packageId` 唯一排序的 Package 记录和
   root signature；
2. 每条 Package 记录把 `packageId/agentId/version/publisher`、Artifact URL/SHA-256
   和 Envelope URL/SHA-256 绑定到同一个签名 revision；Package/Agent 标识约束与 v1
   Manifest 对齐，version 必须是 canonical SemVer；
3. Artifact/Envelope 地址只接受最大 4 KiB 的 canonical HTTPS URL，拒绝用户凭据和
   fragment；摘要只接受 64 字符小写 SHA-256；
4. 文档最大 1 MiB、最多 256 个 Package，严格拒绝未知字段、重复 packageId/agentId、
   非法顺序、过期/未来时间窗和旧 revision；
5. 签名载荷有独立 domain separator；所有自由文本字段先 canonical Base64，再进入
   确定性逐行 payload，避免 URL 或版本字符串造成分隔符歧义；root 继续使用 H2b0 的
   Ed25519 strict verifier；
6. 验证 API 不接受可伪造的裸 trust sequence，而是直接消费已验证的
   `TrustedPublisherStore`，要求 Snapshot 的 sequence 和 rootKeyId 与其完全一致；
7. Registry 中的每个 publisher 还必须至少拥有一个当前 active Publisher key，避免
   已全部 retired/revoked 的发布者仍显示成可用下载；
8. 返回的 Verified Snapshot 只含签名覆盖的数据和
   `revision/trustBundleSequence/rootKeyId/packageCount` 非秘密审计投影。

H2b1a 继续保持的关闭边界：

- `TrustedRootStore::embedded()` 与生产 Publisher Bundle 仍为空，所以生产环境无法
  接受任何远端 Snapshot；
- 不读取 Core bootstrap 时间，不访问 Registry URL，不缓存原始文档，不持久化最高
  revision/sequence，不下载 Artifact/Envelope，不开放 ACP/UI 或安装 mutation；
- URL 可能包含签名 query，未来只允许 Host 内部使用，不能进入公开状态响应或日志。

H2b1a 自主验证：

- 新增 4 项测试，覆盖双 Package 正向验证、Artifact URL 篡改、未知 root、过期、
  revision 回滚、Trust Bundle sequence/root 不匹配、乱序/重复身份、不可信 publisher、
  非 HTTPS URL、非法摘要、未知字段、非法签名和生产空 root 失败关闭；
- H2b0 Trust Bundle 与 H1 Artifact 专项回归继续通过；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：104 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 与
  `git diff --check` 通过；
- 本机 Kimi 通读全部代码和三份中文文档，独立实跑完整 104 项测试、Clippy、Rustfmt
  与 `git diff --check`，全部通过；逐项确认 payload 全字段覆盖且无分隔歧义、tamper
  实际抵达 root signature、Trust Store sequence/root/publisher 绑定不可绕过、H2b0
  验签重构无回归、无网络/写入/公开 URL 泄露，Blocker/High/Medium/Low 均为零并明确
  给出 PASS，H2b1a 正式关闭。

H2b1a 代码提交：`0cc5194`（`feat: verify remote package registry snapshots`）。

H2b1b 下一切片（须等 H2b1a 双方验证关闭后启动）：

1. 从 Core bootstrap 获取并解析可信 `server_time`，建立有界的新鲜度/单调时钟投影；
2. 在 `state.db` 增加原始签名 Trust Bundle/Registry Snapshot、最高 sequence/revision、
   验证时间与失败状态，事务化拒绝跨重启回滚；
3. 离线时只能在签名有效期和已验证缓存边界内展示 last-known-good，只读状态不得泄露
   URL/query、文件路径、账户标识或原始错误；
4. 本切片仍不下载或安装 Package；网络抓取和 mutation 在后续独立门禁中实现。

### 循环 27：动态 Agent Package H2b1b1——Core 可信时间门禁

状态：实现、自主测试与本机 Kimi 交叉测试已完成；数据库、远端抓取和安装仍关闭

计划复核：H2b1a 的验证函数原本接收任意 `DateTime<Utc>`。这适合纯契约测试，但如果
生产调用方直接传 `Utc::now()`，用户修改系统时间就可能让过期 Trust Bundle 或 Registry
Snapshot 继续通过。本切片把时间来源收口到已经通过订阅准入的 `ClientAccess`，持久
缓存和 Schema 升级仍留给 H2b1b2。

H2b1b1 已经实现：

1. 有效 Core bootstrap 同时解析 `server_time` 和订阅 `period_end`；两者任一格式错误、
   周期已结束、持续时间为零或 `Instant` 截止点溢出，整个 bootstrap 失败关闭；
2. `AccessState::Granted` 保存 `server_time`、接收时的单调 `Instant`、本机 `SystemTime`
   观察值和新鲜度截止点；可信当前时间只用 `server_time + Instant elapsed` 计算，
   本机墙钟永远不能把可信时间向前或向后推进；
3. 时间锚最多有效 10 分钟，并且不会超过订阅剩余时间；当前桌面身份控制器每 5 分钟
   重新 bootstrap，允许一次有限调度余量，但不能离线沿用整个会员周期；
4. 墙钟仅作失败关闭的休眠/改钟探针：它和单调时钟的 elapsed 相差超过 2 分钟，或墙钟
   回退到观察值之前，时间锚立即 stale，要求重新 bootstrap；它不会延长有效期；
5. 未验证、订阅拒绝、已过订阅截止、显式 `invalidate` 或 stale 锚都不提供可信时间；
6. Trust Bundle 与 Registry Snapshot 的生产验证 API 都不再接收裸时间或可长期持有的
   时间 token，而是直接接收当前 `ClientAccess`，在每次验签当下同时检查订阅与时间
   锚；任一失败都在 JSON/签名验证之前关闭；
7. 两个显式时间验证函数都降为各自模块私有，只供同模块边界测试；未来 embedded
   Bundle 即使被误填，也会失败关闭并要求先接入新鲜 Core 时间，不能回退到
   `Utc::now()`。

H2b1b1 继续保持的关闭边界：

- 不持久化 server time/Instant/SystemTime；进程重启必须重新 Core bootstrap；
- 不修改 `state.db` Schema，不缓存 Trust Bundle/Registry 文档，不读取网络 Registry，
  不下载 Artifact/Envelope，不开放 ACP/UI 或安装 mutation；
- 本机墙钟只会触发拒绝，绝不作为签名文档的可信时间源。

H2b1b1 自主验证：

- 新增 1 项时间锚专项测试，并扩展 Access/Registry 既有测试，覆盖单调推进、10 分钟
  半开截止、订阅剩余 30 秒提前截止、Instant 倒退、墙钟回退、墙钟/单调时钟漂移超过
  2 分钟、非法 `server_time`、Denied/Unverified/invalidate/stale 全部失败关闭；
- Trust Bundle 与 Registry 正向验证都使用当前 Granted `ClientAccess`；同一 Access
  被 invalidate 后，以及仍 Granted 但时间锚 stale 时，都在 JSON/验签前拒绝；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：105 项通过、0 失败；
- 首次静态检查发现手写 Duration 差值触发 `manual_abs_diff`，已改用标准
  `Duration::abs_diff` 后重跑完整 105 项测试；
- 最终 `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 与
  `git diff --check` 通过；
- 本机 Kimi 通读三个代码文件和四份中文文档，独立实跑完整 105 项测试、Clippy、
  Rustfmt 与 `git diff --check`，全部通过；grep 实证相关三个文件中 `Utc::now` 为零，
  并确认墙钟不能推进可信时间、10 分钟/订阅截止半开边界、invalidate/Denied/expired
  无 token 旁路、Trust Bundle/Registry 都受门禁、溢出/非法输入失败关闭且无网络/持久
  化/泄露。Blocker/High/Medium/Low 均为零并明确给出 PASS，H2b1b1 正式关闭。

H2b1b1 代码提交：`8e6cb31`（`feat: gate package trust on core time`）。

H2b1b2 下一切片：

1. 将 `state.db` 升级为 v9，新增单行 Package Trust Cache，原子保存 rootKeyId、最高
   Trust Bundle sequence、最高 Registry revision、原始签名文档摘要、有效期与验证时间；
2. 写入必须同时验证两个签名文档并在同一事务中比较旧最高值，拒绝 sequence/revision
   回滚和 root/trust 绑定拆分；
3. 启动读取缓存时必须用新 bootstrap 的可信时间重新验签；只能返回脱敏
   last-known-good 审计状态，不能返回 URL/query、原始文档、路径或底层错误；
4. 仍不下载或安装 Package；远端抓取和 mutation 继续作为独立切片。

### 循环 28：动态 Agent Package H2b1b2——持久反回滚缓存

状态：实现、自主测试与本机 Kimi 交叉测试已完成

计划复核：H2b1b1 已把签名有效期绑定到新鲜 Core 时间，但进程重启前后仍没有持久的
最高 sequence/revision，也没有可重新验签的 last-known-good。H2b1b2 只补这个本地
信任状态，不读取网络、不下载 Artifact/Envelope、不开放安装 mutation。签名 Registry
原始文档会写入 SQLite，因此本轮同时收紧 URL 契约：URL 不得带 credentials、query 或
fragment；未来下载授权必须走内存 Header/短期 lease，不能把 token 签进或写入目录。

H2b1b2 已经实现：

1. `state.db` 从 v8 加法升级到 v9，新增仅允许 `singleton_id = 1` 的
   `package_trust_cache`；保存 rootKeyId、Trust sequence、Registry revision、两份
   原始签名文档及 SHA-256、两个有效期和验证/更新时间；
2. v8→v9 迁移不改动既有 Product Agent、Provider、Session Binding 或本地 Active
   Package；专项测试证明旧 Main Session 保留且新缓存初始为空；
3. 接受新文档时先开启 SQLite `IMMEDIATE` 事务，在事务内读取旧最高值、使用当前
   Granted `ClientAccess` 同时验证 Trust Bundle 和 Registry，再比较并写入；
4. sequence/revision 低于已接受值会失败；相同 sequence/revision 却对应不同原始文档
   摘要会作为 equivocation 拒绝；Trust root/sequence 与 Registry 绑定必须完全一致；
5. 任一校验失败都不会替换 last-known-good。启动读取会重新计算两份文档摘要，以新
   bootstrap 的可信时间重新验签，并逐项核对持久元数据与签名内容；
6. 当前可返回对象只有脱敏审计：rootKeyId、sequence、revision、两个有效期、Package
   数量和验证时间；不含 URL、原始文档、路径、账户标识或底层存储内容；
7. 生产 `TrustedRootStore` 继续为空；空缓存只返回 `None`，不会制造信任或回退到本机
   时间。此处的反回滚保护针对“本地状态完整时的远端旧快照/等价冲突”，不把可由本机
   高权限攻击者整体回滚的 SQLite 冒充为硬件级防回滚存储。

H2b1b2 继续保持的关闭边界：

- 没有远端 HTTP 请求、ETag/Last-Modified、重试或离线刷新状态；
- 没有 Artifact/Envelope 下载、安装、权限确认、ACP/UI mutation；
- 不持久化 Core `server_time`、`Instant`、`SystemTime` 或订阅 token；
- 生产发布 root/bundle 仍为空，真实远端 Package 仍失败关闭。

H2b1b2 自主验证：

- 5 项缓存/迁移专项测试通过，覆盖 v8→v9 保留状态、接受/重启复验、脱敏审计、单行
  缓存、sequence/revision 回滚、同版本 equivocation、失败不替换 last-known-good、
  Access invalidate、DB 摘要篡改和空生产 root；
- Registry 既有不安全 URL 测试扩展 query/token 拒绝；Trust audit 增加签名有效期；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib` 在允许 loopback mock 的环境
  110 项通过、0 失败；受限沙箱首跑的 15 项失败全部是既有 mock server `bind`
  `PermissionDenied`，放开本机 loopback 后通过；
- 首次 Clippy 发现一个冗余 `Ok(...?)`，修复后完整 110 项回归再次通过；
- 最终 `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 与
  `git diff --check` 通过。
- 本机 Kimi 逐行通读 7 个修改文件、新增的 548 行 Trust Cache 模块和三份中文文档，
  独立记录完整 110 项测试、Clippy、Rustfmt 与 `git diff --check` 全部通过；确认
  `IMMEDIATE` 事务无读写并发窗口、失败保留 last-known-good、重启重新验签、绑定/整数/
  篡改/URL/脱敏边界均失败关闭，并认可 SQLite 只能防本地状态完整时远端回滚的诚实
  边界。Blocker/High/Medium/Low 均为零并明确给出 PASS，H2b1b2 正式关闭。

H2b1b2 代码提交：`1f398f2`（`feat: persist package trust cache`）。

H2b1c 下一切片（须等 H2b1b2 Kimi 交叉测试关闭后启动）：

1. 增加 Host-owned 只读 Registry Fetcher，只允许固定 HTTPS origin、有限响应体、超时
   和重定向策略；网络层只取得文档，信任缓存继续负责验证与原子接受；
2. 保存非秘密 ETag/Last-Modified，支持条件请求；304 只能触发已有缓存重新验签，不能
   延长签名有效期或 Core 时间锚；
3. 定义脱敏 fetch/cache 状态和 last-known-good 退化原因，不暴露 URL、query、路径、
   账户、token 或原始响应；
4. H2b1c 仍不下载 Artifact/Envelope，不开放安装 mutation。

### 循环 29：动态 Agent Package H2b1c——只读远端获取与条件缓存

状态：实现、自主测试与本机 Kimi 交叉测试已完成

计划复核：H2b1a/b 已经完成签名目录契约、Core 可信时间和跨重启 last-known-good，
但尚无 Host 网络入口。H2b1c 只让 Host 获取 Trust Bundle/Registry 两份元数据并调用
既有信任缓存；它不解释签名、不自行修改 maxima、不下载 Artifact/Envelope，也不触发
安装。生产 endpoint 与 root/bundle 同时保持空值，避免把测试域名或未经审计的密钥
误写成发布配置。

H2b1c 已经实现：

1. 新增 Host-owned `PackageRegistryFetcher`，客户端总超时 15 秒、连接超时 5 秒、
   禁止重定向；生产配置只接受固定 `https://packages.agentmesh360.com` origin，URL
   禁止 credentials/query/fragment，测试构造器只放行同 origin 的 loopback HTTP；
2. Trust Bundle 响应上限 64 KiB、Registry 响应上限 1 MiB；同时检查 Content-Length
   和实际解码后 stream 累计字节，只接受 200 `application/json` 或 304；
3. 两份文档都取得后，Fetcher 只调用 Trust Cache 的条件接受入口；200 提供新文档，
   304 使用缓存原文，但两者都必须在同一 `IMMEDIATE` 事务中按当前 Access 重新验签。
   新旧 Trust/Registry 发生发布竞态时会由 root/sequence/revision 绑定失败关闭；
4. `state.db` 从 v9 加法升级到 v10，新增单行 `package_registry_fetch_state`，只保存
   经过长度/格式约束的非秘密 ETag/Last-Modified 和检查时间，不保存 URL、响应或错误；
5. 只有签名缓存接受成功后才更新条件 validator。304 不延长文档有效期或 Core 时间锚；
   validator 落盘失败时签名缓存仍保持可信，但状态明确退化为 last-known-good；
6. Transport、HTTP status、响应过大/非法、验签拒绝、缓存损坏和 validator 写入失败
   都映射为固定枚举；状态只暴露 outcome/reason、是否发出条件请求和脱敏信任审计；
7. 有新鲜缓存时远端失败返回 `last_known_good`，没有可重新验签缓存则
   `unavailable`。无有效订阅/时间锚在发起网络前阻断；
8. Host 在准入成功后拥有自动刷新入口；当前生产 endpoint 未配置，因此不会发起真实
   网络请求。既有订阅门禁的 Package Status 增加 `remoteRegistry` 脱敏状态。

H2b1c 继续保持的关闭边界：

- 生产 Trust Bundle、root 和两个远端 endpoint 均为空；真实用户仍只看到内置/本地
  已安装 Package；
- 不下载 Artifact/Envelope，不创建下载 staging，不执行 Archive 验签或解压；
- 不开放安装/更新/回滚 ACP mutation，不改变权限批准，不刷新 Active Catalog；
- ETag/Last-Modified 只优化请求，不参与真实性、版本或有效期判断。

H2b1c 自主验证：

- 新增 4 项 Fetcher 专项测试，覆盖首次双 200 接受、持久 ETag 后双 304、条件 Header、
  304 重新验签、无效更新退回且不替换 last-known-good、响应体上限、Access invalidate
  前置阻断与生产禁用；
- 新增 v9→v10 迁移测试，证明现有 Trust sequence/revision 不丢失且 fetch state 初始
  为空；Package Status 回归确认生产 `remoteRegistry = disabled/not_configured`；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：115 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过。
- 本机 Kimi 全文逐行通读新增的 844 行 Fetcher、三处接线/缓存/Schema diff 和三份中文
  文档，独立实跑 115 项测试、Clippy、Rustfmt 与 `git diff --check` 全部通过；确认固定
  endpoint/禁重定向、双层响应上限、双文档发布竞态失败关闭、validator 防 Header 注入、
  304 重新验签、Access 零网络、两事务崩溃边界、v9→v10 迁移、状态脱敏和无下载/
  mutation。Blocker/High/Medium/Low 均为零并明确给出 PASS，H2b1c 正式关闭。

H2b1c 代码提交：`c7306aa`（`feat: fetch remote package metadata`）。

H2b2a 下一切片（须等 H2b1c Kimi 交叉测试关闭后启动）：

1. 只从已重新验证的 Registry Record 选择 Artifact/Envelope URL 和 digest，固定 HTTPS
   origin、禁止重定向/凭据/query，并执行响应/磁盘配额；
2. 下载到每次操作独立的临时 staging，流式计算 SHA-256；任一失败清理本次临时文件，
   不接触 Active/Previous 或 Package Registry；
3. 将已下载的 Envelope/Artifact 交给既有 `package_artifact` 验签与库存验证，但仍不
   解包到正式 versions、不请求权限、不开放安装 mutation；
4. 定义脱敏下载状态和取消/超时边界，不记录 URL、路径、账户、token 或响应正文。

### 循环 30：动态 Agent Package H2b2a——受限下载与验证暂存

状态：实现、自主测试与本机 Kimi 独立交叉测试已完成

计划复核：H2b1c 已经能获得并重新验证 Trust Bundle/Registry，但把任意 URL、digest
或本机目标路径交给调用方仍会破坏 Host-owned 信任边界。H2b2a 因此只接受
`package_id + ClientAccess`，由 Host 从当前重新验签的 Registry Record 选择
Artifact/Envelope；输出仍是会自动清理的已验证暂存对象，不接触正式版本目录、权限
批准、Active/Previous、运行时 Catalog 或 ACP。

H2b2a 已经实现：

1. 新增 Host-owned `PackageArtifactDownloader`。调用方不能注入 URL、digest、publisher
   或路径；下载前必须以当前 Core 可信时间重新验证持久 Registry/Trust Cache；
2. Registry 中的 Artifact/Envelope URL 只接受固定
   `https://packages.agentmesh360.com` origin，禁止 credentials/query/fragment，
   HTTP Client 禁止重定向；loopback transport override 只在 `cfg(test)` 存在；
3. 每次操作使用独立 `packages/.downloads/download-<uuid>`，Unix 目录/文件分别以
   `0700`/`0600` 创建；已存在的 `.downloads` 必须是真实目录，符号链接在发起网络前
   拒绝；
4. Envelope 上限 64 KiB、Artifact 上限 32 MiB；同时检查 Content-Length 与实际
   stream 累计字节，按类型限制 MIME，流式写盘并计算 SHA-256；
5. 先比对 Registry 绑定的 Envelope/Artifact digest，再调用既有
   `PackageArtifactVerifier` 验证 Publisher 签名、Archive 安全、Manifest、文件库存
   和内容 digest；最后再次比对 package/agent/version/publisher 身份；
6. 下载操作的 Drop Guard 在成功、错误和异步取消时清理下载目录；返回的
   `VerifiedPackageDownload` 继续拥有提取 staging 的清理责任。审计对象只包含
   package/agent/version 和两个字节数，不含 URL、路径、digest、账户或响应正文；
7. 生产 root、Trust Bundle 和 metadata endpoint 仍为空，因此生产路径继续
   fail-closed；本切片没有新增真实网络、安装或权限批准入口。

H2b2a 继续保持的关闭边界：

- 不移动到 `packages/versions`，不修改 `agent_package_registry`、Active/Previous 或
  Shared Runtime Catalog；
- 不开放下载/安装/更新/回滚 ACP，不把测试 loopback override 带入生产；
- 不把订阅准入、Publisher 签名和权限批准合并为一个门槛；
- 本切片只保证一次下载操作的临时目录清理；正式安装后的 orphan 回收仍未开放。

H2b2a 自主验证：

- 下载器专项 6 项通过，覆盖成功验签暂存、Artifact digest 篡改、Registry/Manifest
  身份不一致、无效 Access 零网络、声明超大 Envelope 在 Artifact 请求前拒绝，以及
  `.downloads` 符号链接逃逸零网络拒绝；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：121 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过。
- 本机 Kimi 全文逐行通读 711 行下载器、五处信任链/测试接线 diff 与三份中文文档，
  独立实跑下载器 6 项、AgentMesh360 121 项、Clippy、Rustfmt 和 `git diff --check`
  全部通过；确认调用面收口、生产/test 传输隔离、双层上限、完整 digest/签名/身份链、
  私有权限、符号链接拒绝、错误/取消清理、零 mutation 与审计脱敏。Blocker/High/
  Medium/Low 均为零并明确给出 PASS，H2b2a 正式关闭。

H2b2a 代码提交：`358a428`（`feat: download verified agent packages`）。

H2b2b 下一切片（须等 H2b2a Kimi 交叉测试关闭后启动）：

1. 以所有权方式把 `VerifiedPackageDownload` 交给既有 `PackageInstallService`，不得
   根据 URL/路径重新读取或重新下载，也不得绕过 Registry 身份绑定；
2. 下载完成后先返回新增权限的脱敏审批请求；只有匹配当前
   package/version/digest/权限集合的一次性批准才能进入本地安装事务；
3. 安装仍复用既有不可变 versions、Active/Previous 和 Catalog 刷新原子性，不在
   H2b2b 暴露桌面 ACP/UI 或启用生产 root/endpoints；
4. 验收覆盖下载后篡改/替换、过期 Access、批准重放/错包、事务失败和双方 staging
   清理，继续执行自主测试与本机 Kimi 交叉测试硬门槛。

### 循环 31：动态 Agent Package H2b2b——一次性权限批准与安装窄交接

状态：实现、自主测试与本机 Kimi 独立交叉测试已完成

计划复核：H2b2a 返回的 `VerifiedPackageDownload` 已经同时绑定签名 Registry、
Publisher Envelope 和提取库存，但原 `PackageInstallService::install(path, envelope,
bool)` 仍允许内部调用方重新传路径和一个裸批准布尔值。H2b2b 删除该入口，只允许新的
Delivery Service 消费验证对象所有权；批准是 Host 内存中的短期能力，不落盘、不由
Renderer 构造。

H2b2b 已经实现：

1. 新增 Host-owned `PackageDeliveryService`。生产入口只接收
   `package_id + ClientAccess`，先执行既有受限下载，再生成审批或直接安装；当前只
   注册内部模块，尚未接 ACP/UI；
2. `VerifiedPackageInstallPlan` 绑定 package/agent/version、Artifact digest、完整
   requested permissions、相对当前 Active 的 added permissions、当时的 Active
   digest 和幂等状态；该计划不实现 Serialize，不进入公开响应或日志；
3. 对存在新增权限的安装返回随机 UUID v7 审批 ID、package/version、added
   permissions 和 TTL 秒数。审批内部绑定当前账户，最多同时保留 32 项，默认 10
   分钟；无效订阅、错误 ID 或其他账户不能消费合法审批；
4. 审批从 Map 中先移除再安装，因此只能使用一次；TTL 由运行时任务主动回收，同时
   每次请求也同步清理过期项。过期、Host 退出或拒绝都会 Drop
   `VerifiedPackageDownload` 并删除 staging；
5. 批准时再次验证 staging 文件库存和 Manifest，重新计算当前安装计划并与原计划完整
   比较；任何文件篡改、Active digest/权限/身份变化都会使批准失效；
6. 匹配后把 `VerifiedStagedPackage` 所有权交给既有不可变 versions + SQLite CAS
   安装事务。CAS 继续防止计划复核后发生的并发 Active 变化；失败不会切换 Active；
7. 删除 `PackageInstallService` 原来的任意 artifact path/envelope/裸布尔入口，避免
   未来生产 Trust Store 启用后绕过 Delivery 审批链。

H2b2b 继续保持的关闭边界：

- 安装成功会更新本地 Package Registry/Active/Previous，但本切片不刷新 Host 的
  Shared Runtime Catalog，也不自动投影已有账户的 Product Agent 行；
- 不开放下载/批准/安装/更新/回滚 ACP 或桌面 UI，不启用生产 endpoint/root/bundle；
- 审批不跨 Host 重启恢复；重启后必须重新下载、重新验证和重新批准；
- 安装事务失败产生的不可见 immutable version orphan 仍由既有只读状态识别，自动
  orphan 回收尚未开放。

H2b2b 自主验证：

- Delivery 专项 7 项通过：签名 Registry→下载→审批→安装端到端、审批前零 mutation、
  序列化脱敏、一次性重放拒绝、无效 Access/错误 ID 不消耗合法审批、staging 篡改
  拒绝并清理、安装状态变化使绑定计划失效、TTL 同步/异步回收；
- Installer 10 项回归通过，覆盖权限增量、升级/幂等/回滚、事务中断、Catalog 和
  状态完整性；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：128 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过。
- 本机 Kimi 全文逐行通读 595 行 Delivery Service、Installer/Downloader/接线 diff
  与三份中文文档，独立实跑 Delivery 7 项、Installer 10 项、AgentMesh360 128 项、
  Clippy、Rustfmt 和 `git diff --check` 全部通过；确认调用面收口、完整不可序列化
  plan、challenge 脱敏、账户/一次性/TTL/容量边界、批准前零 mutation、批准时重验、
  CAS 防竞态和未刷新 Runtime Catalog 的诚实边界。Blocker/High/Medium/Low 均为零
  并明确给出 PASS，H2b2b 正式关闭。

H2b2b 代码提交：`05b6435`（`feat: gate package installs on approval`）。

H2b2c 下一切片（须等 H2b2b Kimi 交叉测试关闭后启动）：

1. 让安装成功结果触发同一 Host 的 Shared Runtime Catalog 原子刷新，并使新/升级
   Agent 在后续账户列表/激活时按 Manifest 投影；
2. 安装已提交但 Catalog 刷新失败时，保留 last-known-good Catalog、记录脱敏健康
   状态并返回“已安装、尚未运行时可见”的明确结果，禁止谎报回滚成功；
3. 并发安装/刷新必须串行化或按 generation 验证，不能让旧刷新覆盖新 Active；
4. 仍不开放 ACP/UI/生产 Trust 配置；验收覆盖新 Agent、内置升级、刷新失败恢复、
   跨账户投影与双方测试门槛。

### 循环 32：动态 Agent Package H2b2c——安装后的运行时原子可见性

状态：实现、自主测试与本机 Kimi 独立交叉测试已完成

计划复核：H2b2b 已能安全提交本地 Active/Previous，但同一 Host 的
`SharedPackageCatalog` 仍保持安装前快照。若安装 API 直接返回普通成功，用户会看到
“磁盘上已安装、当前对话运行时却找不到”的假成功；若刷新失败时把安装说成已回滚，
又会掩盖真实 Active 状态。H2b2c 因此把安装 mutation 和紧随其后的 Catalog refresh
放进同一顺序门，明确区分磁盘提交与运行时可见性。

H2b2c 已经实现：

1. `AgentMesh360Runtime` 现在让 `PackageDeliveryService` 与产品列表、激活和模型路由
   共享同一个 `AgentRegistry`/`SharedPackageCatalog`，不再让安装器拥有与 Host
   运行时分离的目录副本；
2. `AgentRegistry::mutate_and_refresh_package_catalog` 在共享 `refresh_gate` 内依次
   执行当前计划复核、Installer CAS 提交和立即 refresh；所有 Registry clone 的显式
   refresh 也使用同一把门，旧操作不能在新 Active 提交后反向覆盖运行时快照；
3. 安装返回脱敏 `PackageInstallReceipt`，只包含 package/agent/version 与运行时状态。
   状态明确区分 `visible`、已被更新版本取代的 `superseded`，以及磁盘提交成功但
   Catalog 尚未接受的 `refresh_pending`；不返回 digest、安装路径、staging 路径或
   文件库存；
4. refresh 成功后，新 Agent 会在现有账户下一次 list/activation 时按 Manifest
   确定性投影，并获得账户级稳定 Main Session；内置 Agent 升级也从同一共享快照读取；
5. refresh 失败不会清空最后良好 Catalog，也不会伪造安装回滚。健康状态保留原
   generation/revision 并记录固定脱敏问题，Receipt 返回
   `refresh_pending`；修复本地内容后可用既有显式 refresh 恢复可见性；
6. `PackageDeliveryService` 仍是 Host 私有能力，未接 ACP/Renderer/UI；生产
   endpoint、root 和 Trust Bundle 继续为空。

H2b2c 自主验证：

- Delivery 专项 10 项通过，新增覆盖安装新 Agent 后两个既有账户的列表/激活投影、
  Receipt 序列化脱敏、安装已提交但 refresh 失败时保留 last-known-good、修复后恢复，
  以及旧安装结果不能把新版 Active 报告成当前可见；
- Registry 专项 6 项通过，新增跨 Registry clone 的顺序门并发测试，证明第二个
  mutation/refresh 必须等待第一个完整退出；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：132 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过；
- 首次在受限沙箱运行 Delivery 时，唯一失败是测试服务器无法绑定本机回环端口；
  使用允许回环绑定的相同命令重跑后 10/10 通过，不属于产品逻辑失败。

计划复盘：

- 没有把“安装提交成功”和“当前 Runtime 已可见”合并成一个含糊布尔值；
- last-known-good 与 generation 语义保持 H2a2 约束，失败不会重建 Session、删除
  Active 或清空运行时 Catalog；
- 顺序门只包围短生命周期本地验证、CAS 和 refresh，不跨越远端下载或用户审批等待；
- 没有开放 ACP/UI，也没有用测试 root/endpoints 冒充生产发布配置；
- 本机 Kimi 已逐行通读全部代码 diff、`SharedPackageCatalog`、Installer/Catalog
  依赖与三份中文文档，并独立实跑 Delivery 10 项、Registry 6 项、Installer 10 项、
  AgentMesh360 全量 132 项、Clippy、Rustfmt 和 `git diff --check`，全部通过；
  它确认 Runtime 共享同一 Registry、顺序门无重入死锁或旧快照覆盖路径、Receipt
  脱敏和失败保真、跨账户投影与 H2b2d 计划边界。Blocker/High/Medium/Low 均为零，
  明确给出 PASS，H2b2c 正式关闭。

H2b2c 代码提交：`cb84ee1`（`feat: refresh runtime catalog after install`）。

H2b2d 下一切片（须等 H2b2c Kimi 交叉测试关闭后启动）：

1. 把本地 rollback 和显式恢复也纳入同一 mutation/refresh 顺序门，保证所有改变
   Active 的 Host 私有路径都遵守与安装相同的 last-known-good 与 Receipt 语义；
2. rollback 已提交但 refresh 失败时，必须明确报告“磁盘已回滚、运行时仍使用最后
   良好快照”，不得伪造事务失败或再次切换 Active；
3. 验收覆盖回滚成功、回滚内容损坏、refresh 失败后恢复，以及 install/rollback/
   explicit refresh 并发顺序；
4. 仍不开放 ACP/UI、不自动回滚、不清理 orphan、不启用生产 Trust 配置。完成全部
   本地 mutation 一致性后，再进入订阅门禁的管理 ACP 与桌面权限 UI。

### 循环 33：动态 Agent Package H2b2d——回滚与恢复的运行时一致性

状态：实现、自主测试与本机 Kimi 独立交叉测试已完成

计划复核：Installer 既有 rollback 已经在 Previous 整树完整性和身份复验后，用
SQLite Immediate 事务交换 Active/Previous；但它没有进入 H2b2c 的共享 refresh
顺序门。这样磁盘回滚后 Runtime 仍可能长期使用旧版本，而且调用者无法区分“rollback
事务失败”和“磁盘已回滚、Catalog refresh 失败”。H2b2d 只补齐本地 mutation
一致性，不提前开放管理协议或 UI。

H2b2d 已经实现：

1. `PackageDeliveryService::rollback` 先后两次验证当前 `ClientAccess`，然后在共享
   `refresh_gate` 内执行 Installer rollback 和立即 Catalog refresh；损坏 Previous
   在 SQLite mutation 前失败关闭，成功回滚复用 H2b2c 的脱敏 Receipt；
2. 新增 Host 私有 `reconcile_runtime_catalog`。它不再次改变 Active，只在订阅有效且
   package 已安装时，将当前 Registry 记录与全量 Catalog refresh 放入同一顺序门，
   用于修复内容后的显式恢复；
3. Receipt 类型泛化为 `PackageMutationReceipt`，安装、回滚和 reconcile 共用
   `visible/superseded/refresh_pending`。回滚已经提交但其他 Active Package 令
   refresh 失败时，Receipt 明确返回目标回滚版本 + `refresh_pending`；磁盘保持回滚
   后版本，Runtime 保持 last-known-good；
4. `PackageCatalogRefreshOutcome` 在释放顺序门之前同时捕获本次 Catalog 结果与对应
   health/generation，避免另一个并发 mutation 在 Receipt 生成前造成“旧 Catalog +
   新 generation”的混合快照；
5. Delivery 的共享构造器不再同时接受可错配的 `state_home` 和 Registry，而是只从
   Registry 推导唯一状态根；Runtime、Delivery、Installer、Downloader 因此不能被
   接到不同的本地 Package 目录；
6. Installer 原始 rollback 从 crate 可见性收窄到 AgentMesh360 父模块范围，生产
   mutation 继续由 Delivery 编排；本切片仍未增加 ACP/Renderer/UI。

H2b2d 自主验证：

- Delivery 专项 14 项通过；新增覆盖 rollback 后 Catalog 和稳定 Main Session、
  无效订阅零 mutation、损坏 Previous 失败关闭、磁盘回滚已提交但全量 refresh 失败、
  修复后 reconcile 恢复，以及 rollback 等待共享 mutation gate；
- Registry 专项 7 项通过；跨 clone 测试同时证明 mutation 与显式 refresh 串行，
  另有测试证明 Outcome 保留同一顺序门时刻的 Catalog/revision/generation；
- Installer 既有 10 项全部通过，包括回滚完整性、CAS、Previous、orphan 与
  last-known-good 回归；
- 完整 `cargo test -p xai-grok-shell agentmesh360 --lib`：137 项通过、0 失败；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 和
  `git diff --check` 通过；
- 首轮 Delivery 13/14 时，唯一失败来自测试错误地要求诊断字符串必须包含
  `digest`；实际稳定分类为 `package_integrity_failed`。改为断言脱敏错误分类后，
  聚焦与全量测试全部通过，产品 mutation 在失败前后保持不变。
- Kimi 第一轮交叉测试的首次全量运行曾出现一次未捕获用例名的 136/137，随后连续
  4 次全量和 10 次 Delivery/Registry 定向运行均通过；Kimi 将其列为 1 项测试健壮性
  Low。为彻底关闭该项，TTL 清理测试已改为最多 5 秒的条件等待，不再在两个同时唤醒
  的 task 间用固定 30 ms 抢锁；顺序门测试已加入“线程开始尝试”握手，并把释放后的
  完成余量从 1 秒提高到 5 秒。加固后自主重跑 Delivery 14 项、Registry 7 项与全量
  137 项均通过；Kimi 第二轮复测确认 Low 清零。

计划复盘：

- rollback、reconcile 与 install 共用同一 Registry、状态根、顺序门和 Receipt，
  不再存在已知的 Host 私有 Active mutation 绕过路径；
- 显式恢复不会自动修文件、自动回滚、删除 orphan 或二次切换 Active；
- 订阅门禁在等待顺序门之前和进入 mutation 闭包后都检查，过期访问不能排队后提交；
- Receipt 仍不含账户、digest、路径、文件库存或凭据，失败问题继续使用固定脱敏分类；
- 生产 endpoint/root/bundle、ACP 和 UI 均保持关闭；
- Kimi 第二轮逐行复核三处测试加固，确认条件等待有明确成功判据和 5 秒上限，
  started 握手让负向窗口具备真实含义，且生产代码未被测试修复改变。它独立实跑
  Delivery 14 项 × 5、Registry 7 项 × 5、AgentMesh360 全量 137 项 × 3、Installer
  10 项、Clippy、Rustfmt 和 `git diff --check`，13 次套件级运行全部通过；
  Blocker/High/Medium/Low 均为零并给出无条件 PASS，H2b2d 正式关闭。

H2b2d 代码提交：`9371eeb`（`feat: reconcile package rollbacks with runtime`）。

H2c1 下一切片（须等 H2b2d Kimi 交叉测试关闭后启动）：

1. 定义订阅门禁的 Host Package 管理 ACP 契约，先接只读远端 refresh、按
   `package_id` 下载/请求批准、按随机 `approval_id` 批准安装，以及显式 rollback/
   reconcile；调用方不得提交 URL、路径、digest、publisher、权限布尔值或本地
   Registry 内容；
2. ACP 只返回现有脱敏 Registry Audit、审批 Challenge 和
   `PackageMutationReceipt`，统一沿用无效订阅、跨账户、重放、过期与
   `refresh_pending` 失败关闭语义；
3. 生产 root/endpoints/bundle 继续为空，因此正式构建中的远端 mutation 仍不可用；
   测试只用临时目录、固定测试密钥和 loopback transport；
4. H2c1 只建立 Host 协议和桌面主进程窄调用面，不做 Renderer 权限 UI、不启用自动
   更新或自动 rollback。协议通过双方测试后，再单独进入 H2c2 桌面交互。

### 循环 34：动态 Agent Package H2c1——订阅门禁的 Host 管理 ACP

状态：实现、自主测试与本机 Kimi 独立交叉测试已完成

计划复核：H2b2d 已经关闭本地 install/rollback/reconcile 的运行时一致性，但桌面
主进程还不能通过受控协议调用这些能力。H2c1 只建立 Host ACP 和桌面主进程窄
Client，不做 Renderer 页面，不启用自动更新、自动批准或自动回滚，也不填充生产
endpoint、root 或 publisher bundle。

H2c1 已经实现：

1. 新增五个订阅门禁的 Host 扩展：
   `agent-packages/remote-refresh`、`download`、`approve`、`rollback` 和
   `reconcile`；它们复用现有只读 `catalog`/`status`，形成完整但仍由 Host 持有
   authority 的管理面；
2. 请求 Schema 使用 `deny_unknown_fields`。refresh 只接受空对象，download、
   rollback、reconcile 只接受最长 128 字节的合法 `packageId`，approve 只接受
   Host 生成的随机 `approvalId`；URL、路径、digest、publisher、权限布尔值和
   Registry 内容都不能由调用方注入；
3. 统一 Host 分发层在解析或执行管理请求前先检查订阅，管理模块再次防御性调用
   `ClientAccess::require`。跨账户批准不能消费另一个账户的 Challenge，切回原账户
   后仍可继续；成功批准只能使用一次，重放返回固定脱敏错误；
4. 操作失败通过结构化 `{code, message}` 返回。下载统一为
   `package_delivery_failed`，批准、回滚和恢复使用稳定 fallback；已知的完整性、
   身份和 Registry 问题只复用既有安全分类。响应和日志均不透传原始错误、路径、
   digest、账户或 Token；
5. 桌面 `AcpHostClient` 新增 catalog/status/refresh/download/approve/rollback/
   reconcile 七个窄方法，参数只含 `packageId` 或 `approvalId`，并保留 Host 的
   结构化安全错误码；本切片没有把任何方法暴露给 preload/Renderer；
6. Host 集成测试让 ACP、Delivery 与 Runtime Registry 共享同一实例和状态根，并用
   临时目录、固定测试签名密钥和 loopback transport 完成真实 envelope/artifact
   下载、跨账户批准、一次性安装、运行时 generation 刷新、reconcile 和状态查询；
7. 所有 Package、publisher 和 agent 标识统一增加 128 字节上限，避免管理输入和
   Manifest 校验形成长度边界差异。

H2c1 自主验证：

- Host ACP 专项 2 项通过：覆盖五个方法均先订阅门禁、严格拒绝额外 authority 字段、
  非法/超长 Package ID、正式配置关闭、固定脱敏失败码、跨账户 Challenge、账户恢复、
  一次性批准、防重放、Runtime generation 和响应脱敏；
- Delivery 专项 14 项通过；AgentMesh360 全量 140 项通过、0 失败；
- 桌面端 45 项通过、0 失败，另有 2 个真实 Host 可选测试按环境约束跳过；
  `npm run check` 通过；
- `cargo clippy -p xai-grok-shell --lib -- -D warnings`、Rustfmt 与
  `git diff --check` 通过。

计划复盘：

- Host 仍是 Registry、远端地址、签名、路径、digest、批准绑定和磁盘 mutation 的
  唯一 authority；桌面主进程只是按 ID 调用，Renderer 尚不可达；
- 订阅无效时五个管理方法在网络、暂存或 mutation 之前失败；生产远端 refresh
  明确返回 `disabled/not_configured`，正式下载不能绕过空 Trust 配置；
- 本轮没有更改自动更新策略、自动 rollback、orphan 清理、发布根或 Publisher
  Bundle，符合 H2c1 原计划；
- 本机 Kimi 独立逐行审查全部 6 个代码文件和 3 份计划文档，确认订阅门禁在解析、
  网络与 mutation 之前，输入 authority、跨账户 Challenge、一次性批准、共享
  Registry、脱敏错误、生产 fail-closed、desktop 主进程窄面和 H2c2 边界均符合计划；
- Kimi 独立实跑 Host ACP 2 项、Delivery 14 项、Agent Package 9 项、AgentMesh360
  全量 140 项、桌面专项 7 项和桌面全量 45 项（另 2 项真实 Host 环境测试按预期
  skip），并执行 Clippy、Rustfmt、JS check 与 diff-check；全部通过；
- Kimi 报告 Blocker/High/Medium/Low 均为零并给出无条件 PASS，H2c1 正式关闭。

H2c1 代码提交：`34df3a5`（`feat: expose gated package management over acp`）。

H2c2 下一切片（须等 H2c1 Kimi 交叉测试关闭后启动）：

1. 建立订阅 ready-gated 的桌面 Package Center，只展示 Host 返回的脱敏 catalog、
   installed status、远端 refresh 状态和 runtime visibility；
2. 权限新增/变更必须先显示 Host Challenge，用户显式确认后只回传 `approvalId`；
   Renderer 不接收 URL、文件路径、digest、签名材料、Registry 原文或账户 authority；
3. 安装、rollback、reconcile 采用明确的进行中、成功、`refresh_pending` 与固定
   错误状态；关闭窗口或 Host 重连不能把未知结果伪装成失败后自动重试；
4. H2c2 仍不启用自动更新、自动批准、自动 rollback 或生产 Trust 配置；先完成桌面
   controller/preload/Renderer 的窄桥、输入校验、输出脱敏与双方测试。

### 循环 35：动态 Agent Package H2c2——Package Center 与显式权限批准

状态：实现、自主测试与本机 Kimi 独立交叉测试已完成

计划复核：H2c1 已提供 Host 管理 ACP，但完整 Runtime Manifest 含 Prompt、Skill
adapter 路径和源码地址，不能从桌面主进程原样转交 Renderer。H2c2 因此先建立独立
Package Controller 做白名单投影，再接 preload/Renderer；不把 Host 协议直接暴露给
页面，也不提前配置生产发布根。

H2c2 已经实现：

1. 新增订阅 ready-gated、账户绑定的 `PackageController`。每个读写操作都在调用前
   捕获 account ID，异步返回前再次核对；中途退出、订阅失效或切换账户时，旧账户
   payload 被丢弃，只返回脱敏的 `unknown`，不会让旧 Challenge 回到新账户页面；
2. Controller 对 Runtime Catalog 做严格白名单投影：Renderer 只获得 packageId、
   version、publisher、公开 Agent 身份/说明和声明权限；Prompt、Model Policy、
   Skill workflow/adapter、本地路径、源码地址、Registry 原文、root key、artifact/
   envelope URL、digest、账户和 Token 全部留在 Host/主进程；
3. 安装状态、远端 Registry 状态、Challenge 和 Mutation Receipt 也逐字段验证，
   对数组、字符串、时间、枚举、计数、Package ID 与 UUID 设上限并失败关闭。Host
   已知错误映射为固定中文文案，未知错误不透传原始链；
4. preload 只开放 get snapshot、refresh Registry、按 packageId download/rollback/
   reconcile 和按 approvalId approve。主进程 IPC 再调用 Controller 校验，Renderer
   不能提交 URL、路径、digest、publisher、权限布尔值或 Registry 内容；
5. 新增 Package Center：显示 Runtime Catalog、安装/Previous/invalid/orphan 审计、
   远端 Registry 摘要、权限标签与 runtime visibility；支持手动 packageId 和当前
   Catalog 卡片下载/检查更新、本地 reconcile、显式确认 rollback；
6. 下载只有在 Host 返回 `approval_required` 时展示独立权限面板；页面不显示
   approvalId，用户点击“确认权限并安装”后只回传该一次性 ID。取消只丢弃页面状态，
   不触发安装；
7. Host timeout、退出、Bridge 中断、响应损坏或账户切换均被保守归类为
   `outcome=unknown`。页面清除可重试的批准按钮，明确要求先重新读取状态；代码没有
   mutation 自动重试；
8. 正式远端配置为 `disabled/unavailable` 时，Package Center 使用黄色关闭态并禁用
   下载/检查更新；本地 reconcile/rollback 和显式刷新 Registry 仍可用。没有伪装
   生产能力，也没有启用自动更新、自动批准或自动 rollback。

H2c2 自主验证：

- Package Controller 9 项通过：覆盖 ready 门禁先于输入解析、完整 Manifest 白名单、
  Registry 摘要、严格 ID、Challenge identity、Receipt 脱敏、已知错误固定映射、
  Host timeout 单次调用与未知结果、41→42 账户切换丢弃旧 Challenge；
- 桌面 `npm test`：54 项通过、0 失败，另有 2 个真实 Host 环境测试按预期 skip；
  `npm run check` 通过；
- Electron Package UI smoke 通过：验证 packageId-only 下载、权限 Challenge、
  approvalId-only 批准、reconcile、rollback 未知结果不自动查询/重试，以及显式刷新
  后恢复；既有 Provider UI smoke 同时通过；
- 生产关闭态 visual smoke 断言下载表单与全部远端更新按钮禁用、Registry 刷新仍可用；
  1180×760 Retina 截图已人工检查导航、状态栏、表单、双列卡片和纵向滚动布局；
- AgentMesh360 Rust 全量 140 项通过；Clippy `-D warnings`、Rustfmt 与
  `git diff --check` 通过；
- Electron smoke 首次在 reconcile 返回后的异步刷新尚未完成时查找 rollback 按钮，
  测试失败；加入明确的 DOM ready 握手后连续通过。该修复只增强测试同步，不改变
  产品 mutation 语义。

计划复盘：

- Renderer 权限面严格小于 H2c1 Host ACP：只能读取公开白名单并提交两个不透明 ID；
- Controller、Host 两层都执行订阅和账户边界；页面在身份离开 ready 或账户变化时
  清空 snapshot、Challenge 和 unknown outcome；
- `refresh_pending`、`superseded` 与 `visible` 有独立用户文案，未知 mutation 不会
  被伪装成失败后重试；
- 生产发布根、endpoint、Publisher Bundle 继续为空，关闭态下载按钮不可用；
- Kimi 第一轮独立逐行审查 9 个代码/测试文件和 3 份文档，实跑 Controller 9 项、
  桌面 54 项、两条 Electron UI smoke、生产关闭态 visual smoke、Rust 140 项以及
  Clippy/Rustfmt/JS/diff-check；功能、安全、账户、脱敏和关闭态均通过，但发现 1 项
  Low：rollback 默认成功前缀声称“已刷新运行时目录”，与 `refresh_pending` 或
  `superseded` Receipt 后缀矛盾，因此没有给无条件 PASS；
- rollback 文案已改为只陈述可确认事实“磁盘回滚已提交”。Package UI smoke 新增
  completed + `refresh_pending` 路径，硬断言 DOM 包含磁盘已提交和 last-known-good，
  且不含旧矛盾文案；随后第二次 rollback 返回 unknown，继续断言不自动 snapshot、
  query 或 retry，手动刷新后才恢复；
- 修复后自主重跑 Package UI、Controller 9 项、JS check 和 diff-check 全部通过；
  Kimi 第二轮再实跑 Package UI、Controller 9 项、桌面 54 项、JS check 与
  diff-check，确认原有 unknown 断言没有弱化，Blocker/High/Medium/Low 全部为零并
  给出无条件 PASS，H2c2 正式关闭。

H2c2 代码提交：`73950fd`（`feat: add safe agent package center`）。

H2c3 下一切片（须等 H2c2 Kimi 交叉测试关闭后启动）：

1. 从 Host 已验证的远端 Registry 增加只读可发现摘要，只投影 packageId、agentId、
   version、publisher 与 Registry revision/expiry；绝不暴露 artifact/envelope URL、
   digest、签名、原始文档或本地缓存路径；
2. Package Center 区分“新 Agent”“已安装更新”“当前版本”和“未知本地状态”，用户
   从可发现条目发起的下载仍只提交 packageId，权限仍必须经过现有 Challenge；
3. 摘要受订阅、可信时间、签名、反回滚、过期、账户切换和 256 条上限约束；无可信
   cache 时失败关闭并保留当前 Runtime Catalog；
4. H2c3 仍不填充生产 root/endpoint/bundle，不实现自动更新、搜索服务、推荐排序或
   后台下载；可发现协议和 UI 通过双方测试后，再单独进入生产供应链发布门。

### 循环 36：动态 Agent Package H2c3——已验证远端目录与更新分类

状态：实现、自主测试与本机 Kimi 独立交叉测试已完成

计划复核：H2c2 已有安全 Package Center，但用户只能手工输入 packageId 或从当前
Runtime Catalog 检查更新，尚不能看见 Host 已验证 Registry 中的新 Agent。H2c3 只
增加安全的只读发现面，不改变 H2b/H2c 已建立的下载、权限批准、安装或 rollback
authority，也不提前填充生产发布配置。

H2c3 已经实现：

1. `PackageTrustCacheStore::load_verified_catalog` 复用完整的可信时间、root、
   Publisher Bundle、Registry 签名、digest、有效期和持久反回滚复验，只从通过复验
   的记录投影 packageId、agentId、version 与 publisher；artifact/envelope URL、
   SHA-256、签名、root、原始文档和缓存路径不会进入返回类型；
2. `PackageRegistryFetcher::discover` 增加三态只读结果：有效缓存为 `ready`，没有
   缓存且生产 endpoint 未配置为 `disabled/not_configured`，无可信缓存或缓存被拒绝
   为脱敏 `unavailable`。仍在有效期内且重新验签通过的 Last Known Good 即使刷新
   endpoint 暂不可用也可以被发现，但刷新/下载是否开放继续由现有 Registry 状态门
   单独控制；
3. 新增订阅门禁的
   `x.agentmesh360/agent-packages/remote-catalog` ACP。请求必须是严格空对象；Host
   只返回 Registry revision/expiry 和最多 256 条安全摘要，拒绝调用方提供 URL 或
   其他 authority；
4. 桌面 `AcpHostClient` 和 `PackageController` 把远端摘要纳入同一次账户绑定
   snapshot。Controller 对 outcome/reason、revision、时间、数组、标识和 SemVer
   逐字段失败关闭，并继续丢弃 Host 返回的额外 URL、digest、root 或账户材料；
5. Controller 用完整 SemVer precedence 将远端记录与 Runtime Catalog 分类为
   `new_agent`、`update_available`、`current`、`local_newer`。核心版本和任意长度的
  数字预发布标识使用字符串数值序，避免 JavaScript `Number` 精度造成更新误判；
6. Package Center 新增“已验证远端目录”，只展示新 Agent 和可用更新；用户点击后
   仍只提交 packageId，后续继续使用 H2c2 的一次性权限 Challenge。当前版本和本地
   更新版本保留在 Controller 分类中，不制造可执行更新按钮；
7. 生产关闭态仍禁用手工下载和全部发现条目按钮，允许显式刷新与本地恢复；没有加入
   自动更新、后台下载、搜索、推荐排序或任何生产 root/endpoint/bundle。

H2c3 自主验证：

- Trust Cache 5 项、Registry Fetcher 4 项、Host Package 管理 ACP 2 项通过；正向
  ACP 断言返回的唯一 Package 只有四个公开字段，生产空配置为
  `disabled/not_configured`，额外 URL 参数严格拒绝；
- Package Controller 12 项、ACP Client 7 项通过；覆盖四种版本分类、超出 JavaScript
  安全整数范围的 SemVer、257 条上限、非法版本/时间、非空关闭态、账户门禁和额外
  authority 白名单丢弃；
- 桌面 `npm test` 为 57 项通过、0 失败，另有 2 个真实 Host 环境测试按预期 skip；
  `npm run check` 通过；
- Electron Package UI smoke 验证发现条目只提交 packageId、approvalId 不进入 DOM，
  以及既有 approve/reconcile/rollback/unknown 零自动重试路径；Provider UI smoke
  同时通过；
- 生产关闭态和签名缓存 ready 态两张 1180×760 Retina visual smoke 均通过并人工
  检查。关闭态全部下载入口禁用、刷新可用；ready 态正确显示“新 Agent”“可用更新”
  与版本差，不出现下载 URL、digest、签名或 root；
- AgentMesh360 Rust 全量 140 项通过；Clippy `-D warnings`、Rustfmt、JS check 和
  `git diff --check` 全部通过；
- 受限沙箱首次禁止 Rust loopback mock server 和 Electron GUI 启动；同一测试在获准
  的本机非沙箱环境通过。另一次 Host 正向测试揭示发现接口先于安全缓存检查就因
  endpoint 为空返回 disabled；已改为先重新验签缓存、无缓存时再关闭，并重跑全部
  门禁通过。

Kimi 独立交叉测试：

- Kimi 在基线 `07d842c` 上逐行审查当前 15 个代码、测试和文档文件的完整 diff，
  独立核对可信时间/签名/expiry/反回滚/256 上限、LKG 与生产关闭态、严格 ACP、
  41→42 账户切换、Renderer 白名单、SemVer、packageId-only UI 和三份文档；
- Kimi 实际执行 Trust Cache 5 项、Registry Fetcher 4 项、Host ACP 2 项、
  AgentMesh360 140 项、桌面 57 项（另 2 项真实 Host 按预期 skip）、Package 与
  Provider Electron UI、生产关闭态与 ready 态 visual smoke、Clippy、Rustfmt、
  JS check 和 diff-check，全部通过；两张截图也独立人工核对；
- Kimi 确认 Blocker/High/Medium/Low 均为零并给出“无条件 PASS”。H2c3 正式关闭。

H2c3 代码提交：`760a380`（`feat: discover verified agent package updates`）。

计划复盘：

- H2c3 没有新增下载 authority；Host 仍独占 Registry 原文、网络位置、digest、签名
  与本地文件，Renderer 只能提交 packageId；
- 订阅硬门禁、可信 Core 时间、签名链、expiry、持久反回滚和账户切换仍位于发现
  摘要之前；Runtime Catalog 在远端不可用时保持不变；
- 实现分类名称按真实状态收敛为 `local_newer`，替代原计划含混的“未知本地状态”；
- 生产 root、Publisher Bundle、metadata/artifact endpoint 继续为空，不能把测试
  fixture 或本地签名材料当成生产发布能力；
- 下一轮 H2d0 先建立非秘密、可审计、可复现的发布输入和 Package 构建门：由同一
  Manifest 产出客户端 Package 与宿主 Skill 投影，签名动作只接外部提供的 key
  handle/签名结果，不在仓库生成或保存生产私钥。真实 root、endpoint 和发布启用
  仍需单独的安全审计与发布授权。

H2d0 下一切片（须等 H2c3 Kimi 交叉测试关闭后启动）：

1. 定义版本化、严格校验的 Package Authoring 输入与构建输出清单，让新 Agent 只维护
   一份 Manifest/Skill 来源即可生成客户端 Artifact、Envelope 输入和宿主 Agent
   安装投影，避免两条产品路径漂移；
2. 构建必须可复现并在签名前完成 archive inventory、digest、Manifest 引用和
   publisher/package/agent/version 一致性校验；不接受 URL、账户、Token 或用户数据；
3. 私钥不进入仓库、环境快照、日志或 Package。H2d0 只输出待签 payload/digest 并
   接受外部签名结果；生产 key ceremony、root/bundle、endpoint 与上传发布是后续
   独立门禁；
4. 验收包括正向可复现构建、客户端/宿主 Skill 同源断言、篡改/多余文件/路径穿越/
   未声明权限失败关闭，以及自主测试和 Kimi 独立交叉测试。

### 循环 37：动态 Agent Package H2d0——同源 Authoring 与可复现构建

状态：实现、自主验证与本机 Kimi 独立交叉测试已完成

计划复核：H2c3 已经让用户看到经过完整信任链验证的新 Agent/更新，但生产目录仍没有
安全、可重复的发布输入。如果每次由人工分别整理客户端 Package 和网站 Skill，
Manifest、工作流、Adapter 与权限很快会漂移。H2d0 只建立离线构建门，不接生产私钥、
Root/Bundle、endpoint、上传或发布。

H2d0 已经实现：

1. 新增严格 `agentmesh-authoring.toml` v1。Manifest Adapter 与 bundle 必须一一对应，
   每个 bundle 必须含真实入口；Canonical Workflow、额外 Package 文件与宿主 Skill
   文件均由显式 allowlist 读取；
2. Authoring 拒绝未知字段/Schema/权限、路径穿越、非规范路径、保留文件名、symlink、
   非普通文件、重复/遗漏 Adapter、越界文件和越界总量。定义目录与源码目录可相同，
   因而未来新 Agent 可把 Manifest、Authoring 和 Skill 都维护在自己的源仓库；
3. 确定性构建使用排序文件表、`package-files.v1.json`、固定 tar
   mode/uid/gid/mtime 与 zstd level 3，输出不含时间、随机数、机器路径、账户或
   Provider 材料；
4. 单次 build 同时输出客户端 `.ampkg.tar.zst`、非秘密 signing request 与
   Host Skill projection。投影绑定完整 Artifact SHA-256，并记录 Canonical Workflow
   和每个宿主入口/文件的路径、长度和 SHA-256；
5. CLI 不接收私钥且没有网络代码。Finalize 必须重新读取实际 Artifact，核对固定
   文件名、32 MiB 上限和 SHA-256，重建 H1 确定性 payload 并执行 Ed25519 strict
   verification，才以 `0600` 创建 Envelope；已存在输出拒绝覆盖；
6. 输出目录/文件从创建瞬间即为 Unix `0700/0600`，任一写入或权限失败清理本次
   不完整输出。Signing request、projection 和 receipt 均不含绝对源码路径或秘密；
7. 三个首方定义均已加入 Authoring v1：Job Agent 投影 Claude Code/OpenClaw，
   LectureCast 投影 Codex/Claude Code/OpenClaw，Deploy 如实只含 Canonical
   `AGENTS.md`，不虚构宿主 Adapter。

H2d0 自主验证：

- Authoring 库专项 6 项通过，覆盖逐字节可复现、客户端/宿主同源、外部测试签名经
  运行时 Artifact Gate 接受、篡改 Artifact/请求/签名、错误公钥、未知权限、遗漏
  Adapter、路径穿越、未列出源码不影响产物、symlink 与越界文件失败关闭；
- CLI 契约 1 项通过，build/finalize 的必需参数和 subcommand 结构有效；
- 使用真实 `/Users/ferdinandji/AgentMesh-JobAgent`、
  `/Users/ferdinandji/AgentMesh-Lecturecast` 与
  `/Users/ferdinandji/agentmesh-deploy` 全部构建成功；
- Job Agent 连续两次构建的 Artifact、signing request、Host Skill projection
  逐字节一致；Artifact SHA-256 为
  `745da8cfe76b7bc7a9f685838c651883e1a53009cc589e1aaf617429fb1c6e91`；
- LectureCast/Deploy Artifact SHA-256 分别为
  `36af51c4c07c0a7019d1ac14f0548d9785f8c6e22f7ae8fd0cac0bf7b533c929` 和
  `8bd3a14a54158eaa88f722bbb96febec9c5fbf8fd88cb32a335bd6a7aa0e86b2`；
- 真实输出目录/文件权限核对为 `0700/0600`。这些只是当前源码的开发证据，不是
  已签名生产 Release；
- AgentMesh360 Rust 全量 146 项通过；桌面 57 项通过、另 2 项真实 Host 环境测试按
  预期 skip；受影响的 Rust lib + Authoring CLI Clippy `-D warnings`、Rustfmt、
  JS check 与 `git diff --check` 全部通过。全量 Rust 首次在受限沙箱中有 27 项
  loopback mock 因禁止绑定本地端口失败，在获准的本机环境重跑后 146/146 通过。

Kimi 独立交叉测试：

- Kimi 从基线 `67fc65b` 审查完整 diff、全部未跟踪代码、三个 Authoring 定义和三份
  计划/架构文档，逐项核对严格 Schema/路径、symlink 与本地 TOCTOU 边界、大小/数量、
  inventory、自引用清单、可复现 tar+zstd、Adapter/bundle 一致性、权限失败关闭、
  signing request/Artifact/身份绑定、canonical Base64/SemVer、0700/0600、失败清理、
  projection 非信任根定位、新 Agent 动态接入和生产关闭边界；
- Kimi 实际执行 Authoring 6 项、CLI 1 项、AgentMesh360 全量 146 项、桌面 57 项
  （另 2 项真实 Host 环境测试按预期 skip）、JS check、受影响 Rust lib + CLI
  Clippy `-D warnings`、Rustfmt 与 diff-check，全部通过；
- Kimi 用 `agentmesh360-authoring-review` 非生产 keyId 独立构建 Job × 2、
  LectureCast 和 Deploy；三份 Artifact 摘要与本文档完全一致，Job 的 Artifact、
  signing request 与 Host projection 均经 `cmp` 证明逐字节一致；
- Kimi 独立核对 tar 只有 Manifest、文件清单和声明的四个 Job Agent 源文件，输出
  目录/文件为 `0700/0600`，projection Artifact 摘要正确，JSON 不含 `/Users`、账户、
  私钥或 Token，既有输出目录拒绝覆盖；
- Kimi 确认 Blocker/High/Medium/Low 均为零并给出“无条件 PASS”。H2d0 正式关闭。

H2d0 代码提交：`463ecb4`（`feat: author deterministic agent packages`）。

计划复盘：

- H2d0 实现了“一次 authoring、两个产品投影”，但 loose Host projection 本身不是
  信任根；权威字节仍是 H1 已签名 Artifact。下一轮必须从已验签 Artifact 重新导出，
  不能直接信任工作区或散落 JSON；
- 外部 public key 只能验证签名结果自洽，不等于生产 Publisher 信任。运行时仍要求
  内置 Root → root-signed Publisher Bundle → active key；
- Authoring CLI 无网络和私钥输入，生产 Root、Bundle、endpoint、Registry
  Snapshot、上传和发布启用继续为空，不能把本轮测试 key 或 placeholder `keyId`
  当成生产供应链；
- BYOK 默认、客户端订阅无效不可进入、Provider Key 只在 Host Vault、稳定 Main
  Session 和共享 Grok Harness 均未改变；本轮没有回到旧 AgentMesh 原型。

H2d1 下一切片（须等 H2d0 Kimi 交叉测试关闭后启动）：

1. 从通过 H1 Artifact/Envelope 信任验证的内容，确定性导出每个宿主 Agent 的 Skill
   发布束，不直接读取松散源码作为发布真相；
2. 逐项核对 Host projection 的 Artifact digest、身份、入口、路径、长度和 SHA-256，
   篡改、遗漏、多余文件、错误宿主或跨版本投影全部失败关闭；
3. 为新 Agent 提供可复制的同仓 Manifest/Authoring 模板和 onboarding smoke，证明
   在受支持 Schema/Capability 内无需修改 Client 内置 Catalog；
4. 仍不写入用户真实 Codex/Claude Code/OpenClaw 目录，不填生产私钥、Root/Bundle、
   endpoint，不上传、不发布；完成自主测试后交给 Kimi 独立交叉测试。

### 循环 38：动态 Agent Package H2d1——签名 Host plan 与可验证 Skill 导出

状态：实现、自主验证与本机 Kimi 两轮独立交叉测试已完成

计划复核：H2d0 外部 Host projection 绑定了 Artifact SHA-256，但如果宿主文件选择只
存在于这个松散 JSON，它仍可能从签名 Package 中重新组合出未经 Publisher 授权的
Host bundle。因此 H2d1 没有把 projection 提升为信任根，而是把精确 Host Skill plan
放回 Artifact，让 H1 Publisher 签名和 inventory 覆盖它。

H2d1 已实现：

1. Authoring 先生成严格 `HostSkillPlan v1`，以 `host-skills.v1.json` 进入 Artifact；
   `package-files.v1.json` 覆盖该 plan 及所有声明源文件。外部 projection 只保留
   Artifact SHA-256、plan SHA-256 和 plan 审核副本；
2. 新增 crate 内部 Host Skill 导出器，只接受 H1 产生的 `VerifiedStagedPackage`，
   不提供“任意目录 + 任意自带公钥”的弱入口；
3. 导出前立即重跑已安装 Package tree/inventory 验证，并要求 staging Manifest 与
   H1 结果一致；随后核对 projection 严格 Schema/大小、Artifact digest、plan 原始
   字节摘要和外部/内嵌 plan 结构全等；
4. 签名 plan 还必须逐项等于 Manifest 的 package/agent/version/publisher、权限、
   Canonical Workflow 和全部 Adapter；每个 Host、入口、文件路径/长度/SHA-256
   必须与签名 inventory 一致。未知/重复 Host、空 bundle、缺失入口、保留文件和
   inventory 外文件全部失败关闭；
5. 每个真实 Adapter 生成确定性
   `<package>-<version>-<host>.amskill.tar.zst`，内部含严格
   `agentmesh-host-skill.v1.json` 和 `payload/<Package path>`。发布清单绑定源
   Artifact、plan、Publisher keyId、Host、入口与全部文件锚点；
6. 导出沿用固定 tar mode/uid/gid/mtime、zstd level 3 和排序文件表；Unix 输出
   目录/文件为 `0700/0600`，拒绝覆盖，部分写入失败清理整个本次新目录；
7. `future-agent` 同仓 smoke 使用一个内置 Catalog 不存在的新身份完成
   Authoring → 测试签名 → H1 verify → Claude Code/OpenClaw bundle 导出，证明当前
   Schema/Capability 内无需修改 Client Catalog；Deploy 无 Adapter 时如实导出零个
   bundle。

H2d1 自主验证：

- Authoring 专项 6/6；
- Host Skill 导出专项 7/7，覆盖确定性、动态新 Agent、零 Adapter 不虚构 Host
  bundle、未知/缺失 projection 字段、
  错误 Artifact/plan digest、Host/权限/版本/文件偏移、staging 篡改/额外文件/symlink、
  `0700/0600`、拒绝覆盖和部分失败清理；另有 1 个显式首方源码路径测试默认 ignore；
- 显式首方测试已单独实跑。Job、LectureCast、Deploy 各连续构建两次，Artifact、
  signing request、projection 均逐字节一致；经非生产测试 Publisher 签名和 H1 验证
  后，Job 导出 2 个、LectureCast 导出 3 个、Deploy 导出 0 个 Host bundle；
- 当前首方 Artifact SHA-256：
  Job `d00f374e2442c6853ff8dd39a9d832d4410b86b6027661483205c2d0fd692dd0`，
  LectureCast `229bb50b7ed095871bb282fe462519d3dcf5aa336283c2441f381f8913bce2b9`，
  Deploy `9a40f1fe4385f2c1e644cf0ad39d2d2daf0797f736dc1880b38e19ae573792ec`；
- H2d1 内嵌 plan 会改变 H2d0 历史 Artifact 字节，以上是当前源码新基线，不回写或
  否定 H2d0 已关闭提交的历史证据；
- AgentMesh360 全量在本机环境 153 项通过、1 个首方源码测试按设计默认 ignore。
  受限沙箱首跑的 27 个失败仍全部是禁止 loopback bind；获准环境重跑后为零失败；
- 桌面 57 项通过、2 个真实 Host 环境测试按预期 skip；Authoring CLI 1/1、
  Rust lib Clippy `-D warnings`、Rustfmt、JS check 与 `git diff --check` 通过。

完整契约与首方 bundle 摘要见
`docs/architecture/AGENT_PACKAGE_HOST_SKILL_EXPORT_V1.md`。

Kimi 独立交叉测试：

- 用户明确授权把 Client 当前完整 diff、未跟踪文件内容和相关路径发送给 Kimi；权限
  审查没有允许读取三个额外首方源码仓库内容，因此 Kimi 只审查本仓库，自主测试保留
  首方源码双构建和摘要证据，两类范围没有混写；
- Kimi 首轮逐行审查代码/文档并实跑全部仓库内命令，结论为“无条件 PASS”，同时记录
  4 条 Low：plan/projection/export Schema 常量耦合、零 Adapter 仅在 ignored 测试、
  文件检查/open 间 TOCTOU 可继续收紧、crate-internal 尚无非测试调用方；
- 本轮没有接受“带 Low 的 PASS”作为关闭。代码拆分三个 Schema 常量；加入默认
  zero-adapter 完整链路回归；Unix 打开加入 `O_NOFOLLOW | O_CLOEXEC`、device/inode
  一致性和打开后长度校验；代码/文档明确不提供任意自带公钥的弱 CLI，H2d2 Release
  assembler 是首个计划中的非测试调用方；
- Kimi 第二轮重新审查完整 diff，实跑 Authoring 6/6、Host export 7/7、
  AgentMesh360 153+1 ignored、CLI 1/1、桌面 57+2 skip、Clippy `-D warnings`、
  Rustfmt、JS check 和 diff-check；确认首轮 4 条全部关闭；
- Kimi 最终确认 Blocker/High/Medium/Low 均为零并给出“无条件 PASS”。审查会话：
  `session_35887117-cef7-4816-bc4d-13061db20f03`。H2d1 正式关闭。

计划复盘：

- H2d1 已把客户端持久 Agent Artifact 和宿主 Skill bundle 放回同一 Publisher 授权
  边界；外部 projection 仍只是可审计副本；
- 当前导出器是发布流水线内部能力，不写用户真实宿主目录。生产 Registry/网站仍没有
  一个同时绑定客户端 Artifact、Envelope 和全部宿主 bundle 的跨渠道发布单元；
- BYOK 默认、订阅无效不可进入客户端、Provider Key 仅在 Host Vault、稳定 Main
  Session、共享 Grok Harness 和旧 `/Users/ferdinandji/AgentMesh` 仅作迁移来源均未
  改变；
- 生产 Root/Publisher Bundle、私钥仪式、endpoint、上传、网站发布和真实用户安装
  继续关闭，不能把本轮 `[43; 32]` 测试 key 当作生产供应链。

H2d2 下一切片（须等 H2d1 Kimi 交叉测试关闭后启动）：

1. 定义严格、确定性的 `Agent Release Manifest v1`，绑定 package/agent/version、
   H1 Artifact/Envelope digest 和全部 H2d1 Host bundle receipts；
2. 让客户端 Package Registry 与官网/宿主安装入口未来消费同一 digest 集合，明确
   客户端持久 Agent 与宿主 Skill 是同一 Agent Release 的两个产品投影；
3. 覆盖缺 bundle、多 bundle、重复 Host、跨版本、摘要替换、未知字段/Schema、
   非确定性输出和无 Adapter Agent 的失败关闭/正向测试；
4. 仍只做离线 assembly 与验证，不填生产 endpoint/root/bundle，不上传、不发布，
   不写入用户真实 Codex/Claude Code/OpenClaw 目录。

### 循环 39：动态 Agent Package H2d2——跨渠道 Agent Release Manifest

状态：实现、自主验证与多轮本机 Kimi 独立交叉测试已完成

计划复核：H2d1 已证明客户端 Artifact 和每个 Host bundle 来自同一 Publisher 授权
plan，但 Registry 与官网仍缺少一个共同的 release 内容单元。如果后续分别拿 Artifact
和 bundle 发布，两条路径仍可能出现版本或摘要漂移。H2d2 因此只建立离线 Release
Manifest，不提前接生产 Registry、URL、上传或用户安装。

H2d2 已实现：

1. `VerifiedStagedPackage` 新增 H1 实际解析并验签的 Envelope 原文字节 SHA-256；
   release assembly 必须收到逐字节相同的 Envelope，字段语义相同但空白/排序不同的
   JSON 也不能冒充 H1 输入；
2. H2d1 receipt 字段改为模块私有，只能由成功写出 Host bundles 的 H2d1 路径创建；
   receipt 新增 projection SHA-256，并继续绑定 plan、Artifact、Publisher keyId 和
   每个 bundle 的实际路径/摘要；
3. 新增严格 `Agent Release Manifest v1`，绑定 package/agent/version/publisher、
   Artifact/file inventory、Envelope 原文、projection/签名 plan，以及排序后的全部
   Host bundle 文件名、入口和 SHA-256；
4. Assembly 前再次复验 staging tree；Envelope、projection、receipt identity 和
   Manifest Adapter 一一覆盖必须全等。每个 bundle 重新以 H2d1 的
   `O_NOFOLLOW + device/inode` 门读取，核对 canonical 文件名、32 MiB 上限和摘要；
5. Manifest verifier 拒绝未知字段/Schema、非 canonical JSON、非 canonical SemVer、
   非法或超长身份/入口、错误文件名/摘要、重复或非排序 Host；
6. 输出为
   `<packageId>-<version>.agent-release.v1.json`，不含 URL、时间戳、账户、Token、
   Provider Key、生产私钥或本机路径；Unix 输出为 `0700/0600`，拒绝覆盖并在失败时
   清理本次新目录；
7. 零 Adapter Agent 合法输出 `hostBundles = []`，因此 Deploy 仍可作为客户端持久
   Agent，而不会虚构宿主 Skill。新 Agent 沿 H1 → H2d1 → H2d2 无需专属 release
   代码或内置 Catalog 修改。

H2d2 自主验证：

- Release assembly 专项 5/5，覆盖逐字节确定性、strict verifier、H1 Envelope 与
  projection 漂移、bundle/staging 篡改、缺失/重复 Host、跨版本 receipt、未知
  Schema/字段、Host 顺序、版本文件名漂移、拒绝覆盖、`0700/0600` 和零 Adapter；
- AgentMesh360 本机全量 158 项通过、1 个显式首方源码测试默认 ignore；
- 显式首方测试已单独实跑：Job、LectureCast、Deploy 均双构建逐字节一致，经测试
  Publisher 签名、H1 verify、H2d1 export 后完成 H2d2 assembly；
- 首方 Release Manifest SHA-256：Job
  `70b0ca7d60959fcad6fbf81f8fd69fb9edd9d0a9dd938d98ae238458be26f4c0`，
  LectureCast `abdeefac441d4f98e87bc1bc1c8a5e8c4b35c420c77d635399c7ae1e327a5173`，
  Deploy `381101227368f93518629cbc75f7acd0c20b747dcd35121e9088e1af156c5b02`；
- Authoring 6/6、Host export 7/7、CLI 1/1、桌面 57+2 skip、Clippy
  `-D warnings`、Rustfmt、JS check 和 diff-check 通过；
- 所有 key 均为测试材料，以上摘要不是生产 Release、Git tag、CI provenance、
  Registry 上线或网站发布证明。

Kimi 独立交叉测试与修复：

- Kimi 会话 `session_e2208b8a-d53b-4b06-a2cf-57894f4d05df` 从基线
  `e7d0b74` 独立读取本仓库完整 diff 和两个未跟踪文件，实跑 Artifact 8/8、
  Authoring 6/6、Host export 7/7 + 1 ignored、Release 5/5、AgentMesh360
  158 + 1 ignored、CLI 1/1、桌面 57 + 2 skip、Clippy、Rustfmt、JS check 与
  diff-check，全部通过；遵守授权边界，没有读取三个外部首方源码仓库；
- 首轮 Blocker/High/Medium 为零，但严格门槛下报告 3 条 Low：H1 Adapter path
  尚无 512 字节上限而 H2d2 有、Release 身份校验允许 H1 禁止的内部下划线、等数量
  未知 Host receipt 分支缺直接测试，因此首轮结论为 FAIL；
- 已让 H1 Manifest 与 H2d2 Release 共用 128 字节身份上限、H1 字符集校验器和
  512 字节相对路径上限；新增 H1 超长 Adapter path、Release 内部下划线身份和
  等数量未知 Host receipt 的失败关闭覆盖。自主复测 Agent Package 9/9、
  Release 5/5、Host export 7/7 + 1 ignored、AgentMesh360 158 + 1 ignored、
  CLI 1/1、桌面 57 + 2 skip 与全部静态检查已通过；
- Kimi 第二轮重新审查修复 diff 并独立实跑同一全套验证，确认首轮 3 条 Low 全部
  实质关闭、没有引入新问题；最终 Blocker/High/Medium/Low 均为零并给出“无条件
  PASS”。H2d2 正式关闭。

完整 Schema、功能流程、信任边界和首方摘要见
`docs/architecture/AGENT_RELEASE_MANIFEST_V1.md`。

计划复盘：

- H2d2 已把“一份 Agent Release、客户端持久 Agent 与宿主 Skill 两个产品投影”固化为
  一个 deterministic content unit，但 Manifest 自身还没有进入 Root/Publisher/
  Registry 签名与反回滚链；
- Release Manifest 不含 URL，避免可复现内容被环境 endpoint 污染；URL、rollout、
  expiry 和渠道投影应由受签名发布索引承载；
- BYOK、订阅硬门禁、Provider Vault、credits、稳定 Main Session、共享 Grok Harness
  和旧原型迁移边界均未改变；
- 生产 root/bundle/endpoint、上传、网站发布和真实宿主安装继续为空/关闭。

H2d3 下一切片（须等 H2d2 Kimi 交叉测试关闭后启动）：

1. 设计新的受签名 Release Registry Schema，绑定 Release Manifest URL/SHA-256，
   复用可信 Core 时间、Root → Publisher Bundle、expiry 与持久反回滚；
2. 从同一已验证 Release 生成客户端 Artifact 下载投影和官网/Host Skill 只读投影，
   任何渠道不得自己重组 package/version/digest；
3. 覆盖缺渠道、摘要漂移、跨版本、重复 Host、release digest 不一致、过期/回滚和
   Last Known Good；
4. 生产 endpoint/root/bundle 继续为空，只做离线 fixture、缓存与投影测试，不上传、
   不发布、不写用户真实宿主目录。

### 循环 40：动态 Agent Package H2d3——受签名 Release Registry v2 与双渠道投影

状态：实现、自主验证与两轮本机 Kimi 独立交叉测试已完成

计划复核：H2d2 已产生绑定客户端 Artifact 与全部宿主 bundles 的确定性 Release
Manifest，但它还未进入 Root 签名、可信时间、expiry、revision 反回滚和 Last Known
Good 链。H2d3 因此升级现有 Registry，而不是另造旁路信任根或提前启用生产发布。

H2d3 已实现：

1. Registry Snapshot Schema 从 v1 升级为 v2，签名 domain 同步升级；每条记录新增
   Release Manifest URL/SHA-256、Host projection URL/SHA-256 和排序后的全部 Host
   bundle Host/入口/URL/SHA-256，Root 签名 payload 覆盖所有新增字段和 bundle 数量；
2. 新增 Release Registry binder，只接受字段私有、由 H1 Verified staging +
   H2d1 receipt 产生的 H2d2 `AgentReleaseBuild`；调用方只能提交 HTTPS URL，全部
   digest、身份、入口和文件名都从 build 提取，不能重新填写；
3. Binder 复验 build 内 canonical Release 文档与 metadata，要求 URL 无
   credentials/query/fragment 且最后一个 path segment 精确等于 Release 文件名；
   Host URL 对 Release Host 一一覆盖，缺失、重复、未知 Host 和跨版本文件名均失败；
4. 同一已签名 record 生成共享 Release reference 的 Client Artifact 投影和官网 /
   Host Skill 只读投影；客户端下载器已改为只读 Client projection，Renderer 继续只
   收 package/agent/version/publisher 与更新分类；
5. Registry verifier 拒绝 v1、未知字段、非法 URL/digest、重复/非排序 Host、非法
   入口、Root/Publisher trust split、过期、回滚、同 revision equivocation 和签名
   篡改；Trust Cache/Fetcher 继续提供重新验签的 Last Known Good；
6. 零 Adapter Release 合法输出空 Host bundles；动态 `future-agent` 从一份 H2d2
   build 生成双投影，无需内置 Catalog 或 Agent 专属发布代码。

H2d3 定向自主验证：

- Release Registry v2 / binder / 双投影专项 7/7；
- H2d2 Release 5/5、Host export 7/7 + 1 ignored；
- Trust Cache 4/4、Downloader 6/6、Delivery 14/14、Registry Fetcher 4/4；
- AgentMesh360 全量 161 项通过、1 个显式首方源码测试默认 ignore；
- CLI 1/1、桌面 57 + 2 skip、Clippy `--lib --bins -D warnings`、Rustfmt、
  JS check 与 diff-check 通过；
- 显式首方测试已重新实跑 Job、LectureCast、Deploy；三者 H2d3
  `registryRelease` SHA-256 均逐项等于 H2d2 Release Manifest SHA-256，Host bundle
  数量分别为 2、3、0，三个 Release 摘要未变化；
- 当前证据仍使用测试 key 与离线 URL，不代表生产 Registry、CI provenance、真实
  上传、网站发布或用户可下载状态。

H2d3 本机 Kimi 独立交叉测试：

- Kimi session `session_eebb7963-7cff-4505-8edd-715bf46f18d4` 首轮读取基线
  `a7626c1` 后的完整 diff、全部未跟踪文档与本仓库路径，并独立实跑专项、全量、
  CLI、桌面和静态检查；
- 首轮 Blocker/High/Medium 为零，发现 1 项 Low：Binder 虽已拒绝等数量但集合不匹配
  的未知 Host，测试却只覆盖了缺失与重复 Host，未直接命中该分支；
- 已新增 `{Codex, ClaudeCode}` location 对 `{Codex, Openclaw}` Release 的等数量、
  无重复 unknown-Host 精确错误断言，自主复跑 Registry 7/7、AgentMesh360
  161 + 1 ignored、Rustfmt 与 diff-check 均通过；
- Kimi 第二轮确认新增断言确实越过数量和重复检查并命中
  `location Host is unknown`，复跑 Registry 7/7、Release 5/5、Host export
  7/7 + 1 ignored、Clippy、Rustfmt 与 diff-check 后，最终
  Blocker/High/Medium/Low 全部为零并给出无条件 PASS；
- Kimi 额外验证的 `--all-targets -D warnings` 只暴露本轮未修改的旧
  `provider_contract_harness.rs` dead-code 基线遗留；本轮实际门
  `--lib --bins -D warnings` 通过，不将其误记为 H2d3 回归。

完整 Schema、信任结构、双投影和关闭边界见
`docs/architecture/AGENT_RELEASE_REGISTRY_V2.md`。

计划复盘：

- H2d3 复用 Root → Publisher Bundle → Registry、可信 Core 时间、expiry、反回滚与
  LKG，不改变订阅硬门禁、BYOK、Provider Vault、credits 或稳定 Main Session；
- Binder 不签名、不接触生产私钥；生产 Root、Publisher Bundle、endpoint、上传和
  网站发布继续为空/关闭；
- 当前下载器消费受签名 Client projection，但尚未下载 Release Manifest 本身；这项
  bounded fetch 与逐字段 cross-check 不应被假装为 H2d3 已完成。

H2d4 下一切片（须等 H2d3 Kimi 交叉测试关闭后启动）：

1. Artifact 下载前 bounded fetch Release Manifest，拒绝 redirect，核对 Registry
   `releaseManifestSha256` 并 strict 解析；
2. Client 消费前逐项比对 Artifact/Envelope；Host 发布消费者逐项比对 projection 与
   bundles，任一渠道不得绕过共享 Release；
3. 覆盖 Release 缺失、摘要替换、跨版本、渠道漂移、过期 Registry 和 LKG；
4. 生产 endpoint/root/bundle、上传、网站发布和真实宿主安装继续关闭。

### 循环 41：动态 Agent Package H2d4——Release Manifest 下载与消费前交叉核对

状态：实现、自主验证与本机 Kimi 独立交叉测试已完成

计划复核：H2d3 已建立受 Root 签名的 Registry v2 与 Client/Host 双投影，但客户端下载
此前仍直接读取 Artifact/Envelope URL，没有取得 Release Manifest 本身。H2d4 因此只
补消费侧验证门，不改变 Registry 信任根、订阅硬门禁、BYOK、Provider Vault、credits、
稳定 Main Session 或生产关闭态。

H2d4 已实现：

1. 下载器在 Envelope/Artifact 前先读取受签名 Client projection 的 Release URL，
   使用相同 origin allowlist、禁止 redirect 的 Host-owned HTTP client 和 1 MiB
   响应上限；
2. Release bytes 先核对 Registry SHA-256，再经 H2d2 canonical strict verifier；
   package/agent/version/publisher、Release/Artifact/Envelope basename 与摘要必须逐项
   等于 Registry projection；
3. Artifact 通过既有 H1 签名、inventory、路径与 staging 验证后，实际
   `fileManifestSha256` 和 `signatureKeyId` 再与 Release 声明核对，防止外层渠道相同
   但 Release 内部验证 metadata 漂移；
4. 同一 strict descriptor 校验官网/Host Skill 只读投影的 projection SHA、bundle
   数量、Host、entrypoint、basename 和 SHA；零 Adapter 继续以空 bundles 正向通过；
5. Release 404、redirect、声明超限、摘要替换、非 strict JSON、跨版本 URL、Client /
   Host 渠道漂移均在后续渠道请求或批准对象产生前失败；临时下载与 staging 按既有
   RAII 清理；
6. Registry/Trust Bundle 过期时在网络前失败，不允许 stale LKG 成为下载 authority；
   重新验签且未过期的 LKG 仍可沿用相同 Release 门。

H2d4 定向自主验证：

- Downloader 10/10、Release Registry / 双投影 7/7；
- AgentMesh360 全量 165 项通过、1 个显式首方源码测试默认 ignore；
- 下载 → 权限批准 → 安装集成测试通过；
- Host ACP 跨账户批准与 Runtime refresh 集成测试通过；
- CLI 1/1、桌面 57 + 2 skip、Clippy `--lib --bins -D warnings`、Rustfmt、
  JS check 与 diff-check 通过；
- 显式首方源码测试重新实跑 Job、LectureCast、Deploy；三个既有 Artifact/Release
  摘要保持不变，并新增通过 Client/Host Release cross-check；
- 当前证据仍使用测试 key、离线 URL 与本机源码路径，不代表生产 Registry、真实上传、
  网站发布或用户可下载状态。

完整消费顺序、字段矩阵、失败关闭和边界见
`docs/architecture/AGENT_RELEASE_CONSUMPTION_V1.md`。

H2d4 本机 Kimi 独立交叉测试：

- Kimi session `session_5dea9a9a-5e40-4df1-9c62-9c6a54d94c7f` 从基线
  `6f25c68` 读取完整工作区 diff、未跟踪消费契约文档和相关本仓库源码，只读审查
  Release 网络门、strict verifier、Client/Host 双投影、H1 metadata 回对、LKG、
  RAII 清理和生产关闭边界；
- Kimi 独立实跑 Downloader 10/10、Registry 7/7、Release 5/5、Delivery 14/14、
  Trust Cache 4/4、AgentMesh360 全量 165 + 1 ignored、CLI 1/1、桌面
  57 + 2 skip，以及 Clippy、Rustfmt、JS check 和 diff-check，全部通过；
- Kimi 遵守授权边界，没有读取外部首方仓库或运行显式 ignored 首方源码测试；该项
  只保留为本轮自主验证证据，不冒充交叉验证；
- Kimi 确认 Blocker/High/Medium/Low 全部为零并给出无条件 PASS。审查同时确认旧
  H2d3 文档把历史上始终只有 4 个测试的 Trust Cache 写成 5/5；现已校正为 4/4，
  该计数误差不是 H2d4 代码回归。

计划复盘：

- H2d4 严格停在 Release 消费门，没有创建官网服务、生产 Host 下载器、上传管线或私钥
  处理；
- 生产 `PRODUCTION_TRUST_BUNDLE_URL` / `PRODUCTION_REGISTRY_URL` 与 embedded Root
  Store 继续为空，现有用户不会因此开始远端 Package 下载；
- H2d4 是当前进展文档已批准的最后切片，现已通过双方验证关闭。下一轮先复核产品
  计划与生产发布安全门，不自行命名 H2d5 或提前启用生产能力。

### 循环 42：H2d4 后产品计划复核与生产发布安全门

状态：自主审计、文档更新与两轮本机 Kimi 独立交叉复核已完成

本轮没有继续写 Package 功能，而是按循环 41 约定回看产品蓝图、持久 Agent、桌面
外壳、后台 Host 和生产关闭源码，判断下一项是否应启用真实发布。

自主审计结论：

1. 不能直接启用生产 Package。`PRODUCTION_TRUST_BUNDLE_URL`、
   `PRODUCTION_REGISTRY_URL`、embedded Root 与 Publisher Bundle 继续为空；仓库没有
   生产 key ceremony、签名发布流水线、不可变上传/原子 Registry 发布、canary 或事故
   响应证据；
2. 桌面正式分发仍只有本地 `electron-builder --mac`，没有 Developer ID、公证、
   自动更新和发布配置；签名安装包 Login Item、升级、卸载与受控 Host shutdown
   仍是明确发布门；
3. 当前最靠前的产品缺口是固定 Main Session 对话入口。Agent 卡片虽然显示“打开对话”，
   但只调用激活；公开 Agent 投影不含 `mainSessionId`，主进程/Preload/Renderer 没有
   `session/load`、`session/prompt` 或 `session/update` 通路，侧边栏会话入口仍禁用；
4. 下一开发项因此回到桌面产品外壳：Renderer 只提交 `agentId`，由主进程与 Host
   解析账户绑定的固定 Main Session，复用标准 ACP 会话协议，先完成 Job Agent 的历史
   加载、持续对话、订阅失败关闭和重连恢复，再用同一路径覆盖其他 Agent；
5. 生产 Package 与桌面发布分别受适用门约束：Package 启用需要
   R0/R1/R2/R3/R5/R6，桌面正式分发需要 R0/R4/R5/R6；两者一起向用户开放时才要求
   R0-R6 全部关闭，不能通过填常量绕过。

本轮同步修正文档漂移：

- `desktop/README.md` 不再错误声称 Provider UI、Session Binding 和动态 Package
  尚未实现，改为区分已实现的设置/Package Center 与仍关闭的真实 Provider E2E、
  固定对话和生产发布；
- `PERSISTENT_PRODUCT_AGENTS.md` 更新 D1d、Provider UI 和下一产品项状态；
- `PRODUCT_BLUEPRINT.md` 把桌面固定对话列为下一验收点，并链接新的
  `PRODUCT_PLAN_AND_PRODUCTION_RELEASE_GATE.md`。

自主验证：

- `git diff --check` 通过；
- Markdown 相对链接、代码围栏和两个新增 Mermaid flowchart 基础检查通过；
- 桌面测试 57 项通过、2 项按既有真实 Host 环境门槛 skip；
- `npm run check` 通过；
- 本轮没有修改 Rust、Electron 源码或生产配置，因此没有把此前 H2d4 全量结果冒充为
  本轮新增代码测试。

计划复盘：

- 下一轮不进入 Package H2d5，也不触碰生产 Root、endpoint、私钥、上传或发布；
- 下一开发项只做固定 Main Session 对话入口第一切片，不一次扩展活动、产物、审批、
  垂直工作区、OAuth 或新 Provider 协议；
- 外部真实 Provider E2E 等待用户明确提供测试凭据与费用授权，不作为本地 UI
  基础开发的阻塞项；
- Kimi 首轮发现 1 项 Low：发布门标题把 Package 与桌面分发混在一起，无法判断
  R4 是否阻断独立 Package 评审；现已按两条发布链标注适用门并修正文案；
- 完整门槛、顺序和非目标见
  `docs/architecture/PRODUCT_PLAN_AND_PRODUCTION_RELEASE_GATE.md`。

Kimi 独立交叉复核：

- session `session_82ff5b58-3839-4ea5-849a-acf563f07bb6` 只读审查当前完整 diff 和
  未跟踪门槛文档，并直接从 Rust/Electron 源码验证生产关闭态、固定对话缺口、
  Provider/Package/Binding 状态与桌面分发配置；
- 首轮 Blocker/High/Medium 为零，报告 1 项 Low：同一门表混用 Agent Package 标题
  与桌面 R4，和“两条链单独评审”不够清楚；
- 修复后分别定义 Package 的 R0/R1/R2/R3/R5/R6 与桌面的 R0/R4/R5/R6，并保留
  两者一起开放才要求 R0-R6 全关；Kimi 第二轮确认集合、表格和跨文档文案一致；
- 两轮都执行 `git diff --check`，第二轮同时核对相对链接、代码围栏与 Mermaid，
  最终 Blocker/High/Medium/Low 全部为零并给出无条件 PASS。

### 循环 43：Job Agent 固定 Main Session 对话入口第一切片

状态：实现、自主验证与两轮本机 Kimi 独立交叉测试已完成

本地功能提交：`818e98c feat: add persistent agent conversation entry`

计划校准：

- 循环开始先复核产品蓝图、循环 42 的发布门和当前源码，确认最靠前缺口仍是
  “Agent 首页 → 固定 Main Session 历史与持续对话”；
- 本轮只开放 Job Agent 的文本对话入口；底层 Controller 使用通用 `agentId`，但没有
  提前开放 LectureCast、Deploy 或动态 Agent；
- 没有启动 Package H2d5、生产 Root/endpoint/上传、Provider 扩展、OAuth、工具审批、
  活动、产物或垂直工作区。

已经实现：

1. `AcpHostClient` 复用标准 ACP `session/load`、`session/prompt` 与
   `session/update`，没有建立第二套聊天数据库或 Harness 协议；
2. Renderer 只提交 `agentId` 与文本。主进程在订阅准入为严格 `true` 后激活 Agent，
   再由 Host Registry 解析账户绑定的 Main Session 与 Workspace；Session ID、cwd、
   Provider 凭据和原始 Host 错误不进入 Renderer；
3. 新增主进程 `AgentConversationController`，负责历史 replay、live 文本 chunk 聚合、
   200 条 / 20 万字符有界公开投影、跨 Session 过滤和安全错误；
4. 账户切换、退出、订阅拦截、Host 不可用与 Leader 重连都会撤销临时 conversation
   authority；重连后必须重新打开并从 Host 恢复同一 Main Session；
5. Prompt 超时后也撤销临时 authority，忽略仍在到达的旧 turn chunk，防止与重发
   交错；不同 Agent 的并发打开不会复用错误 Promise；
6. Job Agent 卡片现在显示“激活并打开 / 打开对话”，侧边栏出现“当前对话”；其他
   Agent 仍只执行激活。页面包含历史、流式状态、文本输入和明确的安全投影说明；
7. 修复了 Agent 激活错误旁路，Renderer 不再收到 Host 原始错误、路径或秘密片段。

自主验证：

- `cd desktop && npm test`：69 项中 67 项通过、0 失败，2 项真实 Host 环境门默认
  skip；新增测试覆盖安全投影、账户/重连撤权、不同 Agent 并发、Prompt 超时、严格
  订阅门和有界历史；
- `npm run check` 通过；
- `npm run test:conversation-ui`、`npm run test:package-ui`、
  `electron tests/provider-ui-smoke.js` 与 `electron tests/visual-smoke.js` 均在真实
  Electron 窗口中通过；
- 使用本轮构建的 `target/debug/xai-grok-pager` 运行
  `real-host.test.js` 与 `real-host-lifecycle.test.js`：2/2 通过，验证跨账户
  `session/load` 拒绝、订阅失效后 `session/prompt` 拒绝，以及 Bridge detach /
  Leader 替换后同一 Main Session 仍可加载；
- `git diff --check` 与源码秘密/私有路径静态扫描通过。沙箱内真实 Host 用例曾因
  `listen EPERM 127.0.0.1` 失败，随后在本机权限下重跑通过，没有把环境失败或 skip
  记作通过。

Kimi 独立交叉测试：

- Kimi session `session_c6129f01-8b1a-4f0c-9f51-c7e8a203244c` 获得用户对本仓库
  完整 diff、未跟踪文件和相关本地路径的明确授权，只读检查 ACP Schema、Host 门禁、
  replay/live 聚合、IPC 投影、建窗恢复与 Job-first 边界，并独立执行桌面、Electron
  和真实 Host 测试；
- 首轮 Blocker/High/Medium 为零，发现 3 项 Low：live chunk 会抢回当前页面、不同
  Agent 并发打开会复用错误 Promise、Prompt 客户端超时后迟到 chunk 可能与重发交错；
- 三项均在本轮关闭，并补充 `canEnterClient === true` 的严格失败关闭；自主复测后，
  Kimi 在同一 session 第二轮重新读取完整 diff 并执行 `npm test`、`npm run check`、
  对话 Electron smoke、真实 Host 2 项和 `git diff --check`；
- 第二轮确认 Blocker/High/Medium/Low 全部为零，所有要求命令通过，给出无条件 PASS。

计划复盘：

- 本轮保持“Renderer 无 authority、Host 拥有 Main Session/Workspace、Grok 拥有完整
  历史”的原定边界，没有把 Session ID 或 cwd 放回公开 Agent 投影；
- Job Agent 现在完成的是文本对话第一切片，不代表工具调用审批、结构化交互、活动、
  产物或垂直工作区已经完成；
- R0 仍未满足：还需完成多 Agent 通用化、重启/重连的用户级恢复体验，以及 Harness
  交互/审批边界后，才可评估产品对话闭环；
- 下一轮按原计划进入“对话恢复与多 Agent 通用化”，先把同一 Controller 与安全
  投影扩展到 LectureCast、Deploy 和动态 Agent，并补窗口重建、账户切换和重连的
  用户可见恢复测试；不进入生产发布或新的 Provider/Package 切片。

### 循环 44：对话恢复与多 Agent 通用化

状态：实现、自主验证与两轮本机 Kimi 独立交叉测试已完成

本地功能提交：`271f99d feat: generalize persistent conversations across agents`

计划校准：

- 循环开始先复核循环 43、产品计划和现有 Controller，确认 Host/Main/Preload 通路
  已经是通用 `agentId`，本轮只需关闭用户层泛化与恢复体验；
- 验收范围限定为 Host 当前账号 Catalog 返回的全部产品 Agent、Renderer reload、
  ready→ready 账号切换、重连/超时原页重开和三个首方 Agent 的真实 Host 恢复；
- 动态 `future-agent` 只作为无硬编码 UI/Controller fixture；生产 Registry 仍关闭，
  本轮不声称真实远端动态 Agent 已交付。

已经实现：

1. Job、LectureCast、Deploy 以及未来动态 Agent 卡片统一使用“激活并打开 / 打开对话”，
   不再存在 activation-only 用户路径或按 Agent 名称分支；
2. 对话标题、空状态、输入提示、流式状态与头像均从安全 `displayName` 派生；Agent
   卡片头像也按名称首字符生成，不再按位置循环 `J/L/D`；
3. Leader 重连或 Prompt 超时产生的 error snapshot 在当前对话显示“重新打开”，只把
   安全 `agentId` 重新交给主进程，仍须通过格式、当前账号 Catalog 和订阅检查；
4. Renderer reload 会从主进程读取有界安全 snapshot，恢复当前消息和视图；用户在
   Agent、Provider 或 Package 页面时，后台 live chunk 不会抢回对话页面；
5. ready→ready 账号切换会清空旧 snapshot/authority，旧 Session 的迟到 chunk 被
   丢弃，不能被新账号恢复或继续发送；
6. 真实 Host 测试激活 Job、LectureCast、Deploy，验证三者 Main Session ID 唯一；
   Bridge detach 与 Leader 替换后，三个 Agent 都保持原 ID 并可重新 `session/load`。

自主验证：

- 失败优先 Electron 测试先确认 LectureCast、Deploy 和 `future-agent` 仍是
  activation-only；实现后转绿；
- `cd desktop && npm test`：71 项中 69 项通过、0 失败，2 项真实 Host 环境门 skip；
- `npm run check`、`git diff --check` 与源码私有字段静态扫描通过；
- Conversation、Package、Provider、Visual 四组真实 Electron smoke 全部通过；
- 真实 Host `real-host.test.js` 与 `real-host-lifecycle.test.js`：2/2 通过，最终
  复跑耗时约 19 秒；没有把默认 skip 当作通过。

Kimi 独立交叉测试：

- Kimi CLI 可恢复 session `session_5f61347a-4131-4611-afc4-fb3f015e481e`
  （报告内部审查 ID `7d082017-4814-481c-891d-98bcd7d27a56`）从基线 `715151d`
  只读审查完整 diff、Controller/Main/Preload/Identity 边界，并独立执行
  69 + 2 skip、四组 Electron smoke、真实 Host 2 项和 diff-check；
- 首轮 Blocker/High 为零，发现 1 项 Medium 与 2 项 Low：动态 Agent 卡片按位置循环
  `J/L/D`、登录引导只枚举三个首方 Agent、activation-only 死监听残留；
- 三项全部关闭，并新增 `J/L/D/F` 头像可执行断言；自主全量复测后 Kimi 在同一
  session 第二轮重新检查完整 diff 和测试矩阵；
- 第二轮确认 Blocker/High/Medium/Low 全部为零并给出无条件 PASS。Kimi 同时确认
  保留但当前无 Renderer 调用方的 `agent:activate` IPC 仍有格式与订阅门禁，不作为
  本轮缺陷。

计划复盘：

- 多 Agent 泛化没有把 Session ID、cwd、Provider 凭据或原始错误交给 Renderer；
  动态集成继续以 Host Catalog 为唯一产品 Agent 来源，不新增客户端 Agent 白名单；
- 三个首方 Agent 的真实恢复已验证，动态 fixture 只证明用户层无需特制代码；
- R0 仍未满足：标准 ACP 客户端反向请求当前仍返回未实现，Harness 工具/权限交互
  尚无用户确认边界，不能把“文本对话可用”写成完整 Agent 操作闭环；
- 下一轮按原产品计划进入工作区增量的第一项：先审计并实现最小 Harness
  `interaction_required` / 权限审批通路；不一次加入活动、产物、垂直工作区，也不
  进入 Provider、OAuth、Package H2d5 或生产发布。

### 循环 45：标准 ACP 单次权限审批边界

状态：实现、自主验证与两轮本机 Kimi 独立交叉测试已完成

本地功能提交：`cb5a8e9 feat: add one-time harness permission approval`

切换 Agent 修复提交：`c4610ae fix: cancel permission when switching agents`

计划校准：

- 循环开始先核对产品计划与上游 Grok Build ACP 通路，确认本轮只接标准
  `session/request_permission` 客户端反向请求，不新增私有交互协议；
- 用户选择严格限制为上游当前构造的 `allow-once`（kind `allow_once`）与
  `reject-once`（kind `reject_once`）精确组合。永久允许、永久拒绝、自动批准和
  未来未知选项全部失败关闭；
- 本轮不加入 `session/request_input`、计划审批、工具活动、产物、垂直工作区，
  也不进入 Provider、OAuth、Package H2d5 或生产发布。

已经实现：

1. `AcpHostClient` 接收标准 ACP `session/request_permission` 反向请求，只返回标准
   `selected` 或 `cancelled` outcome；重复 ID、畸形参数与未知反向方法分别按标准
   JSON-RPC 错误拒绝；
2. 主进程独占原始 Request ID、Session ID、Tool Call、Option ID 与审批 authority；
   Renderer 只收到本地生成的 `permission-N`、`option-N`、安全标题和工具类型；
3. Controller 用 Option ID 与 kind 的精确组合白名单决定可见选项，不能由 Renderer
   自报任意上游 Option ID；订阅失效、账号切换、切换 Agent、关闭对话、重连、
   Host 退出、Prompt 完成和超时都会撤销待处理审批；
4. 同一时刻只允许一个待处理审批；第二个请求失败关闭。审批五分钟超时后，本地安全
   snapshot 显示“权限确认已超时，请让 Agent 重新发起”，但发给 Host 的标准 wire
   outcome 仍是 `cancelled`；
5. 对话页加入显式审批卡，只提供“仅本次允许”“仅本次拒绝”和“暂不执行”；响应中
   禁用全部按钮并阻止双击重复提交，空 gates 容器不会占位。

自主验证：

- 最终 `cd desktop && npm test`：83 项中 81 项通过、0 失败，2 项真实 Host 环境门
  skip；`npm run check` 与 `git diff --check` 通过；
- Conversation、Package、Provider、Visual 四组真实 Electron smoke 全部退出码 0；
- 使用临时 `CARGO_TARGET_DIR` 构建真实 Rust Host 后，
  `real-host.test.js` 与 `real-host-lifecycle.test.js` 2/2 通过，证明早期实现没有
  破坏订阅、Leader 与 Session 恢复；该测试没有触发真实工具权限请求，因此不把它
  写成“真实 Host 权限循环已验证”；
- 临时构建目录已删除；仓库原有约 54 GiB、全部被 Git 忽略且无跟踪文件的
  `target/` 经核对与 dry-run 后使用 `git clean -fdX target` 清理，最终测试确认仓库
  `target/` 不存在。

Kimi 独立交叉测试：

- Kimi CLI 可恢复 session `session_09709815-0885-4f57-acab-4896184226fa` 只读检查
  完整 diff、Host permission option 构造器、Main/Preload authority、Controller、
  Renderer 和测试，并在功能基线独立运行检查、82 项 Node 测试与四组 Electron
  smoke；
- 首轮 Blocker/High/Medium 为零，发现 5 项 Low：双击时的误导错误、超时无用户可见
  结果、生命周期测试缺口、空容器 CSS 失效、上游选项过滤仅按字面 ID；
- 五项全部修复，并补充 stop/exit 生命周期、畸形与重复 ID、并发第二请求、伪造
  IPC、白名单过滤和双击单发等回归用例；同一 session 第二轮重新检查完整 diff 与
  测试矩阵，当轮 Blocker/High/Medium/Low 全部为零并给出无条件 PASS。
- 文档收口复核进一步发现 1 项 Medium：切换 Agent 只撤销页面 authority，旧请求会
  残留并误取消新 Agent 的首个审批；以及 3 项 Low 文档精度问题。`c4610ae` 已在
  `#open` 切换前取消旧审批，并增加“旧请求立即取消、新请求不受影响”的回归测试；
  三处文档措辞也已校正；
- 同一 Kimi session 最终重新读取代码提交与完整文档 diff，独立运行 83 项 Node
  测试、四组 Electron smoke、检查与 Agent A→B 切换对抗脚本；确认旧请求立即
  `cancelled`、新 Agent 首个请求可显示和应答，最终四级问题全零并无条件 PASS。

计划复盘：

- 权限请求仍走 Grok Build 标准 Harness/ACP，Main 仍是唯一审批 authority，没有建立
  第二套 Agent Loop、审批数据库或 Renderer 可伪造的 Session/Option authority；
- 按本文 R0 的既定定义，文本对话、多 Agent、reload/重连恢复、订阅/账号隔离与最小
  Harness 审批边界已经完成开发验证，因此 R0 更新为“已满足（开发验证）”；这不等于
  完整 Harness 或生产就绪，R1-R6 中适用的发布门仍须分别关闭；
- 下一轮按产品计划进入工作区增量的下一项：先只读审计标准 ACP
  `tool_call` / `tool_call_update`，再实现安全、只读的工具活动状态投影；
- 循环 46 非目标是原始 `rawInput`、路径、命令、内容、工具控制、产物、垂直 UI、
  问题/计划审批、Provider、Package 与生产发布。验收必须包含安全枚举、有界投影、
  当前 Session/账号/订阅归属、重连清理、自主测试和 Kimi 四级问题清零。

### 循环 46：标准 ACP Harness 工具活动安全投影

状态：实现、自主验证与本机 Kimi 独立交叉测试已完成

本地功能提交：`6d1dbf1 feat: add safe harness activity projection`

计划校准：

- 循环开始先复核循环 45、产品计划、标准 ACP `tool_call` /
  `tool_call_update` Schema 和 Grok Build replay 实现，确认活动历史继续由 Host
  replay 提供，不增加第二套活动数据库；
- 本轮只把工具类别与四态状态作为只读可观察性投影。上游 Tool Call ID、标题、内容、
  locations、`rawInput`、`rawOutput`、命令、路径和密钥全部留在主进程/Host；
- 本轮不实现工具控制、产物、垂直业务 UI、问题/计划审批、Provider、Package 或
  生产发布。

已经实现：

1. Controller 只接受当前 authority 与当前 Session 的标准工具通知；私有 Tool Call ID
   只用于主进程内合并，Renderer 收到的是本地单调生成的 `activity-N`；
2. 工具类别严格归一为 `read/edit/delete/move/search/execute/fetch/think/switch_mode/
   other`，状态只接受 `pending/in_progress/completed/failed`；终态记录整体冻结，
   后续通知不能回退状态或改写类别；
3. 最近活动最多保留 50 项，淘汰时同时删除私有 ID 映射；Host replay 恢复终态活动，
   未知 ID、非法 ID、未知状态和其他 Session 通知全部忽略；
4. 订阅失效、ready→ready 账号切换、切换 Agent、关闭/重开、Leader 重连、Host
   退出和 Prompt 超时都会清空活动；旧 Session 的迟到通知不能污染新 Agent；
5. Renderer 再次执行本地 ID、类别、状态与 50 项上限白名单，只用本地中文标签渲染
   “最近活动”，不会读取 Controller 即使误传的标题、原始输入或路径字段。

自主验证：

- 失败优先的 Controller 测试在实现前为 19 项中 15 通过、4 失败，失败原因均是活动
  投影尚不存在；实现后定向测试 19/19 通过；
- 最终 `cd desktop && npm test`：85 项中 83 项通过、0 失败，2 项既有真实 Host
  环境门 skip；两项分别验证持久 Leader/Agent 恢复与订阅/账户契约，不生成
  `tool_call`，不能冒充本轮真实 Host 工具活动 E2E；
- `npm run check`、`git diff --check` 通过；
- Conversation、Package、Provider、Visual 四组 Electron smoke 全部退出码 0；
- 本轮没有重建已按用户要求清理的大体积 Rust `target/`。实际 Grok 源码
  `tracker.rs` 已核对标准 ToolCall/ToolCallUpdate 与四态合并，但没有把源码审计写成
  真实工具调用 E2E。

Kimi 独立交叉测试：

- Kimi CLI 可恢复 session `session_818e5746-4cc2-48bc-b0da-9d89384e67cb`，只读审查
  基线 `038795c` 后的完整 diff、Controller authority、Grok/ACP Schema、replay、
  Renderer 双重白名单和测试边界；
- Kimi 独立执行 85 项 Node 测试、语法检查、diff-check，以及 Conversation、
  Package、Provider、Visual 四组 Electron smoke；结果同样为 83 pass、0 fail、
  2 个与本轮无关的真实 Host 环境 skip，四组 smoke 均退出码 0；
- 初始报告把两个既有 real-host skip 误归因为本轮活动投影缺口，核对两个测试的真实
  断言范围后撤销该 Low；没有为归零重建与本轮无关的 54 GiB Rust target；
- 最终确认 Blocker/High/Medium/Low 全部为零并给出 PASS。

计划复盘：

- 活动仍复用标准 Grok Build Harness/ACP 与 Host replay，Main 只做有界安全投影，
  没有建立第二套 Agent Loop、活动持久化或 Renderer authority；
- R0 继续保持“已满足（开发验证）”；只读活动不等于完整 Harness，也没有关闭
  R1-R6、真实工具 E2E、产物/垂直工作区或生产发布；
- 循环 47 只启动“产物与垂直状态 authority 审计”：识别标准 ACP、Grok Session、
  Agent Package 和 Workspace 中哪些对象可成为稳定、可恢复、可脱敏的产品产物来源，
  先形成契约与安全边界，不直接实现 UI；
- 循环 47 非目标是读取或投影 `rawInput/rawOutput/content/locations`、建立第二套产物
  数据库、执行工具、修改 Package/Provider、启用 Registry 或生产发布。只有确认
  Host-owned ID、账户/Session 归属、恢复语义和 Renderer 白名单后，才排最小实现。

### 循环 47：产物与垂直状态 authority 审计

状态：审计与契约已完成，已按顺序进入循环 48 最小实现

计划校准：

- 标准 ACP ToolCall 的 `content/locations/rawInput/rawOutput` 是 Harness 遥测，可能
  包含命令、路径、秘密和中间结果，不能成为稳定产品产物 authority；
- Agent Package 负责 Agent 能力与版本，不应保存每个账户运行时产物；Grok Session
  继续负责对话历史，也不应复制为第二份产物索引；
- 每个持久 Agent 的账户隔离 Workspace 是唯一合理的本地 ownership root，但目录
  扫描不能冒充显式产物索引。

审计结论：

1. 所有当前与未来 Agent 使用同一个
   `.agentmesh360/artifacts-v1.json`，实际文件位于 `artifacts/`；
2. Host 根据当前订阅、账户 Registry 与 `agentId` 解析 Workspace；Renderer 不能
   提交 Session、Workspace、Manifest 或文件路径；
3. Host 逐次验证严格清单与真实文件，只向 Renderer 投影通用安全元数据，不建立第二
   套数据库；
4. 契约、上限、失败关闭、生命周期与非目标已写入
   [`architecture/WORKSPACE_ARTIFACT_MANIFEST_V1.md`](architecture/WORKSPACE_ARTIFACT_MANIFEST_V1.md)；
5. 计划复盘确认最小实现可在不触碰 Provider、Package H2d5 或生产发布的前提下独立
   进入下一循环，因此没有停在“只写文档”的中间状态。

### 循环 48：通用 Workspace Artifact 最小只读实现

状态：实现、自主验证与两轮本机 Kimi 独立交叉测试已完成

已经实现：

1. Rust Host 新增 `x.agentmesh360/agents/artifacts/list`，只接受 `agentId`，从当前
   账户 Registry 取得已激活 Workspace；订阅无效、其他账户或未激活 Agent 均失败；
2. Manifest 限制为 UTF-8 JSON 64 KiB、schema v1、正 revision、最多 100 项，并对
   未知字段、重复 ID/路径/真实文件、标题、类别、安全整数、`artifacts/` 相对路径、
   Workspace/控制目录/中间目录/文件符号链接和最终普通文件逐项失败关闭；
3. Host 输出只有 `schemaVersion/revision` 与
   `artifactId/title/kind/sizeBytes`；Controller 再去除 schema/revision，并在打开
   对话和成功 Prompt 后刷新；
4. 清单不存在返回空索引；清单无效或读取失败不关闭文本对话，只投影
   `unavailable` 语义状态，由 Renderer 显示固定“产物索引暂时不可用。”；订阅、
   账户、Agent、重连、Host、关闭与 Prompt 超时均清空投影，旧账户迟到响应被忽略；
5. Renderer 再执行 ID、标题、类别、大小和 100 项白名单，以通用只读卡片显示文档、
   图片、音频、视频、归档、代码、数据或其他产物，不接收路径、URL、摘要或按钮。

自主验证：

- 失败优先 Node 测试先得到 31 pass / 3 fail，三项分别证明 Host Client、
  Controller 与 Renderer 通路尚不存在；实现后定向 Controller 22/22 通过；
- Rust `workspace_artifacts` 6/6 通过，覆盖空 Manifest、安全投影、严格解析、重复/
  越界路径、同一真实文件别名、符号链接、未激活与跨账户边界；
- `cd desktop && npm test`：89 项中 87 pass、0 fail、2 个真实 Host 默认 skip；
  `npm run check`、`cargo fmt --all --check` 与 `git diff --check` 通过；
- Conversation、Package、Provider、Visual 四组 Electron smoke 全部退出码 0；
- 使用临时 `/tmp/agentmesh360-cycle47-target` 构建真实 Grok Host，
  `real-host.test.js` 与 `real-host-lifecycle.test.js` 2/2 通过，覆盖 Manifest 到
  ACP 安全投影、跨账户拒绝、订阅失效拒绝和三个持久 Agent 恢复；仓库 `target/`
  始终不存在。

计划复盘：

- 循环 47 的“先 authority、后最小实现”顺序得到遵守；循环 48 没有硬编码
  Job/LectureCast/Deploy 类型，也没有把 ToolCall 或路径提升为产品状态；
- 打开、预览、导出、分享、删除、文件 watcher、Agent 专属垂直 UI、Provider、
  Package H2d5 与生产发布仍明确关闭；
- Kimi 四级问题已经清零；下一循环只审计通用项目状态 authority 与恢复语义，不
  直接进入 Agent 专属 UI。

Kimi 独立交叉测试：

- Kimi CLI 可恢复 session `session_27552d78-9fe0-45e4-acfc-a16cebe7a26e`，从基线
  `279004e` 只读审查完整 diff、两个未跟踪文件、Rust/Controller/Renderer
  authority、测试与计划文档；
- 首轮独立执行 88 项 Node、5 项 Rust、显式真实 Host 2 项与四组 Electron smoke，
  Blocker/High/Medium 为零，发现 4 项 Low：同一真实文件可通过路径别名重复、JS
  未覆盖 C1 控制字符、Renderer 依赖 Controller 文案判断错误态，以及账户检查异常
  被产物错误吞并；
- 四项均已修复：Unix 使用 device/inode（其他平台 canonical path）去重文件目标，
  双层 JS 白名单覆盖 C0/C1，快照改为 `ready/unavailable` 语义状态，账户检查失败
  清空并向外传播；新增 hard-link、C1 Controller 与 Electron 回归；
- 第二轮重新读取更新后完整 diff，独立执行 89 项 Node（87 pass、0 fail、2 个默认
  real-host skip）、6 项 Rust、重建后二进制的真实 Host 2/2、四组 Electron smoke、
  fmt/check/diff-check；最终 Blocker/High/Medium/Low 全部为零并给出 PASS。

### 循环 49：通用项目状态 authority 与恢复语义审计

状态：审计与契约已完成，已按顺序进入循环 50 最小实现

计划校准：

- 复核 Agent Package、Registry、Grok Session、Workspace Artifact，以及 Job Agent
  round、LectureCast project、Deploy status/run 的实际状态模型；
- 确认三类 Agent 都已有不同的业务状态与状态枚举，强行把这些原始对象塞进一个客户端
  Schema 会破坏各自 authority，也会让未来 Agent 必须修改客户端；
- 本轮没有直接进入 Agent 专属 UI、任意 JSON blocks、状态 mutation、Provider、
  Package H2d5 或生产发布。

审计结论：

1. Session 继续只负责对话历史，Registry 只负责账户、生命周期、Main Session 与
   Workspace 映射，Artifact Manifest 只负责已形成文件；
2. Job round、LectureCast project、Deploy run/status 等 Agent 自有存储仍是业务
   authority；客户端不能复制或取代它们；
3. 每个账户隔离 Workspace 可以保存一个显式、派生、只读的公共状态 read model：
   `.agentmesh360/project-state-v1.json`；
4. v1 只包含当前焦点项目的标题、四态状态、摘要和最多 20 个四态步骤，不接收路径、
   URL、命令、业务对象 ID、任意 blocks 或 Agent 专属字段；
5. Host 负责订阅、账户、Workspace 和严格 Schema 投影，不背书 Agent 摘要的业务
   真实性；Renderer 只渲染固定字段；
6. 完整 authority、Schema、失败关闭、恢复语义和非目标见
   [`architecture/WORKSPACE_PROJECT_STATE_V1.md`](architecture/WORKSPACE_PROJECT_STATE_V1.md)。

计划复盘：

- 该 read model 允许 Agent 自己的业务 Schema 独立演进，也让未来 Agent 在不添加
  客户端分支的情况下进入公共工作区；
- 需要专属结构或交互时，后续必须通过受签 Agent Package 声明版本化展示契约，不能
  扩张 v1 为 Renderer 可执行的自由格式；
- 循环 50 只实现契约中的通用只读状态卡及恢复边界，并沿用失败优先测试、真实 Host、
  四组 Electron smoke 与 Kimi 四级问题清零门。

### 循环 50：通用 Workspace Project State 最小只读实现

状态：实现、自主验证与本机 Kimi 独立交叉测试已完成

已经实现：

1. Rust Host 新增 `x.agentmesh360/agents/project-state/get`，只接受 `agentId`，从当前
   有效订阅、账户 Registry 与已激活 Agent 解析 Workspace；
2. `.agentmesh360/project-state-v1.json` 限制为 32 KiB、strict schema v1、正的
   JavaScript 安全 revision、固定项目四态与最多 20 个固定步骤四态；未知字段、
   重复/非法 Step ID、空值、超长值和 C0/C1 控制字符全部失败关闭；
3. Manifest 读取在 Unix 使用 `O_NOFOLLOW | O_CLOEXEC`，对打开前后 device/inode
   复核，并执行打开前、打开后和 `MAX+1` 读取三重大小限制；Workspace、控制目录和
   Manifest 符号链接均拒绝；
4. Host 只返回 `title/status/summary/steps[stepId,label,status]`；Main 再移除
   schema/revision 并做同等白名单，Renderer 第三次验证并只渲染固定通用状态卡；
5. 打开对话和成功 Prompt 后刷新；订阅、账户、Agent、关闭、重连、Host 退出和
   Prompt 超时清空，旧账户异步响应不会进入新对话；
6. Manifest 缺失返回 `revision=0, project=null` 且不占 UI；非法或读取失败只显示
   固定“项目状态暂时不可用。”，文本对话继续可用；
7. 当前三个首方 Agent 和动态 `future-agent` 使用同一路径。该 Manifest 仍是 Agent
   自有业务状态的派生 read model，不是第二套业务数据库。

自主验证：

- 失败优先定向测试先得到 35 pass / 4 fail，四项分别证明 Host Client 方法和
  Controller Project State 通路尚不存在；实现后定向 39/39 通过；
- `cd desktop && npm test`：92 项中 90 pass、0 fail、2 个真实 Host 默认 skip；
  `npm run check`、`git diff --check` 与 `cargo fmt --all --check` 通过；
- 新增 Rust `workspace_project_state` 5/5，通过包含 Workspace Artifact 回归的
  `workspace_` 过滤测试 37/37；
- 使用 `/tmp/agentmesh360-cycle47-target` 重建 Host 后，显式真实
  `real-host.test.js` 与 `real-host-lifecycle.test.js` 2/2 通过，覆盖 Project State
  安全投影、跨账户拒绝、订阅失效拒绝和持久 Agent 恢复；
- Conversation、Package、Provider、Visual 四组 Electron smoke 在受限环境统一
  `SIGABRT`，转到真实 macOS 图形会话后全部退出码 0；没有把受限环境失败写成通过；
- 仓库根目录 `target/` 始终不作为自主构建目录。Kimi 首次独立 cargo 命令误建约
  1.4 GiB 忽略缓存后立即中止，并在 `git check-ignore`/`git ls-files` 核对后用
  `cargo clean --target-dir target` 精确清理；最终仓库 `target/` 不存在。

Kimi 独立交叉测试：

- Kimi CLI session `session_5743cc7a-8695-48e9-9bb7-411c6e5ec4a4` 只读审查完整
  diff、两个未跟踪文件、Rust/Registry/ACP/Controller/Renderer authority、契约和
  计划文档；
- Kimi 独立运行 92 项 Node（90 pass、0 fail、2 个默认 real-host skip）和语法/
  fmt/diff 检查，并改用临时 target 完成新 Rust 5/5；
- 同一 session 显式运行重建 Host 的真实测试 2/2，四组 Electron smoke 均退出码
  0，并确认测试脚本的断言失败路径会退出 1、Visual 截图只写 `/tmp`；
- 最终确认 Blocker/High/Medium/Low 全部为零并给出无条件 PASS；默认 skip 没有被
  计为真实 Host 通过。

计划复盘：

- 循环 49 的 authority 决策和 Cycle 50 最小范围得到遵守；没有从聊天、ToolCall
  或目录扫描推断状态，没有添加 Agent 专属字段、状态 mutation 或自由格式 UI；
- 产品工作区现在具备固定主对话、一次性审批、只读活动、项目摘要和产物索引这五个
  公共面；R0 仍只是开发验证，R1-R6 与真实 Provider/生产发布门不变；
- 下一循环只审计蓝图中“任务与后台活动”的稳定 Harness authority、恢复和脱敏
  语义；在确认标准来源前不实现任务控制、后台调度数据库、Agent 专属 UI、Provider、
  Package H2d5 或生产发布。

### 循环 51：Grok Harness 任务与后台活动 authority 审计

状态：审计与中文契约已完成，已按顺序进入循环 52 最小实现

计划校准：

- 复核 Grok Build 的 `BackgroundTaskRegistry`、Session xAI 通知与 replay、冷启动
  orphan reconcile、Scheduler Resources Persistence、标准 ACP Plan/Todo 和
  subagent coordinator；
- 确认普通后台进程、定时任务、模型计划草稿与临时 Worker 是四类不同 authority，
  不能为了做一个“任务”面板而混成单一状态；
- 现有 `x.ai/task/list` 返回原始 `TaskSnapshot`，包含 command、cwd、output、
  output file、signal 等敏感字段，而且要求调用方提交 Session ID，不能直接成为
  Renderer 接口。

审计结论：

1. 普通后台命令和 Monitor 的实时 authority 是当前 Session 的 TerminalBackend；
   `task_backgrounded` / `task_completed` 是唯一适合恢复的事件源；
2. 冷 Session 加载会把只有 backgrounded、没有 completed 的遗留记录补发为
   `signal=session_restart`，但 AgentMesh360 订阅 bootstrap 会提前恢复常驻 Main
   Session，收口通知可能早于对话 Controller 订阅；
3. 因此 v1 必须同时使用 Harness 通知与一个 Host-owned 安全实时快照对账，不能只靠
   replay，也不能在 Renderer 用 PID、命令或日志猜测；
4. Scheduled Task 是未来调度配置，Todo/ACP Plan 是模型协作草稿，Subagent 是临时
   Worker；三者均留待独立契约，不进入 v1；
5. 完整 authority、时序、四态、脱敏、生命周期与非目标见
   [`architecture/HARNESS_BACKGROUND_ACTIVITY_V1.md`](architecture/HARNESS_BACKGROUND_ACTIVITY_V1.md)。

计划复盘：

- v1 只实现普通后台命令与 Monitor 的只读状态，不提供 kill/cancel/restart、日志、
  Scheduler、Todo/Plan、Goal 或 subagent；
- 不建立第二套任务数据库，不修改 Job/LectureCast/Deploy 业务状态，也不进入
  Provider、Package H2d5 或生产发布；
- 审计确认存在可复用的稳定 Harness authority，因此循环 52 才进入最小实现。

### 循环 52：Harness 后台活动安全投影与启动对账

状态：实现、自主验证与本机 Kimi 独立交叉测试已完成

已经实现：

1. Rust Host 新增
   `x.agentmesh360/agents/background-activities/list`，只接受 `agentId`；Host 根据
   当前有效订阅账户 Registry 解析已激活 Agent 的固定 Main Session，再读取实时
   TerminalBackend；
2. Host 最多只向 Main 返回私有 `taskId`、`command|monitor` 与
   `running|completed|failed|stopped`，不返回命令、说明、cwd、输出、日志路径、
   时间、signal、exit code、Session、账户或 Workspace；
3. Controller 接收当前 Main Session 的 `x.ai/task_backgrounded` /
   `x.ai/task_completed` 和 xAI replay，只持有私有 task ID 映射，Renderer 只得到
   本地 `background-N`、类型与四态，最多 50 项且终态冻结；
4. `session/load` 后和成功 Prompt 后执行安全快照对账：快照补齐 Controller 错过的
   live task；replay 中仍为 running、但实时快照不存在的任务收口为 stopped；非
   replay 的并发新任务不会仅因一次快照缺失被误停；
5. 快照异常清空任务并只显示固定“后台活动状态暂时不可用。”，文本对话继续；订阅、
   账户、Agent、关闭、重连、Host 退出和 Prompt 超时全部清空，旧 authority 响应
   不能进入新对话；
6. Renderer 再次执行本地 ID、类型、四态、重复项与 50 项白名单，只渲染固定
   “后台命令/监控任务”和状态文案，不使用 Host 文本。

自主验证：

- 第一组失败优先 Controller 测试为 0/3，三项都因后台投影尚不存在而失败；实现
  通知投影后 3/3 通过；
- 首次真实 Host 冷启动 E2E 为 1 pass / 1 fail：常驻 Session 在 bootstrap 提前
  恢复后，Controller 最终仍看到 running。该失败暴露通知订阅时序缺口，随后增加
  Host-owned 安全快照；对应 Host Client 与 Controller 失败优先测试先分别失败，
  实现后通过；
- 新增并通过 3 项 Rust 安全投影测试，覆盖字段脱敏、四态映射、重复/非法 ID 和
  上限；Workspace Artifact/Project State 回归 `workspace_` 37/37；
- `cd desktop && npm test`：99 项中 96 pass、0 fail、3 个真实 Host 默认 skip；
  三个 skip 已通过显式真实 Host 运行 3/3，不能把默认 skip 冒充执行；
- 最终真实 Host 3/3 覆盖订阅/跨账户/失效门、bootstrap 提前恢复后的遗留任务收口，
  以及 detach、Leader 替换和三个首方 Agent Main Session 恢复；
- `npm run check`、`cargo fmt --all --check`、`git diff --check` 通过；
- Conversation、Package、Provider、Visual 四组 Electron smoke 在真实 macOS
  图形会话全部退出码 0；失败优先阶段受限 Electron 的 `SIGABRT` 没有被写成通过；
- 所有 Rust 构建都使用 `/tmp/agentmesh360-cycle47-target`，仓库根目录 `target/`
  不存在。

Kimi 独立交叉测试：

- Kimi CLI session `session_66414c27-6bb2-4ee6-8040-b6fcae2482fd` 在用户明确授权
  下只读审查相对 `origin/main` 的完整工作区 diff、两个未跟踪文件、相关本地路径、
  Rust/Controller/Renderer/真实 Host 测试和中文计划文档；
- Kimi 独立执行 99 项 Node（96 pass、0 fail、3 个默认 real-host skip）、
  `npm run check`、`cargo fmt --all --check`、`git diff --check`、新增 Rust 3/3 与
  Workspace 回归 37/37；三个默认 skip 与显式真实 Host 3/3 分开记录；
- Conversation、Package、Provider、Visual 四组 Electron smoke 首次误用普通 Node
  均按预期不能启动 Electron；Kimi 改用项目 Electron 二进制后四组均退出码 0，没有
  把错误启动写成测试通过；
- Kimi 核对实际通知方法、`_meta.isReplay`、冷启动 `session_restart` 合成、
  TerminalBackend 快照、当前账户/固定 Main Session authority、竞态与全部生命周期
  清理，并确认 `desktop/src` 没有原始 `x.ai/task/list` 引用；
- 最终 Blocker/High/Medium/Low 全部为零并给出无条件 PASS；测试前后仓库根目录
  `target/` 均不存在，测试未修改工作区文件。

计划复盘：

- 循环 51 的“先区分 authority、再实现普通后台进程最小投影”顺序得到遵守；
- v1 没有硬编码 Agent 类型，没有把 Scheduled Task、Todo/Plan、Goal 或 subagent
  混入，也没有加入任务控制、日志、轮询或第二套持久化；
- R0 仍只是开发验证，R1-R6、外部真实 Provider 和生产发布门不变；
- 本轮 Kimi 已清零；推送后再按蓝图复核工作区剩余项。下一步只在独立契约中评估
  标准 ACP Plan/Todo 是否值得作为 Session 计划视图，不直接实现 Scheduler 控制、
  Agent 专属 UI、Package H2d5 或生产发布。

### 循环 53：ACP Plan/Todo authority 与恢复语义审计

状态：审计与中文契约已完成，已按顺序进入循环 54 最小实现

计划校准：

- 复核 `todo_write`、标准 ACP `SessionUpdate::Plan`、turn-end cleanup、Session
  Resources persistence/reload、旧 `plan.json` 与 Plan Mode；
- 确认 Session Todo、Workspace Project State、Plan Mode、Goal、Scheduler 和
  Subagent 是不同 authority，不建立统一“任务数据库”；
- 本轮没有直接消费 ACP Plan 内容，也没有进入 Todo mutation、Plan Mode 控制、
  Agent 专属页面、Provider、Package H2d5 或生产发布。

审计结论：

1. `todo_write` 的 canonical authority 是当前 Main Session ToolBridge Resources 中
   的 `State<TodoState>`，每次工具完成后保存到 `resources_state.json`，Session
   重建时由 Tool Registry 自动恢复；
2. 标准 ACP Plan 是变化通知而不是 authority：真实 Todo 更新会持久化并 replay，
   但 turn end 还会发不持久化的 cosmetic Plan，把 `in_progress` 临时映射为
   `completed` 而不修改 TodoState；
3. 因此 Renderer 不能直接消费 Plan content/priority/meta，也不能从最后一条 replay
   推断当前状态；live Plan 只作为刷新信号，`session/load` 与成功 Prompt 后必须读取
   Host-owned canonical 快照；
4. 旧 `plan.json` / `PersistenceMsg::PlanState` 是迁移兼容路径，PlanModeTracker
   管理的是模式和审批，两者都不是本视图 authority；
5. 完整数据流、脱敏、恢复、竞态、生命周期和非目标见
   [`architecture/SESSION_PLAN_VIEW_V1.md`](architecture/SESSION_PLAN_VIEW_V1.md)。

计划复盘：

- 该结论保留 Grok Harness 的真实 Resources authority，不复制 Todo 数据库；
- v1 只显示最多 50 项 content 与四态，Todo ID、priority、meta、Session 和路径均
  不进入 Renderer，并明确“模型工作计划不等同于业务进度”；
- 循环 54 只实现 Host-owned 安全快照、Plan 刷新信号与通用只读 UI，继续使用失败
  优先测试、真实 Host、四组 Electron smoke 和 Kimi 四级清零门。

### 循环 54：通用 Session Plan 最小只读实现

状态：实现、自主验证与本机 Kimi 独立交叉测试已完成

已经实现：

1. Rust Host 新增 `x.agentmesh360/agents/session-plan/get`，请求只接受
   `agentId`；Host 根据当前有效订阅账户 Registry 解析已激活 Agent 与固定 Main
   Session，再向 Session actor 读取 ToolBridge Resources 中的 canonical
   `State<TodoState>`；
2. Session actor 在 Harness 内丢弃 Todo ID、priority 和任意 meta，只跨 actor
   传递 content/status；Host 最多投影 50 项、300 个 Unicode 字符/1200 bytes 与
   `pending|in_progress|completed|cancelled`，控制字符、空内容、未知状态和超限数据
   全部失败关闭；
3. Controller 在 `session/load` 后和成功 Prompt 后读取 canonical 快照；live ACP
   Plan 只作为刷新信号，突发信号最多保留一个排队刷新；replay 与 raw Plan
   content/priority/meta 全部忽略，刷新序号和当前 authority 阻止旧响应回写；
4. Renderer 只接收本地 `plan-N`、content 与四态，并执行第二层条数、ID、字符、
   byte、控制字符和状态白名单；界面固定标注“模型工作计划，不等同于业务进度”，
   不可用时只显示固定文案；
5. 订阅、账户、Agent、关闭、重连、Host 退出和 Prompt 超时全部清空计划；非法或
   不可用计划不关闭文本对话；实现没有引入 Todo mutation、Scheduler、Subagent、
   Agent 专属分支、Provider 或 Package 生产能力。

失败优先与自主验证：

- 最初 Host Client/Controller 定向测试 49 项中 44 pass、5 fail；失败全部指向尚
  不存在的 Host Client 方法与 Controller plan 状态，确认测试先于实现；
- 实现后 Host Client/Controller 49/49 通过；增加突发 Plan 合并后 Controller
  37/37 通过，并覆盖 raw live payload 忽略、replay 忽略、canonical 刷新、非法
  C1 数据失败关闭和全部生命周期清理；
- 新增 Rust 安全投影 3/3 通过；Workspace Artifact/Project State 回归 37/37；
- `cd desktop && npm test`：104 项中 101 pass、0 fail、3 个真实 Host 默认 skip；
  三个 skip 已用当前源码重新构建的真实 Host 显式运行 3/3，覆盖订阅/跨账户/失效
  门、detach/Leader 替换，以及从 `resources_state.json` 冷启动恢复 TodoState；
- `npm run check`、`cargo fmt --all --check`、`git diff --check` 通过；
- Conversation、Package、Provider、Visual 四组 Electron smoke 在真实 macOS
  图形会话全部退出码 0；一次在普通 Node 下直接启动 Conversation smoke 的
  `TypeError` 和一次受限图形环境的 `SIGABRT` 均未冒充通过，改用项目 Electron
  与真实图形环境后才记录成功；
- Rust 构建使用 `/tmp/agentmesh360-cycle54-target`，仓库根目录 `target/` 始终
  不存在；最终提交前会删除临时 target。

Kimi 独立交叉测试：

- Kimi CLI session `session_a33d91ed-5503-46d0-88f4-1018f3287abc` 在用户明确授权
  下只读检查相对 `origin/main` 的完整 diff、两个未跟踪文件、中文 authority
  契约、Controller/Renderer/真实 Host 测试，以及 TodoState 注册、Resources
  serde、账户 Registry、Session residency 和 replay 标记支撑源码；
- Kimi 独立执行 104 项 Node（101 pass、0 fail、3 个真实 Host 默认 skip）、
  `npm run check`、Session Plan Rust 3/3、Workspace 回归 37/37、rustfmt 与
  `git diff --check`；随后从当前源码重新构建 Host，显式真实 Host 3/3 通过；
- Conversation、Package、Provider、Visual 四组测试均使用项目 Electron 运行并
  退出码 0；Kimi 确认测试前后仓库根 `target/` 不存在，工作区文件集合未被测试
  改变；
- Kimi 逐项确认 canonical Resources authority、live/replay 边界、账户/Registry/
  Main Session 解析、三层白名单、刷新竞态、生命周期、DOM 脱敏和真实 serde
  fixture；最终 Blocker/High/Medium/Low 全部为零并给出无条件 PASS。本循环正式关闭。

计划复盘：

- 循环 53 先审计再实现的顺序得到遵守；标准 ACP Plan 仍只是刷新信号，canonical
  TodoState 没有复制成第二套数据库；
- Session Plan 与 Workspace Project State 的 UI 和 authority 均保持分离，没有
  把模型草稿冒充 Job round、LectureCast project 或 Deploy run；
- 蓝图中的通用工作区增量已经按顺序覆盖活动、产物、业务状态、后台活动和 Session
  Plan。下一产品步骤回到既定计划中的“凭据依赖的真实 Provider E2E”，但必须等待
  用户提供隔离测试凭据并明确费用授权；在此之前不擅自实现 Scheduler、Subagent、
  Agent 专属 UI、Package H2d5 或生产发布。

### 循环 55：Gemini F0b 真实契约与 thought state 保真

状态：实现、自主验证与本机 Kimi 独立交叉测试已完成

已经实现：

1. 新增只允许 `google.thought_signature` 的类型化 Provider Extension Envelope；
   单值非空、最大 16 KiB，序列化保持原字节，`Debug` 和 SSE 诊断只记录长度；
2. `AssistantItem` 分开持有 message-level 与按 Tool Call ID 索引的 provider state，
   并贯通 stream decode、Conversation、JSONL 持久化、重启加载和 request encode；
3. 对 Google state 执行双门隔离：只允许精确的 Google 官方 HTTPS OpenAI endpoint，
   且历史响应模型必须与当前请求模型完全一致；其他 origin、Provider 或模型的入站/
   出站扩展全部剥离；
4. Streaming 对冲突签名、没有 Tool Call ID 的工具签名和同 ID 不同签名失败关闭；
   未审核字段只可忽略，不能经客户端重新发送；
5. 内置 Catalog revision 升到 2，增加 `google-gemini` /
   `gemini-3.5-flash-lite`；仅把本轮真实测过的 Tools、Structured Output、
   Reasoning、Streaming 标记为 `supported`，Parallel Tool Calls 与 Vision 保持
   `unknown`；
6. 真实契约 Harness 保持双重环境 opt-in 和默认 `#[ignore]`；持久化 Tool Loop
   严格只发两次请求，中间序列化/反序列化整个响应模拟进程重启，第二轮必须精确返回
   `tool-loop-ok`。

真实 Provider 证据：

- 用户明确授权已保存测试 Key、指定 `gemini-3.5-flash-lite`，本轮最多 12 次短请求
  并同意可能消耗免费额度或产生费用；
- 实际共使用 11/12 次：4 次基础 Streaming/Function Calling/Structured Output/
  Reasoning，3 次脱敏 wire 定位，2 次首次持久化 Tool Loop，2 次最终代码复验；
- 真实 SSE 证实工具签名位于
  `delta.tool_calls[].extra_content.google.thought_signature`，最终 assistant
  签名可位于空末尾 chunk 的
  `delta.extra_content.google.thought_signature`；
- 最终两请求 Tool Loop 通过：签名在重启模拟前后保持精确相等，工具结果续轮严格
  返回 `tool-loop-ok`；测试和文档只记录长度，不记录真实值；
- Key 仅从 macOS Keychain 注入测试子进程，没有进入仓库、SQLite、Session、日志或
  测试输出。本轮不会再使用剩余第 12 次请求。

自主验证：

- `xai-grok-sampling-types`：279 pass；`xai-chat-state`：339 pass；
  `xai-grok-sampler`：189 pass；
- AgentMesh360 Shell 定向回归：182 pass、0 fail、1 个与本轮无关的首方源路径测试
  按设计 ignored；Provider 默认零费用契约：3 pass、2 个真实入口 ignored；
- JSONL 新实例恢复、Catalog 定向测试和最终真实 Gemini Tool Loop 均通过；
- `cargo check -p xai-grok-shell --tests`、Rustfmt，以及 sampling types/sampler
  全 targets 与 Shell lib 的 Clippy `-D warnings` 通过；Clippy 首轮指出公开
  `len()` 缺少 `is_empty()`，补齐接口后复验通过；
- 桌面 104 项为 101 pass、0 fail、3 个默认 real-host skip；三个 skip 已用本轮
  源码构建的 Host 显式运行 3/3；`npm run check` 通过；
- Conversation、Package、Provider、Visual 四组真实 Electron smoke 全部退出码 0，
  ready 截图已人工检查；
- Rust 构建全部写入 `/tmp/agentmesh360-cycle55-target`，仓库根目录 `target/`
  始终不存在；真实响应临时文件将在最终提交前删除。

Kimi 独立交叉测试：

- Kimi CLI session `session_839105d3-70b3-4373-943c-8263c12bc8db` 在用户明确授权
  下只读审查相对 `origin/main` 的 31 个修改文件、完整 diff、五份中文文档，以及
  Provider state、Sampler、Session JSONL、Catalog、桌面和真实 Host 测试边界；
- Kimi 独立执行 `git diff --check`、Rustfmt、Types 279、Sampler 189、Chat State
  339、桌面 104 项（101 pass、0 fail、3 个按设计 real-host skip）、`npm run
  check` 与 Conversation/Package/Provider/Visual 四组 Electron smoke，全部通过；
- Kimi 新建的完整 Shell 编译 target 膨胀到 18.8 GiB，使磁盘只剩 562 MiB；主 Agent
  为保护磁盘主动终止该重复编译并清除 122,624 个文件，恢复约 18 GiB。该批次没有
  冒充成功，也不是代码失败；Kimi 随后直接使用本轮主 Agent 已构建的测试二进制，
  独立运行零费用 Provider 契约 3 pass/2 ignored、JSONL restart 1/1 与 Catalog
  4/4，全部通过；
- Kimi 没有把未独立执行的完整 Shell 182 项与 Clippy 写成自己的通过；这两项只由
  主 Agent 自主验证通过并明确分开记录；
- Kimi 唯一 Low 是机械补字段污染了 laziness 测试中的历史结构注释；主 Agent 恢复
  原注释后，同一 session 只读复核关闭；
- 最终 Blocker/High/Medium/Low 全部为零并给出无条件 PASS；Kimi 未读取 Keychain
  或真实 signature 原始文件，未调用真实 Provider，未修改工作区，仓库根
  `target/` 始终不存在。

计划复盘：

- 循环 54 结束后回到“凭据依赖的真实 Provider E2E”，用户授权后才执行，顺序与费用
  边界均得到遵守；
- 没有增加平行 Sampling/Agent Loop、任意 `extra_body`、自动模型发现、自动真实
  Probe、Native/Interactions、Google 内置工具或静默 fallback；
- F0b 已按闭环关闭，但不等于生产发布。R1-R6 仍未满足，下一轮只能形成独立的生产准备/内部
  canary 计划并等待单独授权，不能自动填入生产 Root、endpoint、签名、公证或发布
  配置。

### 循环 56：生产准备与内部 Canary 结构化计划

状态：计划、自主静态验证与本机 Kimi 独立复核已完成

计划校准：

- 循环开始先复核产品蓝图、发布硬门和当前源码，没有沿用 F0b 后的惯性继续加
  Provider、Scheduler、Subagent、Agent 专属 UI 或虚构 H2d5；
- 生产 Root、Publisher Trust Bundle、Trust/Registry endpoint 均继续为空；
  `desktop/package.json` 只有本地 DMG/ZIP 构建，没有仓库自有 Developer ID/公证、
  自动更新或发布工作流；
- 因此本轮只形成计划，不生成 key、不建外部服务、不运行真实 canary、不签名/公证、
  不上传/发布、不调用 Provider、不消耗 credits 或费用。

已经形成：

1. 新增
   [`architecture/PRODUCTION_PREPARATION_AND_INTERNAL_CANARY_PLAN.md`](architecture/PRODUCTION_PREPARATION_AND_INTERNAL_CANARY_PLAN.md)，
   区分 Package、Desktop、Combined 三种 canary；
2. 固定 E0 本地确定性演练、E1 隔离内部 staging、E2 封闭生产候选和 E3 正式生产，
   并用状态机阻止 rehearsal/canary/candidate/released 混写；
3. 给 R1-R6 补齐 authority、进入条件、必须证据、退出判定、停止条件和 rollback；
4. 把 R5 定义为 canary 的退出门，解决“R5 未完成所以无法开始 canary”的循环依赖；
5. 建立订阅/Provider、Package、Desktop/持久 Agent 的 canary 场景矩阵，以及秘密/
   用户内容禁止记录边界；
6. 固定 P0-P8 工作包和明确批准卡：本轮只关闭 P0，下一步仅进入 P1 R6
   Runbook/最小事件 Schema；测试/生产 key、staging、真实 BYOK、Apple 凭据、
   Registry 发布和 cohort 扩大分别需要新的精确授权。

自主验证：

- 五份变更文档的相对链接全部解析到现有文件，新计划的 Markdown fence 成对、无
  Tab 或行尾空白，Mermaid 文本结构检查通过；
- `git diff --check` 通过；`PRODUCTION_TRUST_BUNDLE_URL`、
  `PRODUCTION_REGISTRY_URL`、`EMBEDDED_PUBLISHER_TRUST_BUNDLE` 与内置 Root 继续
  保持空值；
- 仓库根 `target/` 不存在，磁盘仍有约 64 GiB 可用；本轮没有运行 Cargo/npm/
  Electron 构建或测试，没有调用 Provider、读取 Keychain 或使用 credits。

Kimi 独立复核：

- Kimi CLI session `session_858d2a9f-0fcb-4333-93ee-184a41399e9d` 在用户已明确
  授权完整 diff、未跟踪内容和本地路径的边界内，读取新计划、四份同步文档及相关
  Package trust/fetch/release、desktop build、Login Item、shutdown 源码；
- 独立运行 `git status`、完整 diff、`git diff --check`、生产常量/源码定向核对、
  五份文档链接检查，以及新文件空白、Tab 和 fence 检查；
- 确认 H2d0-H2d4 没有被写成上传/发布能力，三种 canary、E0-E3、R5 退出门、
  P0-P8、BYOK/订阅/费用、rollback/撤回/吊销和 secret/content 边界均一致；
- 没有读取 Keychain、调用 Provider、运行构建/测试或创建 `target`；最终
  Blocker/High/Medium/Low 全部为零并给出 PASS。

计划复盘：

- 本轮严格完成原计划中的“先形成生产准备/内部 canary 计划”，没有跳到生产执行；
- P0 现已关闭，R1-R6 仍未满足，rehearsal/canary/production 均未开始；
- 下一轮只进入 P1：R6 事故响应 Runbook、最小非秘密事件 Schema 和证据模板。任何
  测试/生产 key、外部 staging、真实订阅/BYOK 请求、Apple 签名/公证、Registry
  发布或 cohort 扩大继续等待各自精确授权。

### 循环 57：P1 R6 Release Event 与事故响应本地基线

状态：实现、自主验证与本机 Kimi 独立复核已完成；R1-R6 继续未满足

计划校准：

- 本轮开始先复核
  [`architecture/PRODUCTION_PREPARATION_AND_INTERNAL_CANARY_PLAN.md`](architecture/PRODUCTION_PREPARATION_AND_INTERNAL_CANARY_PLAN.md)
  的 P0-P8 固定顺序，只执行 P1；
- 没有修改 Package、Provider 或 Desktop 运行时代码，没有生成测试/生产 key，
  没有建立外部服务、调用 Provider、消耗 credits、签名/公证或运行真实 canary；
- P1 只关闭 R6 的本地 Schema/Runbook/tabletop 子项，不把 E0 文档演练写成 E1/E2
  技术演练，也不把本地验证写成 staging、candidate 或 release。

已经实现：

1. [`architecture/RELEASE_EVENT_SCHEMA_V1.md`](architecture/RELEASE_EVENT_SCHEMA_V1.md)
   与 `schemas/agentmesh360-release-event-v1.schema.json` 定义严格的非秘密
   Release Event v1；
2. `tools/release-evidence/validate-release-evidence.mjs` 提供无依赖 CLI，固定
   1 MiB event/证据单文件、2,000 事件、16 文件与 8 MiB 总量边界；
3. JSONL、01-05 JSON、00/06/07 Markdown 必须绑定同一 Release 身份；重复 JSON
   object key、跨 Release/version、乱序、非法 UTC、非 canonical SemVer、symlink、
   非 UTF-8、未知/缺失/超限文件全部失败关闭；
4. JSON key/value 与 Markdown 扫描 URL、电子邮件、Bearer/Vault/JWT/Provider
   sentinel、PEM、POSIX/Windows 绝对路径；CLI 的 fs 错误不输出绝对路径、内容或
   堆栈；
5. `docs/templates/release-evidence-v1/` 提供默认 `blocked` / `NO_GO` 的九文件模板，
   验证通过只证明结构与已知敏感内容检查，不证明发布证据真实；
6. [`operations/RELEASE_INCIDENT_RESPONSE_RUNBOOK_V1.md`](operations/RELEASE_INCIDENT_RESPONSE_RUNBOOK_V1.md)
   覆盖 Registry 异文、Publisher/Root compromise、最低版本锁死、证据泄漏与
   BYOK/订阅失控；
7. `operations/tabletops/2026-07-28-p1-release-integrity-tabletop.md` 完成一次无
   key、无外部资源的 E0 决策演练，保留真实已发生的 UTC 窗口和两条最小事件。

自主验证：

- `node --test tools/release-evidence/validate-release-evidence.test.mjs`：18/18 通过；
- 两个 MJS `node --check` 通过；
- 完整模板目录和 tabletop JSONL 分别通过 CLI 验证；
- 8 个 JSON/JSONL 可解析，四份 P1 Markdown 相对链接均存在；
- `git diff --check` 通过，仓库根 `target/` 不存在；
- 测试中的 URL、credential、路径与 PEM 仅为 synthetic sentinel，本轮未读取或
  保存真实秘密。

Kimi 独立复核：

- Kimi CLI session `session_0b7c8012-f3fb-4f08-b4d0-d520b79605ec` 只读检查完整
  diff、正式计划、Schema、验证器、测试、模板、Runbook 与 tabletop，并独立执行
  Node/CLI/diff 检查；
- 首轮发现目录未跨文件绑定 Release 身份的 1 Medium，以及 fs 错误路径泄漏、
  路径扫描、JSON key、重复 JSON key、未来 tabletop 时间的 5 Low；
- 全部修复并增加回归后，同一 session 复核 Blocker/High/Medium/Low 全零并 PASS；
  Kimi 没有运行 Cargo/npm/Electron、创建 `target`、读取 Keychain/Provider 或修改
  工作区。

计划复盘与下一轮：

- P1 交付物与原计划完全一致，没有扩展到新 Agent、Provider、Scheduler、Subagent、
  Agent 专属 UI 或生产发布；
- R6 仍需 E1/E2 技术演练、真实观测存储、撤回/吊销/最低版本和官方安装器恢复；
- 下一轮按序进入 P2，但先只实现不生成 key 的 ceremony 工具与清单；临时测试 key
  生成、轮换和吊销演练必须等待精确批准卡，生产 key 另行批准。

### 循环 58：P2 Root/Publisher 无 authority ceremony 预检

状态：实现、自主验证与本机 Kimi 独立复核已完成；P2 实际演练与 R1 继续未满足

计划校准：

- 本轮开始先复核生产准备计划 P2、现有 Root/Publisher Trust、Authoring 与 Registry
  契约，只实现不生成 key 的 ceremony 预检；
- 没有修改 Rust/Package/Provider/Desktop 运行时代码，没有生成、导入、恢复、轮换、
  吊销、签名或销毁任何 key，没有读取 Keychain、建立外部资源、调用 Provider 或
  消耗费用；
- `authority=none`、`not_approved` 与 `blocked` 是机器常量，不接受调用方或模板
  把“继续开发”解释为测试/生产 key 授权。

已经实现：

1. `schemas/agentmesh360-key-ceremony-preflight-v1.schema.json` 与
   `docs/templates/key-ceremony-preflight-v1.json` 固定 E0、Ed25519、无 authority
   预检以及一个 Root/两个 Publisher planned ID；
2. custody 将备份份数、介质、保管角色、恢复窗口和销毁方式逐项固定为
   `requires_approval`，私有材料在仓库、客户端、普通 CI 与 evidence 中全部为
   `false`；
3. 批准卡完整映射生产计划第 8 节，并用
   `releasePackageDesktopVersion=not_applicable_use_ceremony_id` 绑定顶层
   `ceremonyId`；窗口与批准 receipt 继续未提供；
4. 16 个 required scenario 覆盖 Bundle expiry、Publisher/Root 的生成、丢失、
   泄漏、过期、overlap rotation、retire/revoke/emergency revoke 和材料销毁；
5. `tools/key-ceremony/validate-key-ceremony-preflight.mjs` 提供 128 KiB、无依赖、
   路径脱敏的 fail-closed CLI；拒绝 symlink、重复 JSON key、未知/缺失字段、ID
   冲突/乱序、非单调 sequence 和任何 authority/approval/execution 升级；
6. [`operations/KEY_CEREMONY_PREFLIGHT_V1.md`](operations/KEY_CEREMONY_PREFLIGHT_V1.md)
   记录角色分离、custody、sequence、批准卡、未来演练顺序和停止条件，但不包含
   key-generation 命令。

自主验证：

- `node --test tools/key-ceremony/validate-key-ceremony-preflight.test.mjs`：10/10；
- 与 P1 release-evidence 联合回归：28/28；
- 两个 P2 MJS `node --check`、默认模板 CLI 验证与 `git diff --check` 全部通过；
- 新增 `pins every R1 rehearsal and unresolved approval dimension` 回归，直接钉住
  R1 场景、批准卡版本映射和五个 custody 待批准维度；
- 仓库根 `target/` 不存在；测试只使用 synthetic sentinel，不含真实 key material。

Kimi 独立复核：

- Kimi CLI session `session_987108f4-dbd2-4252-aa62-aa8c6876afa4` 只读检查完整五文件
  diff、正式计划、Root/Publisher/Authoring/Registry 契约，并独立执行 Node、CLI 和
  diff 检查；
- 首轮发现机器场景缺 Root rotation/compromise 与 Bundle expiry 的 1 Medium、
  批准卡版本映射与 custody 机器表达不完整的 2 Low；
- 全部修复并增加回归后，同一 session 复核 28/28 通过，最终
  Blocker/High/Medium/Low 全部为零并 PASS；
- 同步 Cycle 58 五份状态文档后，同一 session 第三轮只读复核最终 10 文件 diff，
  独立复跑 P2 10/10、联合 28/28、链接/fence/JSON、生产关闭常量与根 `target/`
  检查，仍为四级全零并 PASS；
- Kimi 未编辑文件、运行 Cargo/npm/Electron、创建 `target`、读取 Keychain/
  Provider、调用外部服务或执行 key 操作。

计划复盘与下一轮：

- 本轮交付物与 P2“ceremony 工具/清单设计”一致，没有扩展到 P3、外部服务、真实
  canary、生产 key 或桌面发布；
- P2 整体仍未完成，R1 仍未满足；模板验证通过只表示安全阻断结构成立；
- 下一步必须先取得正式计划第 8 节的测试 key ceremony 精确批准卡，才可执行 P2 E0
  生成、轮换、丢失、泄漏、过期、吊销、恢复和销毁演练；生产 key 另行批准。

### 循环 59：P2 E0 测试 Root/Publisher 技术演练

状态：实际执行、私钥销毁、自主验证与本机 Kimi 两轮独立 gate 已完成并四级清零

计划校准：

- 本轮开始先复核生产准备计划 P2、Cycle 58 preflight、现有 Rust Root/Publisher
  Trust canonical payload、sequence、状态与异文拒绝契约；
- 用户精确批准只允许本机隔离临时目录中的一个初始 Root、两个 Publisher，以及
  Root rotation 所需的 transient successor Root；不包含任何生产 key、外部服务、
  Provider、credits、费用、E1/E2 或 canary；
- P2 材料必须在同一窗口销毁并恢复空 Trust；P3-P8 不因本轮批准自动开放。

已经实现：

1. `schemas/agentmesh360-key-ceremony-receipt-v1.schema.json` 固定 E0/test_keys、
   approved receipt、四份角色化 inventory、sequence 1-5、16 个场景、六个失败检查、
   清理证明与 `productionR1Closed=false`；
2. `tools/key-ceremony/e0-key-worker.mjs` 在短生命周期子进程中生成、读取、签名、
   备份、恢复和销毁 PKCS#8 私钥；target 只允许 ceremony 临时目录内的 `.pk8`；
3. `tools/key-ceremony/run-e0-key-ceremony.mjs` 复用 Rust 当前的 Ed25519 canonical
   Trust payload，验证 A/B overlap、retire/revoke、Root 接棒、rollback、异文、
   unknown Root 和 expiry；
4. `tools/key-ceremony/validate-key-ceremony-receipt.mjs` 拒绝 symlink、duplicate JSON
   key、unknown field、私钥/公钥/签名原文、绝对路径、个人身份和不完整清理；
5. 非秘密 receipt 与中文报告保存在
   `docs/operations/tabletops/2026-07-28-p2-key-ceremony-e0.{json,md}`；
6. worker 对材料执行覆盖、fsync、unlink，runner 删除并确认整个临时目录不存在；
   receipt 明确不保证 APFS/SSD forensic secure erase。
7. Kimi 首轮后补齐 worker realpath/symlink-parent 遏制与无破坏负测试、全类 PEM
   marker、Rust 码元序、严格 UTC 毫秒时间、Ed25519 压缩点校验、bare 64-hex
   拒绝和逐 checkpoint 场景登记；
8. receipt 明确 `digestInputsIndependentlyVerifiable=false` 与
   `scenarioOccurrenceStandaloneProof=false`，避免把 runner attestation 写成
   standalone 密码学证明。

实际执行：

- 第一次 runner 启动在生成任何 key 前，被仓库扫描器对自身 PEM marker 字面量的
  自指误报阻断；没有临时目录、receipt 或测试 key；
- marker 改为非自指构造并增加回归后，receipt/runner 13/13 与 preflight 10/10
  通过，且确认不存在遗留 ceremony 临时目录；
- 实际 ceremony 生成一个初始 Root、Publisher A/B 和一个 transient successor
  Root；完成 Publisher/Root 备份、删除、恢复、重新签名与独立验签；
- sequence 1-5、16 个正向场景和六个失败关闭检查全部通过；
- 四份私钥及备份在 receipt 写入前销毁，临时目录消失、Trust 恢复为空；
- receipt validator、retention 扫描与三个生产关闭常量复核通过；没有外部请求、
  credits 或费用。

自主验证：

- receipt/runner 测试：13/13；
- preflight 回归：10/10；
- 实际 receipt CLI 验证：valid and retention-safe；
- ceremony 临时目录计数为零；保留证据没有 PEM/private key、公钥/签名原文、个人
  身份或绝对路径；
- `EMBEDDED_PUBLISHER_TRUST_BUNDLE`、`PRODUCTION_TRUST_BUNDLE_URL` 与
  `PRODUCTION_REGISTRY_URL` 保持 `None`；
- P1 release-evidence 18/18，联合回归 41/41；
- receipt/preflight CLI、Node check、JSON、Markdown link/fence、`git diff --check`、
  生产 `None` 常量、临时目录、根 `target/` 与泄漏扫描全部通过。

Kimi 独立复核：

- Kimi CLI session `session_e8117ef9-14a9-4879-bb86-58fdf529830d` 只读检查完整
  diff、未跟踪文件、Rust Trust/Cache 契约、receipt 和全部同步文档；没有修改文件、
  执行 ceremony/key worker 成功动作、生成/读取 key、访问 Keychain/Provider、
  运行 Cargo/npm/Electron 或创建根 `target/`；
- 首轮自主运行 receipt 10/10 与 preflight 10/10 后报告 3 Medium / 4 Low：
  worker 中间 symlink/无负测试、hex digest 不可审计、场景结果自证，以及 PEM 类型、
  locale 排序、宽松时间与 Ed25519 点校验；
- 主 Agent 没有豁免或降级，逐项补齐 realpath 与无破坏 sentinel 测试、typed
  `sha256:` 与 bare-hex 拒绝、机器可读 review limitations、checkpoint binding、
  全 PEM regex、码元序、严格 UTC 和 RFC 8032 压缩点验证；
- 同一 Kimi session 第二轮独立复跑联合 41/41、receipt/preflight CLI、JSON、
  link/fence、diff、生产 `None` 常量、临时目录、根 `target/`、PEM/路径泄漏和
  Ed25519 public-only 探针，最终 Blocker/High/Medium/Low 全部为零并 PASS。

计划复盘与下一轮：

- 实际交付严格停在 P2 E0，没有修改 Rust/Desktop/Provider/Package 生产运行时，
  没有配置 endpoint、上传、发布、签名、公证或 canary；
- 本轮只能关闭 P2 E0 测试密钥技术子项，不能关闭生产 R1；本机 role alias 与 Kimi
  也不能替代生产双人 custody ceremony；
- 测试私钥已经销毁，P3 不得复用；
- 下一步按正式计划只能进入 P3 R2 E0；若需生成新的测试 Publisher 或外部测试签名，
  必须先取得匹配 P3 范围的精确 authority，P4-P8 继续关闭。

### 循环 60：P3 R2 零新 key provenance preflight

状态：零新 key preflight 已完成自主验证与本机 Kimi 四级清零；P3 实际执行仍关闭

计划校准：

- 先复核正式计划 R2 进入门、H2d0-H2d4 Authoring/Release 工具与历史构建证据；
- 历史首方双构建只证明当时源码和测试 key，不能替代当前 commit/toolchain/lock
  provenance；P2 key 已销毁，不能复用；
- 本轮只表达 P3 的 `rehearsal_ready` 前置结构，不运行 Cargo、不生成 key、不签名、
  不构造或发布 Registry，也不创建仓库根 `target/`。

已经实现：

1. `schemas/agentmesh360-release-provenance-preflight-v1.schema.json` 固定
   `e0/p3_r2/authority=none/not_approved/blocked`；
2. source freeze 要求未来执行记录 clean commit、`Cargo.lock` typed SHA-256、
   Rust toolchain，并逐项绑定 Rust 实现的 11 个数值 Schema version 与 2 个
   canonical payload ID，不使用不存在的聚合 Schema 名称；
3. 执行角色固定为相互分离的 `build_operator`、`test_signer_operator` 与
   `independent_reviewer` 非个人 alias；
4. build plan 固定两个仓库外隔离 root、逐字节一致、根 `target/` 禁止与十类 R2
   output；
5. Agent matrix 固定 Deploy、Job、LectureCast 与既有 H2d1
   `future-agent / com.agentmesh360.future-agent / 1.0.0` fixture，验证零 Adapter
   和动态 Agent 都不依赖 Catalog 特判；
6. signing boundary 固定 Ed25519、authority none、P2 material 不可复用、
   production key 禁止，以及 Repository/Builder/evidence 私钥全部为 false；
7. approval card 明确实际 P3 需要新的 test Publisher、signer mode/存储/销毁、
   source/version、窗口、零 Provider/requests/credits/费用和 rollback；
8. 无依赖 validator 拒绝 duplicate JSON key、symlink、非 UTF-8、超限、未知字段、
   agent/output 漂移和任何 authority/approval/execution/freeze/signing 升级；
9. [`operations/RELEASE_PROVENANCE_PREFLIGHT_V1.md`](operations/RELEASE_PROVENANCE_PREFLIGHT_V1.md)
   记录历史证据不能复用、矩阵、输出、批准卡、停止条件与证据边界。

自主验证：

- P3 preflight 定向 Node：12/12；
- 默认模板 CLI、Node check、Schema/template JSON 与 `git diff --check` 通过；
- 没有运行 Cargo/npm/Electron、创建 build root/根 `target`、生成/读取 key、签名、
  finalize、构造候选 Registry、访问外部服务或产生费用；
- P1/P2/P3 Node 联合回归：53/53。

Kimi 独立复核：

- 使用同一 session `session_a09010bf-4411-4301-90bd-384fcc017310` 完成两轮
  read-only 审查；
- 第一轮发现 1 个 Medium、2 个 Low：不存在/错误的聚合 Schema 名称、动态 Agent
  fixture ID 漂移，以及缺少 executor role；
- 修复后第二轮逐项核对 11 个 Rust 数值 Schema version、2 个 canonical payload
  ID、四组 Agent/package/version 与三类执行 role；
- 独立复跑 53/53、P3/P2 CLI、Node check、JSON、link/fence、diff、根 `target/`、
  生产 `None` 常量，以及 10 类 authority/contract/identity/symlink 负向输入；
- 最终 Blocker/High/Medium/Low 全部为 0，结论 PASS。

计划复盘与下一轮：

- 本轮严格停在 P3 no-authority preflight，没有把 H2d0 历史摘要写成当前 provenance，
  也没有把模板 PASS 写成双构建或 R2 完成；
- 本轮只关闭 P3 no-authority preflight，不关闭 R2；
- 下一步必须等待新的精确 test-signing authority，才能生成一个新 E0 测试
  Publisher、执行固定 commit 双构建与测试签名；没有该批准时 P4-P8 和生产发布
  继续关闭。

### 循环 61：P3 R2 E0 离线 Release 装配执行器与证据 runner

状态：已完成获批的 P3 R2 E0 技术演练、销毁、非秘密证据与加强自主复核；生产
R2 与 P4-P8 继续关闭

计划校准：

- 用户批准的候选仍固定为
  `e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c`，四 Agent、一个临时测试
  Publisher、双构建与十类 provenance 输出不变；
- 复核发现该 commit 的公开 CLI 只有 `build` 与 `finalize`，H2d1 Host bundle、
  H2d2 Release Manifest 和 H2d3 Registry record 只在 crate 内部测试通路可组装；
- 若直接复用测试 helper，会带入硬编码测试 key，并违反“本轮只生成一个新测试
  Publisher”的批准边界。因此先增加正式但仅离线的无私钥装配命令；它作为单独
  executor commit/digest 记录，不改写候选源码 commit。

已经实现：

1. `agentmesh360-package-author assemble-release` 只接收 Artifact、signing request/
   result、公开 Publisher key 与 Host projection，不接收或保存私钥；
2. 装配器复用 H2d0 finalize，再经临时内存 Trust 完成 H1 复验，随后输出 H2d1
   Host bundles、H2d2 Release Manifest、H2d3 未发布 Registry record 和非秘密
   finalize receipt；
3. public key 必须是 canonical Ed25519 原始公钥；Registry URL 只接受 HTTPS；
   输出目录必须是新目录，任一步失败都删除完整输出，成功后删除验证 staging；
4. 新增与既有 H2d1 动态 Agent 一致的 `future-agent` 文件 fixture，供正式双构建
   使用，而不依赖 Catalog 特判；
5. 新增隔离 signer worker 的 `generate/sign/destroy` 协议。worker 只允许直接位于
   `/tmp/agentmesh360-release-provenance-e0-*` 的边界目录、私钥权限 `0600`，
   evidence 不保留公钥/签名原文；当前尚未调用 `generate`；
6. Kimi 首轮审查识别 signer 在 `lstat` 后 `readFile/open` 的 TOCTOU Low；现改为
   `O_NOFOLLOW` 打开后用 `fstat` 校验 regular file、`0600` 和 4 KiB 上限；
7. 新增不生成 key 的 worker 负向测试，并由此发现 macOS `/var` 到
   `/private/var` 的 canonical alias 会误拒合法 target；现改为先解析 target
   parent 的 `realpath` 再与 canonical boundary 比较；
8. 新增 strict Release provenance receipt Schema/validator，固定一个测试
   Publisher、四个 source input、四 Agent、每项十类逐字节一致、销毁/空 Trust/
   未发布边界，并拒绝 raw key/signature、绝对路径、原始命令和 bare digest；
9. 新增 fail-closed E0 runner：显式 ack 后仍先固定 candidate/executor/source
   commits、clean tree、`Cargo.lock`、空生产常量与根 `target/`；A/B Cargo target
   顺序构建并各自删除，两个执行器先完成四 Agent 的 Artifact/signing request/
   Host projection 比较，全部通过后才有唯一一次 `generate`；
10. runner 只签署八个已比较 request，分别走 finalize/H1/H2d1-H2d3，再比较十类
    输出；任何异常都停止、销毁已尝试生成的 Publisher、移除 detached worktree 与
    完整临时 boundary，失败时不写 PASS receipt；
11. 加强自主复核发现 Deploy 源仓库 clean HEAD 从已冻结 `781599f...` 前进到
    `d92cc44...`，差异只涉及同仓库 CreatorCut RC11 文件，Deploy 打包输入
    `AGENTS.md` 未变；runner 不改写基线，而是让三个首方 Agent 都从各自冻结 commit
    建立临时 detached source worktree，避免并发产品开发污染 provenance。

自主验证：

- `package_release_authoring::tests` 2/2；
- `agentmesh360-package-author` CLI parser 1/1；
- Agent Package 模块回归 80 通过、0 失败、1 个需要真实外部源码路径的既有测试
  保持显式 ignored；
- `cargo fmt --all -- --check`、目标 binary/library 的
  `cargo clippy --offline --locked ... -D warnings`、Node syntax 和
  `git diff --check` 通过；
- signer worker 的 symlink、permissive/oversized file 与 absent destroy 负向测试
  3/3；这些测试只使用伪字节，不生成或读取任何真实 key；
- P3 preflight、receipt/runner 与 signer worker 联合 Node 25/25；receipt CLI、
  三个 Node syntax、Schema JSON、diff check 通过；
- 已删除 14 GiB 的仓库外开发 target，磁盘可用空间由约 39 GiB 恢复到约
  53 GiB；正式 runner 保证两个大型 Cargo target 不同时驻留；
- 所有 Cargo 输出均位于仓库外临时 target；仓库根 `target/` 未创建；未生成 key、
  未签名、未调用 Provider/外部服务，也未产生 credits 或费用。

加强自主复核：

- 全量 staged diff 覆盖 21 个文件；逐项核对 private-key CLI boundary、ephemeral
  Trust、H1/H2d1-H2d3 binding、失败清理、receipt retention、唯一 `generate` 与
  finally destroy；
- 新增内容的 private PEM/API key/个人本机路径扫描为零，生产 Trust/Registry 三个
  `None` 常量保持为空；
- 自主复核先后发现并修复 macOS temp canonical alias、signer TOCTOU 和首方 source
  HEAD 漂移；修复后 Node 25/25、fmt、Schema/CLI/syntax/diff/root-target 检查通过；
- 当前自主结论 Blocker/High/Medium/Low 均为 0。该结论是用户在 Kimi 额度恢复前
  明确指定的临时复核方式，不冒充 Kimi 独立 PASS。

首次正式执行尝试：

- executor checkpoint `fd71b3a...` 已提交并推送；runner 完成两个顺序隔离 Cargo
  build 后，在首个 `deploy-agent` Package build 返回失败；
- 失败发生在任何 `generate` 之前，因此本轮累计生成测试 Publisher 数仍为 0；
- fail-closed cleanup 已确认：临时 boundary 0、成功 receipt 不存在、根
  `target/` 不存在、candidate 与三个 source worktree 均已移除、磁盘空间恢复；
- 自主复核发现 1 个新的 Low：命令失败只保留固定 label，过度脱敏导致无法诊断。
  现改为只保留 stderr 最后一条、路径替换为 `<path>`、最长 320 字符；对应负向测试
  加入后 Node 联合回归 26/26；
- 在诊断修复重新提交并冻结前不重跑；异常执行没有被写成 P3 PASS。

第二次正式执行尝试：

- bounded diagnostic 生效，两个 Cargo build 后再次在首个 Deploy Package build
  fail-close，明确显示 Clap `try --help`；同样发生于 `generate` 前，累计 key
  生成数仍为 0，boundary/worktree/build root/receipt 清理复验通过；
- 根因是 runner 使用了旧文档式 `--definition-dir/--source-root`，真实
  `agentmesh360-package-author build` CLI 合约为 `--definition/--source`；
- 自主定级为 1 Medium：runner 与真实 CLI parser 的参数合约缺少直接回归。现修正
  参数并导出纯函数断言完整 argv，Node 联合测试更新为 27/27；
- 修复 commit 再次冻结前不启动下一次执行。

计划复盘与下一轮：

- 本轮已关闭 P3 R2 E0 技术演练，但不关闭生产 R2；
- 本机 Kimi 首轮已提出 1 个 Low 并已修复；其额度恢复后继续沿用 Kimi 交叉门禁；
- Kimi 修复复核当前被其账户周期额度 403 阻断；本机只配置
  `managed:kimi-code`，没有可用的第二个零费用 Kimi provider；用户随后明确决定，
  在 Kimi 额度恢复并另行通知前，由主 Agent 通过完整 diff 审计、负向测试与执行
  前后证据核对承担加强自主复核，不再尝试调用 Kimi 或购买额度；
- 该临时复核调整不改变 P3 authority、候选 commit、一个 Publisher、异常停止、
  销毁、零 Provider/credits/费用和非秘密 evidence 边界；
- Deploy 的新 HEAD 不自动进入 P3；执行仍使用最初冻结的 `781599f...`，Job 与
  LectureCast 分别使用 `ed8f1c6...` 和 `688dd61...`，三个 source worktree 都在
  receipt 前移除；
- 成功执行从 clean detached `e1ef8db...` 读取候选输入；四 Agent 的 A/B 构建、
  生成 key 前比较全部通过后，worker 唯一一次生成临时测试 Publisher；
- 下一轮按序只评估 P4 R3 E1 的设计、外部资源、凭据和清理 authority；在得到新的
  精确批准前不创建隔离 origin、对象存储、Registry 或 staging 凭据；
- P4-P8、生产 key、外部资源、Provider、credits、费用与发布继续关闭。

最终正式执行与证据：

- executor 提交顺序为 `fd71b3a...`、`9ef6f25...`、`5d97f0b...`；前两次分别暴露
  bounded diagnostic 缺失和 Build CLI argv 合约错误，均在 `generate` 前
  fail-close、完整清理且未写 PASS receipt；
- 最终 executor `5d97f0bf4c48de6e2ac40a3ed4066b5455361294` 成功完成四 Agent
  A/B 双构建；每个 Agent 的十类输出均 10/10 逐字节一致；
- 全窗口仅生成一个测试 Publisher，共执行 8 次签名和 8 次复验；私钥已销毁，
  `privateFilesRemaining=0`，Trust 恢复为空；
- 两个 build root、一个 candidate worktree、三个 source worktree 与完整临时
  boundary 均已移除；仓库根 `target/` 仍不存在，生产常量仍为空；
- receipt validator 与 release-provenance Node 回归 27/27 通过；秘密/签名原文/
  绝对路径扫描为零；
- 非秘密证据见
  [`operations/tabletops/2026-07-28-p3-release-provenance-e0.md`](operations/tabletops/2026-07-28-p3-release-provenance-e0.md)
  与对应 JSON receipt；
- 本轮最终复核遵循用户最新要求，不调用额度已用尽的 Kimi；由主 Agent 完成完整
  diff、负向测试、receipt 对账、秘密扫描与清理复验，不冒充 Kimi PASS。

### 循环 62：P4 R3 E1 零外部资源分发服务 preflight

状态：no-authority preflight 已实现并通过加强自主复核；E1 外部资源、Trust、
Release Set、上传和故障注入仍未获批、未执行

计划校准：

- 严格按 P0-P8 顺序进入 P4，不跳到 Package canary、桌面分发或生产启用；
- P3 只保留非秘密 receipt，Artifact、Envelope、Host bundles、Release Manifest
  与 Registry candidate 已随临时边界删除，P3 测试 Publisher 也已销毁；
- 因此 P4 不能把 P3 digest 当成可上传文件，也不能复用 P2/P3 私钥；未来 E1 必须
  独立批准并重建新的 staging Release Set 与非生产 Trust；
- 本轮只允许本机静态 Schema、blocked 模板、validator、测试和文档，不创建
  origin、DNS/TLS、对象存储、Registry、账号或凭据，不发网络请求。

已经实现：

1. 新增 strict P4 preflight Schema 与默认 blocked 模板，固定
   `environment=e1`、`workPackage=p4_r3`、`authority=none`、
   `approvalStatus=not_approved`、`executionStatus=blocked`；
2. 绑定 P3 rehearsal ID、receipt typed digest、candidate/executor commit，同时
   固定 `productionR2Closed=false`、`p3ArtifactsRetained=false` 和
   `e1ReleaseSet=requires_approval`；
3. 固定 P2/P3 私钥不可复用、production key 禁止、staging Root/Publisher/Client
   Trust 注入均需新批准，且生产 Trust/Registry 常量不可修改；
4. 直接对照 Rust 消费者固定 HTTPS 精确 origin、禁止 redirect 和
   credentials/query/fragment、trusted server time、五类响应大小、四种 Artifact
   MIME 与 metadata/artifact timeout；
5. 固定 Artifact、Envelope、Host bundles、Host projection、Release Manifest
   的不可变命名、上传 receipt、回读摘要核对和 Registry 最后原子发布；
6. 固定 14 项 R3 故障矩阵：404、timeout、截断、超限、错误 MIME、redirect、
   digest/signature mismatch、过期 metadata、rollback、same-revision
   equivocation、有效/无效 LKG 与半发布不可发现；
7. 固定撤回不删除用户本地数据、不允许未签名 fallback，以及日志/evidence 不记录
   账号、BYOK、Prompt、响应、凭据、endpoint URL、原始 Trust/Registry 或本机路径；
8. 中文 Runbook 给出未来批准卡、停止条件、发布顺序和清理边界。

自主验证与加强复核：

- P4 template CLI validator 通过；
- P4 定向 Node 17/17；覆盖 strict Schema、P3 receipt 字节摘要与 handoff、真实
  Rust 常量、authority/
  resource/trust escalation、consumer drift、mutable overwrite、Registry 提前发布、
  故障矩阵遗漏、LKG、日志/evidence、symlink、duplicate key、UTF-8、size 与 CLI
  路径脱敏；
- Node syntax、Schema/template JSON parse 与 `git diff --check` 通过；
- 首轮自主复核发现 Artifact MIME 漏记 `application/x-zstd`，以及过期远端
  metadata 的 LKG 预期表述错误；最终审计又补充真实 P3 receipt 字节摘要与
  candidate/executor commit 绑定，修正后复跑 17/17；
- Kimi 仍按用户要求暂停，本轮结论来自完整 diff、源码契约对照与负向测试，不冒充
  Kimi 独立 PASS。

计划复盘与下一轮：

- 本轮只关闭 P4 no-authority preflight，不关闭 E1 演练或生产 R3；
- 真实 P4 前必须取得精确批准：新的 E1 Release Set、非生产 Root/Publisher 与
  Client Trust 注入、隔离 origin/DNS/TLS/对象存储/Registry、最小凭据、网络请求
  上限、执行窗口、abort owner、撤回/清理目标和 evidence retention；
- 继续保持生产 Trust/Registry 常量为空；P5-P8、Provider、credits、费用、Apple
  凭据与任何对外发布均不在本轮范围。

### 循环 63：P4 R3 E1 精确执行授权与预算门禁

状态：授权门禁已完成并通过加强自主复核；付费资源、E1 Trust、Release Set、上传、
故障矩阵和清理尚未执行，生产 R3 继续关闭

计划校准：

- 用户精确批准 72 小时执行窗口、预计 `1.15 USD`、硬上限 `3.00 USD`，允许复用
  DigitalOcean 账号、SGP1 区域与部署能力；
- 仍禁止复用现有生产 Droplet 或其他产品 staging；不授权生产 key、生产 Trust/
  Registry 常量、Provider、credits、P5-P8 或窗口自动延长；
- 先冻结机器可校验的授权与执行器 commit，再创建付费资源；任何执行漂移都在云端
  mutation 前 fail-close。

已经实现：

1. 新增 strict P4 E1 authorization Schema 和留存安全 JSON receipt；
2. 固定 72 小时窗口、`0.00893 USD/hour` Droplet、`5 USD/month` Spaces 和
   `1.14296 USD` 模型成本，预计值与 `3 USD` 硬上限不可漂移；
3. 固定一个 SGP1 `s-1vcpu-1gb` Droplet、两个无 CDN Spaces bucket、Cloudflare
   staging DNS、隔离 Caddy origin 和最多五项外部资源；
4. 绑定真实 P3 receipt 字节摘要、冻结候选、Deploy/Future/Job/Lecturecast 四
   Agent 版本与新 E1 A/B 双构建；
5. 固定一个本机临时非生产 Root 和 Publisher、P2/P3/生产 key 禁止、云端私钥
   禁止、E1 test-only Trust 注入与结束后生产空 Trust 复验；
6. 固定 500 个外部网络请求上限、零 Provider 推理、零 credits、无备份/快照/CDN；
7. validator 支持 strict local `$ref` 合并并拒绝未知字段、duplicate key、symlink、
   超限文件、预算/窗口/资源/生产复用漂移，以及 URL、IP、本机路径和私钥进入 receipt；
8. 中文授权记录明确最小凭据、不可变上传/回读、Trust-before-Registry、Registry
   last、14 项故障矩阵和先撤回后销毁。

只读基础设施核验：

- DigitalOcean 账号 active、Droplet quota 足够、SGP1 可用目标 1 GiB 规格；
- 现有 AgentMesh 生产、其他生产和其他产品 staging Droplet 均只读识别并排除；
- 当前 Spaces key API 控制面返回不可用状态，不能据此伪造凭据完成；外部执行时需
  使用已登录控制台完成相同的 bucket-scoped 最小权限，授权范围不扩大；
- 尚未创建或计费任何 E1 资源，当前新增成本为 `0 USD`。

自主验证：

- authorization Node 13/13；
- authorization CLI、实际 P3 receipt digest、精确 72 小时/预算公式和留存安全通过；
- Kimi 按用户要求继续暂停，本轮由主 Agent 完成 Schema/receipt/validator/test
  完整 diff、负向输入与计划一致性复核，不冒充 Kimi PASS。

计划复盘与下一轮：

- 当前只关闭 `approval_missing`，不关闭 E1 或生产 R3；
- 下一步严格按 P4 顺序：冻结推送执行器 commit，创建隔离资源和最小凭据，重建并
  签署四 Agent Release Set，执行上传回读与 14 项故障矩阵，随后完整销毁和留证；
- 任一项遇到预算、登录、权限、对象不可变、Trust、Registry、故障矩阵或清理漂移，
  必须停止并先清理，不跳到 P5。

### 循环 64：P4 R3 E1 Spaces 与最小权限基础设施

状态：E1 执行中；两个隔离 Spaces bucket 与两组最小权限 key 已创建并通过 S3
访问探针，Droplet/DNS/origin/Release Set/故障矩阵/最终销毁仍待按序完成

计划校准：

- 所有付费 mutation 均发生在 Cycle 63 授权执行器 commit `635b87b` 推送后；
- DigitalOcean 控制台恢复登录，Spaces UI 明确支持 bucket-scoped limited key；
- 继续不改生产 Droplet、其他 staging、生产 Trust/Registry 常量，不调用 Provider
  或 credits。

已经实现和执行：

1. 在 SGP1 创建两个 Standard Storage bucket，分别承载不可变 Release 对象和
   Trust/Registry metadata，CDN 均关闭；
2. Spaces subscription 页面显示约 `0.007 USD/hour`，两个 bucket 共享 subscription，
   72 小时约 `0.50 USD`，仍在 `1.15/3 USD` 预算边界；
3. 创建一个仅限两个 E1 bucket 的 Read/Write/Delete Publisher key，以及一个仅限
   同两 bucket 的 Read-only Origin Reader key；
4. 初次 Reader key 返回 `SignatureDoesNotMatch`，立即永久撤销并重建；未扩大权限，
   active key 保持两组；
5. 实际探针验证 Publisher PUT/GET、Reader GET、Reader PUT 被 403 拒绝和 Publisher
   DELETE，退出状态 0 且 probe object removed；
6. 新增无依赖 S3 SigV4 client，固定 SGP1/批准 bucket 命名、canonical path/query、
   payload digest、手动 redirect、15 秒 timeout 和 secret-safe error；
7. 凭据文件必须 bounded regular non-symlink mode `0600`，Publisher/Reader access
   ID 必须不同；secret 不进入仓库、命令参数或 evidence；
8. 新增 fail-closed Droplet boundary runner：本机临时 SSH key、固定 cloud-init、
   22/80/443 UFW、1 GiB SGP1/无 backup/monitoring、executor clean commit、
   pre/post create 复验、pending cleanup state 与销毁时私钥清除。

自主验证：

- Spaces client 6/6；
- Droplet boundary 6/6；
- authorization 13/13；
- 联合定向 25/25、Node syntax、diff check 通过；
- Kimi 按用户要求继续暂停，由主 Agent 对 credential scope、SigV4、失败 key
  撤销、probe cleanup 和 Droplet fail-close 路径进行加强自主复核。

外部状态：

- active E1 resources：2 个 bucket、2 个 limited key；
- revoked E1 credentials：1 个失败 Reader key；
- Droplet/DNS/origin：0；
- 生产资源 mutation：0；
- 当前成本只来自已启动 Spaces subscription，尚未启动 Droplet 计费。

计划复盘与下一轮：

- 本模块关闭 Spaces 与最小权限 credential 子项，不关闭 E1/R3；
- 下一步先冻结推送 Cycle 64 executor，再创建唯一 SGP1 Droplet、配置 Cloudflare
  staging DNS、Caddy TLS 与 Spaces-backed origin；
- 之后才能重建四 Agent Release Set、生成非生产 Trust、上传回读、发布 Registry
  和执行 14 项故障矩阵；任何失败先清理，不跳到 P5。

### 循环 65：P4 R3 E1 Droplet、DNS 与 origin executor

状态：唯一 Droplet 和 DNS-only staging 记录已创建；Spaces-backed origin/Caddy
部署器已完成本地验证并等待冻结 commit，生产 R3 继续关闭

执行结果：

1. Cycle 64 commit `028fc9f` 推送后生成本机临时 SSH transport key；私钥 mode
   `0600`，没有进入 DigitalOcean 账号 key 列表或仓库；
2. 首次 create 在任何 API mutation 前因完整 commit 输入错误本地 fail-close；
   使用真实 full commit 后只创建一个 SGP1 `s-1vcpu-1gb` Droplet；
3. API 复验 active、1 GiB、1 vCPU、25 GiB、无 backup/monitoring，并保存 mode
   `0600` pending/live cleanup state；
4. Cloudflare 创建一个 staging A record，明确关闭 proxy，防止 edge cache/
   redirect/WAF 改写 exact-origin 语义；生产 DNS 未修改；
5. 新增 Spaces-backed Node origin，只监听 loopback，由 Caddy 提供公网 TLS；
6. Trust、Registry 和 immutable objects 映射到两个 Spaces bucket，并按路由固定
   64 KiB/1 MiB/32 MiB 上限、MIME、no query/fragment 和 no redirect；
7. 14 项 fault route 全部存在且受精确临时 token 保护；日志只含 method/
   routeClass/status，不记录 URL、IP、token、bucket 或凭据；
8. systemd 使用独立无登录用户、`NoNewPrivileges`、`ProtectSystem=strict`、
   `ProtectHome`、空 capability；Caddy 不启用 access log；
9. 部署器固定 DNS/Droplet/Spaces suffix、droplet executor 与当前 clean origin
   executor，远端只注入 Reader key，Publisher 始终留在本机。
10. 首次实际 deploy 在 SSH 前 fail-close：部署器误将当前 origin executor commit
    与 Droplet 创建 commit 比较；临时状态逐项正确，现已分离两段 provenance 并加
    默认 Droplet commit 回归，冻结修复前不重试远端部署。

自主验证：

- origin service 5/5；
- origin deploy boundary 5/5；
- 既有 authorization/Spaces/Droplet 25/25；
- E1 联合 35/35，另有 P4 preflight 17/17；
- Node syntax、diff check、根 `target/` absent；
- Kimi 继续暂停，主 Agent 已复核 remote command 不含 secret、Caddy/systemd
  hardening、DNS-only 和 fail-close live state。

外部状态与预算：

- active：2 bucket、2 limited key、1 Droplet、1 DNS-only record；
- origin/TLS：尚未部署；
- 生产 mutation：0；
- 当前小时成本约 `0.007 + 0.00893 = 0.01593 USD`，72 小时模型仍低于
  `1.15 USD` 预计值和 `3 USD` 硬上限。

计划复盘与下一轮：

- 下一步只冻结推送 origin executor，并部署/复验 Caddy TLS 与 HTTPS health；
- origin 通过后才进入四 Agent Release Set、E1 Root/Publisher、上传回读、
  Registry last 与 14 项消费者故障矩阵；不跳到 P5。

### 循环 66：P4 R3 E1 Fake-IP DNS 预检修复

状态：Cloudflare staging 记录已通过 HTTPS DNS 精确复验；本机 TUN/Fake-IP
造成的部署预检误判已修复，origin 远端部署仍需在本 commit 冻结推送后执行

偏差识别与计划校准：

- Cloudflare 控制台中的 staging A record 为预期 Droplet IP、DNS-only、TTL
  1 分钟，zone 为 Full/Active；生产记录没有变化；
- 本机直接向公共和权威 DNS 发起的 UDP/53 查询均被 TUN 改写为
  `198.18.0.0/15` RFC 2544 保留网段，部署器因此无法看到真实权威答案；
- 这不是 Cloudflare 传播失败，也不允许通过跳过 IP 校验继续部署；修复保持
  “staging hostname 必须精确指向批准 Droplet”的 fail-closed 条件。

已经实现：

1. 明确识别且仅识别 `198.18.0.0/15` Fake-IP，不把其他私网或不匹配地址当作
   已批准答案；
2. 系统 DNS 精确匹配时不发额外请求；不匹配或 Fake-IP 时使用 Cloudflare
   HTTPS DNS 做独立 A 记录复验；
3. HTTPS DNS 请求不跟随 redirect，固定 15 秒连接/30 秒总超时、64 KiB 输出
   上限，并只接受查询 hostname 的精确 IPv4 A answer；
4. curl/JSON/状态/hostname/IP 任一异常均视为未解析，不回退为宽松放行；
5. 实际 staging HTTPS DNS 复验返回 `approved_dns_match=true`，未输出或留存
   hostname、IP、endpoint URL 或凭据。

自主验证与计划复盘：

- origin deploy boundary 11/11；
- E1 authorization/Spaces/Droplet/origin 联合定向 40/40；
- 本轮仅修复 DNS 安全预检，不关闭 TLS/origin、E1 或生产 R3；
- 下一步先冻结推送本修复 commit，再对唯一隔离 Droplet 执行 Caddy/TLS/origin
  部署和 HTTPS health；通过后按原计划进入四 Agent Release Set，不跳到 P5。

### 循环 67：P4 R3 E1 SSH operator 恢复边界

状态：不可非交互登录的空载 Droplet 已销毁，临时 SSH 私钥已销毁；独立 operator
修复已通过本地测试，等待冻结 commit 后重建唯一替代 Droplet

实际偏差与处置：

- DNS 复验通过后，部署器首次接触 Droplet；临时 SSH key 被接受，但 DigitalOcean
  Ubuntu 镜像要求 `root` 首次登录修改密码，非交互命令在 `cloud-init` 检查前
  被 PAM 拒绝；
- 没有安装 Caddy、没有传输 Reader key 或 origin 文件，也没有产生远端应用状态；
- 不关闭 PAM、不设置 root 密码、不进入 recovery console；立即销毁该空载
  Droplet，API 复验不再存在，旧临时 SSH 私钥覆盖后删除；
- staging DNS 暂时仍存在但指向已销毁 IP，不承载任何服务；两个 bucket 和两组
  limited key 保持原边界。

已经实现：

1. cloud-init 禁止 root SSH，创建 `agentmesh-operator` 独立用户；
2. operator 密码锁定、只允许临时 Ed25519 公钥登录，只加入 sudo 组并为本次
   自动化提供明确 NOPASSWD sudo；
3. 远端命令统一通过 `sudo --` 执行，SCP 只先写 operator 可写的 `/tmp`，再由
   受控安装命令设置最终 owner/mode；
4. 新增 `record-dns` 状态动作，从批准 Droplet 名称推导唯一 staging hostname，
   只能记录一次且保持 mode `0600`；
5. 重建顺序固定为 active Droplet=0 后 prepare/create，再更新同一 staging
   DNS，不允许同时存在两个 E1 Droplet。

自主验证与计划复盘：

- Droplet/operator 与 origin deploy 定向 18/18；
- 本轮属于 P4 隔离基础设施恢复，不扩大资源数、权限、预算或执行窗口；
- 下一步冻结推送该修复，重建唯一 1 GiB Droplet、更新同一 DNS 并复验
  Caddy/TLS/HTTPS health；成功后继续原定 Release Set，不启动 P5。

### 循环 68：P4 R3 E1 替代 Droplet 与 DNS 恢复

状态：唯一替代 Droplet 已创建并通过 API 规格复验，同一 DNS-only staging
hostname 已切换并通过 HTTPS DNS 精确匹配；origin 部署等待本 commit 冻结

实际执行：

1. Cycle 67 commit `be108f4` 推送后，在 active E1 Droplet 为 0 的前提下生成
   新临时 SSH key 与 operator cloud-init；
2. 只创建一个 SGP1 `s-1vcpu-1gb` 替代 Droplet；API 复验 count=1、1 GiB、
   1 vCPU、25 GiB、无 backups；
3. 使用一次性 `record-dns` 写入 mode `0600` cleanup state；
4. Cloudflare 只更新原 E1 staging A record 的 content，hostname、DNS-only、
   TTL 和生产记录均未改变；
5. 控制台记录和 Cloudflare HTTPS DNS 都精确匹配替代 Droplet；
6. 部署器的固定 Droplet provenance 更新为 `be108f4`，旧的已销毁实例 commit
   不再被接受。

计划复盘与下一轮：

- active E1 资源恢复为 2 bucket、2 limited key、1 Droplet、1 DNS record；
- 资源上限、权限、区域、费用、72 小时窗口和生产隔离均未扩大；
- 下一步冻结推送当前 origin executor，再执行 operator SSH、Caddy/TLS、
  Spaces-backed origin 与 HTTPS health；通过前不进入 Release Set。

### 循环 69：P4 R3 E1 非特权 Origin 目录权限修复

状态：operator SSH、cloud-init、Caddy 安装和文件传输均已通过；origin 因父目录
不可穿越而未激活，最小目录权限修复已完成本地验证并等待冻结

实际结果与根因：

- operator 公钥登录和 `sudo --` 成功，root 首次改密问题已关闭；
- Caddy、Node origin、systemd unit 和 Reader 配置已进入唯一隔离 Droplet；
- Reader 配置为 `0600 agentmesh-e1:agentmesh-e1`，Publisher 未进入远端；
- cloud-init 为提前保守建目录使用 `0700 root:root`，部署阶段没有在 service user
  创建后调整父目录；文件虽存在，`agentmesh-e1` 无法穿过 `/opt`，systemd 循环
  报入口模块不存在；
- HTTPS health 尚未通过，live state 未写 `origin.deployed=true`，因此 P4/R3
  仍未关闭。

修复与复核：

1. service user 创建后显式把代码目录固定为 `0755 root:root`；
2. 配置目录固定为 `0750 root:agentmesh-e1`，配置文件本身继续保持 `0600`；
3. 不把代码或配置目录设为 service user 可写，不放宽 systemd hardening；
4. 修复冻结后重跑幂等部署，再要求 origin/Caddy active 和公网 HTTPS health
   同时通过；
5. 下一步仍是关闭 Origin 子项，未进入 Release Set/P5。

### 循环 70：P4 R3 E1 瞬时 SSH 与本机 HTTPS 传输适配

状态：目录修复重跑时出现可恢复的 SSH transport 断开；有界重试与 curl HTTPS
health 已完成本地验证，等待冻结后继续同一幂等部署

偏差与边界：

- operator 身份只读探针始终成功，但多次短 SSH 连接中两次收到 connection
  closed；这不是公钥、sudo、PAM 或 UFW 永久失效；
- 已成功执行的 apt/install/systemd 操作都是幂等步骤，live state 仍未声明
  origin deployed；
- 本机 Node `fetch` 同样受 TUN/Fake-IP 传输影响，不能用它作为最终公网 TLS
  health 的唯一观测路径。

已经实现：

1. SSH/SCP 只对 connection closed/reset/refused、kex reset、timeout 等明确
   transport 错误最多重试 3 次，每次间隔 1 秒；
2. publickey denied、sudo 需密码或远端命令失败不重试，继续 fail-close；
3. HTTPS health 改用 curl，固定 HTTPS-only、no redirect、10 秒连接/15 秒总
   超时、64 KiB 输出上限；
4. 只接受 200、`application/json` 和精确 health body，其他结果继续重试后失败；
5. 故障重试不增加资源、权限、Provider、credits 或生产 mutation。

计划复盘与下一轮：

- origin deploy boundary 增至 14/14；
- 下一步冻结本修复并再次幂等部署；只有 systemd origin/Caddy 和 HTTPS health
  全部通过才更新 infrastructure checkpoint 为 Origin PASS；
- Release Set、Trust、Registry、故障矩阵和最终清理顺序不变。

### 循环 71：P4 R3 E1 HTTPS Origin 实机通过

状态：隔离 Spaces-backed Origin、Caddy TLS 和公网 HTTPS health 已通过；P4
进入四 Agent Release Set/Trust/Registry，生产 R3 仍未关闭

实际执行与证据：

1. Cycle 70 commit `8a76380` 推送后，使用同一 clean executor 幂等重跑部署；
2. operator SSH/SCP 瞬时断开由有界 transport retry 收敛，没有新增实例或凭据；
3. 代码目录为 `0755 root:root`、配置目录 `0750 root:agentmesh-e1`、Reader
   配置 `0600 agentmesh-e1:agentmesh-e1`；
4. `agentmesh360-e1-origin.service` 与 `caddy` 均为 active；
5. live state 为 `origin.deployed=true`，记录精确 executor 和 Caddy-managed TLS；
6. 公网 `/healthz` 返回 200、`application/json` 和精确 E1 body；
7. Trust 尚未上传时 `/v1/trust-bundle.json` 返回 404，证明 Origin 能以 Reader
   访问 metadata bucket 且没有伪造空 Trust；
8. 带 query 的 health 请求返回 400，no-query 边界未被 Caddy 改写。

计划复盘与下一轮：

- 本轮只关闭 P4 的 Origin/TLS 子项，不关闭 Release Set、故障矩阵、完整清理或 R3；
- 下一步按授权重建四 Agent A/B Release Set，生成一个临时 E1 Root/Publisher，
  先发布 Trust、再不可变 objects、最后 Registry；
- 继续保持生产 Trust/Registry 常量为空，不进入 P5。

### 循环 72：P4 R3 E1 可留存 Release Set 构建器

状态：四 Agent A/B 双构建的 E1 临时留存执行器已完成本地验证；尚未生成 E1
Publisher、Root、Release Set 或上传对象

计划校准：

- 复用已通过 P3 的同一冻结候选、三项外部源码 commit、离线 Cargo 构建和十类
  逐字节比较，不复制另一套较弱的 Package Author；
- E1 与 P3 的差异只有成功后暂存 A 组发布结果和单一 Publisher 私钥，供本轮
  Trust/Registry 发布；失败时仍自动销毁；
- 临时结果只允许在系统临时目录的 `agentmesh360-release-provenance-e1-*`
  mode `0700` 边界，状态文件 mode `0600`，不进入仓库或聊天证据。

已经实现：

1. Release signer 继续支持原 E0 边界，并新增精确 E1 临时前缀；其他路径仍拒绝；
2. 原 P3 runner 默认行为完全不变：E0 成功仍销毁 key、build roots 和整个边界；
3. E1 retain 模式仍执行两个独立 Cargo target、四 Agent 双 build、8 次签名、
   十类输出逐字节比较和 source/candidate worktree 清理；
4. 只有全部四 Agent 比较通过时才保留一个 Publisher 私钥、公开证据和 A 组
   Release；任何中途异常继续销毁；
5. Release URL 绑定实际已部署的 DNS-only HTTPS Origin，拒绝未 deployed、
   非 Caddy TLS、proxied 或非 E1 hostname 的状态；
6. 新 runner 只接受完整绝对路径参数、精确 executor commit 和 mode `0600`
   Origin state，不输出临时路径、公钥或签名。

计划复盘与下一轮：

- 新增 E1 builder 2/2，Release signer/既有 provenance 联合 18/18；
- 下一步先冻结推送本执行器，再运行耗时离线双构建；成功后生成临时 Root、
  组装/复验 Trust 与 Registry 并上传；
- 生产常量、P5-P8、Provider 与 credits 继续关闭。

### 循环 73：P4 R3 E1 冻结源码与用户脏工作区隔离

状态：首次 E1 双构建在 key/boundary 生成前因 Deploy 源仓库 dirty 而 fail-close；
detached frozen-commit 隔离修复待冻结后重试

实际边界：

- `agentmesh-deploy` 当前含用户已有的 CreatorCut production 文件修改与未跟踪
  evidence；这些改动不属于 P4，不清理、不暂存、不提交；
- Job Agent 与 LectureCast 源仓库仍 clean；
- 首次执行在 `assertSourceRepository` 阶段停止，未生成 Publisher、Release Set、
  build target 或新上传对象。

修复：

1. P3 E0 默认行为不变，源仓库 dirty 仍拒绝；
2. 仅在 `retainBoundary=true` 的 P4 E1 路径，允许源仓库工作目录存在未提交改动；
3. 实际输入仍由 `git worktree add --detach <精确冻结 commit>` 创建；
4. 每个 detached worktree 随后必须通过 HEAD 精确 commit 和 porcelain clean
   复验，用户工作区内容不会进入 Package；
5. worktree 仍在成功/失败后移除，用户工作树不被改写。

计划复盘：

- 不降低 candidate、executor、Cargo.lock、Package 输出或签名约束；
- 下一步冻结推送修复后重试同一 E1 双构建，再进入 Root/Trust/上传；
- 原产品顺序与生产边界不变。

### 循环 74：P4 R3 E1 四 Agent Release Set 实际双构建

状态：四个 Agent 的 E1 A/B 双构建、8 次临时 Publisher 签名和十类输出逐字节
复验已通过；Release Set 与一个临时 Publisher 仅保留在本机临时边界

实际结果：

1. Cycle 73 commit `d99ffcf` 推送后执行；
2. Deploy/Future/Job/Lecturecast 四 Agent 均为 buildCount=2、status=passed；
3. 每个 Agent 的 Artifact、Envelope、finalize receipt、Host bundles、
   Host projection、package file manifest、Registry record、Release Manifest、
   signature result、signing request 共十类输出均逐字节一致；
4. 临时 Publisher 只生成一次，完成 8 次签名与 8 次复验；
5. Release state mode `0600`、完整边界 `0700`、Publisher 私钥 `0600`；
6. candidate/source detached worktree 全部移除，builder target 全部移除，根
   `target/` 不存在；
7. 用户 `agentmesh-deploy` dirty 工作树未被修改；
8. 尚未生成 Root、Trust、Registry snapshot，尚未上传任何 Release 对象。

计划复盘与下一轮：

- P4 Release Set build 子项通过，但不能单独视为 R2/R3 或外部分发通过；
- 下一步生成本轮唯一临时 Root，使用已留存 Publisher 构造并验证 Trust bundle，
  组装四记录 Registry snapshot 与故障 fixtures；
- 发布仍须 Trust-first、immutable objects、Registry-last，之后执行消费者故障矩阵。

### 循环 75：P4 R3 E1 Trust/Registry 不可变发布执行器

状态：临时 Root、Trust/Registry、Release objects、fault fixtures 与 readback 的
执行器已完成本地验证；尚未生成 Root 或执行云端发布

已经实现：

1. 发布前要求精确 clean executor commit，并再次确认三个生产 Package 常量为空；
2. 从已通过的四 Agent state 重读并复验 4×10 输出、Origin 绑定、Registry record
   严格字段、URL、digest、Host bundle 和本地文件摘要；
3. 仅在这些复验后生成本轮唯一临时 E1 Root，Root 与 Publisher 私钥都留在原
   `0700` 临时边界、文件 mode `0600`；
4. Trust 使用 Rust 同序 canonical payload、Root 签名、Node Ed25519 复验和既有
   `verifyTrustBundle` 完整状态验证；
5. Registry v2 使用 Rust 相同的 base64 字段序、package/host 排序和 canonical
   payload，revision=2 为 rollback/equivocation 故障留出 revision=1；
6. 上传顺序固定为 Trust、27 个 immutable Release objects、6 个签名 fault
   fixtures、Registry last；
7. 每个对象先 HEAD=404、再 Publisher PUT、最后 Origin Reader GET，并逐字节
   SHA-256 回读；
8. 在首个 PUT 前写 mode `0600` pending publication state，逐对象更新 receipt；
   即使中途失败也保留完整 cleanup inventory，不会丢失撤回/删除路径；
9. 生成 digest mismatch、signature mismatch、expired metadata、rollback、
   same-revision equivocation、invalid/expired LKG 六类签名 fixture；其余 transport/
   MIME/redirect/size/partial publication 由 Origin 固定路由提供。

自主验证与计划复盘：

- publisher/Trust/Registry/worker 定向 21/21；
- 本轮未生成 Root、未上传对象、未修改生产常量；
- 下一步冻结推送 executor 后实际发布并用公网 Origin 复验 Trust、Registry 与
  全部 immutable objects；任何失败先按 pending inventory 清理，不进入 P5。

### 循环 76：P4 R3 E1 Release Set 实际不可变发布

状态：四 Agent Release Set、临时 Trust、六类签名故障 fixture 与 Registry 已按
批准顺序发布并完成公网回读；故障矩阵和最终销毁尚未完成

实际执行与证据：

1. Cycle 75 commit `354f4a0` 推送后才生成本轮唯一临时 Root 并执行发布；
2. 共发布 35 个对象：27 个 Release 对象、Trust、6 个签名故障 fixture 和
   Registry；
3. 每个对象都先确认 HEAD 不存在，再由最小权限 Publisher PUT，并由只读 Origin
   Reader 回读 SHA-256；35/35 receipt 完整；
4. Registry 是第 35 个且最后一个对象，`registryPublishedLast=true`；
5. 公网 Trust、Registry 和 27 个 Release 对象均通过 HTTPS Origin 回读并与
   receipt 摘要一致；
6. 生产内嵌 Trust、生产 Trust URL、生产 Registry URL 仍全部为 `None`；
7. Provider 请求、credits、生产资源变更均为 0。

计划复盘与下一轮：

- 发布 happy path 已关闭，但没有故障矩阵和完整清场就不能写 E1 PASS；
- 下一步只执行已批准的 14 项 transport、metadata、rollback、equivocation、
  LKG 和半发布场景；
- 通过后严格先撤 Registry，再删除其他对象与临时密钥/云资源，不进入 P5。

### 循环 77：P4 R3 E1 十四场景故障矩阵执行器

状态：故障矩阵执行器已完成本地定向验证；真实 staging 演练等待本 commit
冻结并推送后执行

已经实现：

1. 精确固定 14 个批准场景及顺序，不允许少测、改名或乱序；
2. 执行前要求仓库 HEAD 等于显式 40 位 executor commit 且工作树 clean；
3. 再次检查三个生产 Package 常量为空，并验证公网 Trust/Registry 的 Root、
   sequence、revision、时效、package 顺序和签名；
4. fault token 仅经 curl stdin config 传递，不进入 argv、receipt 或日志；
5. 请求固定 HTTPS、no redirect、2 MiB 上限、有界 timeout 与最多 4 次明确
   transport retry；
6. receipt 只保留 scenario、evidence code、逻辑请求数和最大 curl 尝试数，
   不保留 hostname、URL、IP、bucket、token、key 或签名；
7. 定向测试 9/9 与 diff check 通过。

计划复盘与下一轮：

- 本模块没有新增资源、权限或费用类型；
- 下一步冻结本执行器后在当前 E1 staging 跑 14/14；任一项失败先修复并复验，
  不把部分结果写成 PASS；
- 全部通过后立即进入既定 withdrawal/cleanup，不延伸到 P5。

### 循环 78：P4 R3 E1 Origin fault-token 运行态一致性修复

状态：真实矩阵在 timeout 场景 fail-close；已定位配置文件与常驻进程 token 漂移，
修复及回归测试完成，等待冻结后幂等重部署再重跑完整矩阵

实际现象与根因：

- 第 1 项 not-found 返回预期 404，但第 2 项 timeout 在约 6 秒返回 404，执行器
  立即中止且没有生成 PASS receipt；
- 独立复测 wrong-content-type 同样为 404，说明受保护 fault route 没有接受当前
  state token；
- 本机 live state、本地 origin config 与远端磁盘 config 逐字节哈希一致；
- 幂等部署每次生成新 token 并覆盖配置，但原命令使用
  `systemctl enable --now`；服务已 active 时不会 restart，常驻 Node 进程继续
  使用上一次内存 token。

修复与复核：

1. unit 写入并 daemon-reload 后，先 `systemctl enable`，再无条件显式 restart
   Origin；Caddy restart 和两个 active 检查不变；
2. HTTPS health 通过后新增 direct-to-approved-IP fault probe，绕过本机代理/TUN；
3. token 仍只通过 curl stdin config，不进入 argv、日志或状态之外的新证据；
4. probe 必须收到 200、`text/plain` 与精确 body，旧进程/新配置漂移会 fail-close；
5. 定向测试 20/20 和 diff check 通过。

计划复盘与下一轮：

- 这是当前 P4 fault harness 的运行态一致性修复，不改变产品、资源或权限范围；
- 下一步冻结推送后幂等重部署同一 Origin，要求 health 与受保护 fault probe 同时
  通过，再从第 1 项重新执行完整 14 场景；
- 不接受从第 3 项续跑，也不进入 P5。

### 循环 79：P4 R3 E1 十四场景真实故障矩阵通过

状态：修复后同一 Origin 幂等重部署成功，完整故障矩阵从头重跑并 14/14 通过；
P4 仍等待 Registry 撤回和全部 E1 资源/秘密销毁

实际证据：

1. Cycle 78 commit `4dbb6ea` 推送后才重部署同一实例，没有新增 Droplet、bucket、
   key、DNS、权限或费用类型；
2. Origin/Caddy active、正常 HTTPS health 和 direct fault-token probe 同时通过；
3. 第一次失败没有 receipt；修复后从 not-found 重新开始，不复用部分结果；
4. 14 场景全部通过：404、timeout、截断、超限、错误 MIME、redirect、digest、
   signature、expiry、rollback、同 revision equivocation、有效 LKG transport
   failure、失效 LKG、Registry-before partial publication；
5. receipt mode `0600`，14/14 passed，16 个逻辑 HTTPS 请求、最多 64 次传输尝试；
6. Provider 请求、credits、生产 mutation 均为 0；
7. 仓库只留去秘密 JSON：无 hostname、URL、IP、bucket、token、key 或 signature。

计划复盘与下一轮：

- P4 的 build、publication 和 fault matrix 已完成，但 cleanup 是同一验收的一部分；
- 下一步严格先删除 Registry 并从公网验证 404，再删除 Trust、fault fixtures 和
  27 个 Release 对象；
- 之后销毁 Root/Publisher、Droplet、DNS、limited key、bucket 和本机秘密，
  完整清场前不进入 P5。

### 循环 80：P4 R3 E1 Registry-first 清场执行器

状态：对象撤回与临时签名材料销毁执行器完成本地验证；尚未执行外部删除

已经实现：

1. 只接受 frozen/clean executor、生产空常量、14/14 fault receipt 和完整
   Registry-last publication state；
2. 对 35 个对象逐项绑定 bucket class、object key、digest 与 receipt，要求
   27 Release + 8 metadata 且 Registry 精确位于最后；
3. 首先 DELETE Registry，再由 direct-to-approved-IP HTTPS Origin 验证 404；
4. 其余 34 个对象逆序删除，每个由只读 Origin principal HEAD=404 复验；
5. 删除过程先写 mode `0600` pending state，并允许在明确的同 executor state 上
   幂等重跑，S3 transport 中断不会丢失 inventory；
6. 对象全部 absent 后通过隔离 signer 覆盖并删除 Root 与 Publisher 私钥，再删除
   整个 E1 Release boundary；
7. publication/release/fault state 暂留到最终云资源复核后统一删除，避免清场中途
   丢失非秘密恢复证据；
8. 定向测试 10/10，实际 35-object inventory 预检通过，diff check 通过。

计划复盘与下一轮：

- 下一步冻结推送后执行 Registry-first 对象/私钥销毁；
- 只有 35/35 absent 且两把私钥和 Release boundary 都销毁，才删除 DNS/Droplet、
  key 与 bucket；
- 生产资源、P5-P8 继续关闭。

### 循环 81：P4 R3 E1 Registry、对象与临时签名材料实际销毁

状态：Registry-first 撤回、35/35 对象删除、Root/Publisher 私钥与 Release
boundary 销毁全部完成；E1 云资源和本机临时状态仍待删除

实际执行与复验：

1. Cycle 80 commit `cd1f2df` 推送后才执行不可逆清理；
2. Registry 首先删除，direct HTTPS Origin 立即复验为 404；
3. 35/35 对象均由 Publisher DELETE，并由 Origin Reader HEAD=404；
4. 公网 Registry 与 Trust 均为 404；
5. 隔离 signer 覆盖并删除临时 Root、Publisher 私钥，两者路径均 absent；
6. E1 Release boundary 已递归删除，builder/source worktree 仍 absent；
7. cleanup state mode `0600`、`objects_and_private_material_destroyed`，只留非秘密
   计数和时间；仓库固化同内容最小 JSON；
8. Provider 请求、credits、生产 mutation 为 0。

计划复盘与下一轮：

- Package 公开面和私钥面已清空，但 Droplet/DNS/Spaces key/bucket 仍是 active
  资源，因此 P4 尚未最终关闭；
- 下一步删除 DNS，销毁唯一 E1 Droplet，再撤销两组 limited key、删除两个空
  bucket，并取消不再需要的 Spaces subscription；
- 最后删除本机 credentials/state，复验生产常量为空和根 `target/` absent。

### 循环 82：P4 R3 E1 云基础设施实际清场

状态：staging DNS、E1 Droplet、limited key 和 billable bucket 均已撤回；两个
空 bucket 进入 Provider 永久删除队列且明确停止计费，本机临时 secret/state
尚待最终销毁

实际执行与复验：

1. Cloudflare 精确 E1 A record 已删除，页面匹配计数为 0；
2. 唯一替代 Droplet 经批准 destroy runner 销毁；doctl 对精确 ID/名称复验为 0；
3. operator SSH 私钥由 destroy runner 覆盖删除；
4. Origin Reader 与 Publisher 两组 limited key 永久删除，Access Keys 页面精确
   名称均 absent、操作菜单计数为 0；
5. 两个 bucket 删除前均为 0 Bytes / 0 items，删除后均进入永久删除队列；
6. Provider 页面明确标注两个 bucket 不再计费，可操作 link/menu absent；
7. 账户不存在其他 Spaces bucket，因此没有删除无关 bucket；DigitalOcean 对最后
   bucket 使用删除排队即停止计费，没有独立 subscription cancel 动作；
8. 从资源创建到撤回不足 2.2 小时，包含首台短命 Droplet 的保守运行成本上界
   `0.05 USD`，远低于 `3 USD` 硬上限；最终账单尚未结算，不冒充 invoice。

计划复盘与下一轮：

- 外部可访问面、计算、凭据与 billable storage 已全部撤回；
- 下一步实现并冻结本机 finalizer，验证上述非秘密 receipts 后覆盖删除 Spaces
  credential、Origin token/state、publication/release/fault/cleanup temp state
  和两段 Droplet boundary；
- 随后做全量回归、生产空 Trust/Registry、根 `target/`、GitHub main 同步复验。

### 循环 83：P4 R3 E1 本机 secret/state 最终销毁器

状态：本机 finalizer 完成实现和精确 inventory 预检；尚未执行本机不可逆销毁

已经实现：

1. 只接受 frozen/clean executor 和生产空 Trust/Registry 常量；
2. 复验仓库 cloud cleanup evidence、mode `0600` object cleanup/publication/
   release/fault/credential state；
3. 要求 cloud evidence 明确 DNS absent、Droplet/key/billable bucket 为 0；
4. 要求对象 35/35 absent、Registry-first、Root/Publisher/Release boundary
   已销毁、fault matrix 14/14；
5. `/private/tmp` 只允许精确 7 个 E1 entry，任何额外同前缀文件或遗留
   release-provenance boundary 都 fail-close；
6. 两个 Droplet boundary 必须是系统临时目录直接子目录、mode `0700`、非 symlink；
7. 所有 regular file 使用 `O_NOFOLLOW` 随机覆盖、fsync、unlink；目录内遇到
   symlink、特殊文件或超过 64 MiB 文件即停止；
8. 完成后要求 E1 temp entry count=0；定向 2/2，实际 inventory 7/7 预检通过。

计划复盘与下一轮：

- 下一步冻结推送 finalizer 后执行一次本机销毁；
- 执行结果只固化非秘密计数，不保留 URL、路径、key、token、IP、signature；
- 随后完成 P4 全量测试、Rust consumer 定向测试、生产空常量、根 `target/`、
  Git clean/main push 复验；P5 不在本轮范围。

### 循环 84：P4 R3 E1 finalizer 临时根目录固定

状态：首次 finalizer 在任何删除前 fail-close；根目录环境漂移已定位并修复

实际根因与修复：

- 当前 7 个 E1 entry 仍全部存在，没有发生部分删除；
- finalizer 使用 `os.tmpdir()` 查 inventory；macOS 当前进程返回用户级
  `/var/folders/.../T`，但本轮授权、执行器和全部实际 state 固定在
  `/private/tmp`；
- 0 项观测触发 exact-inventory 阻断，说明 fail-close 生效；
- 修复显式固定 `APPROVED_TEMP_ROOT=/private/tmp`，并继续要求两个 boundary
  的 realpath 是该目录直接子项；
- 不接受 `TMPDIR` 环境变量改变根目录，不增加新路径；
- 定向测试增至 3/3，实际 7-entry inventory 保持完整。

下一步：冻结推送修复后重新执行一次 finalizer，再进入最终回归；产品顺序、
权限和 P5 状态不变。

### 循环 85：P4 R3 E1 隔离分发演练最终验收

状态：P4 的 E1 隔离分发演练完整通过并清场；生产 R3 未关闭，P5 未授权

最终结果：

1. finalizer 修复 commit `cda215c` 推送后执行成功：standalone state/credential
   5 项、Droplet boundary 2 项全部覆盖删除，本机 E1 temp entry=0；
2. Cloudflare E1 DNS record=0、DigitalOcean E1 Droplet=0、limited key=0；
3. 两个 bucket 从“不再计费的删除队列”完成为 exact bucket count=0；
4. 四 Agent 双构建、8 次 Publisher 签名复验、每 Agent 十类输出逐字节一致；
5. Trust-first、27 Release objects、6 fault fixtures、Registry-last 共 35 对象
   发布与回读完成；
6. 14/14 故障矩阵完整通过；Registry-first、35/35 absence 与 Root/Publisher
   私钥销毁完成；
7. 全仓库 Node 工具测试 151/151；
8. Rust consumer：Package Trust/Cache 8/8、Registry Snapshot 7/7、
   Registry Fetcher/LKG 4/4；
9. Rust 测试隔离 target 与仓库根 `target/` 均 absent；
10. 生产内嵌 Trust、生产 Trust URL、生产 Registry URL 均保持 `None`；
11. Provider 请求、credits、生产 mutation 均为 0；保守成本上界 `0.05 USD`，
    final invoice 尚未结算；
12. Kimi 按用户要求暂停，不计为本轮门禁；主 Agent 完成全部代码、证据、边界和
    外部状态自复核。

计划复盘与后续边界：

- 本轮只证明 E1 隔离分发链、故障恢复和完整清场成立，不等于生产 key、生产
  endpoint 或生产 R3 通过；
- 按原计划下一项是 P5 Package canary，但它需要专用内部账号、真实有效订阅、
  BYOK Provider/费用、cohort 和停止窗口的独立精确批准；
- 本轮不启动 P5，不启动 Apple 签名/公证 P6，不修改生产常量。

### 循环 86：P5 Package Canary 零权限阻断式预检

状态：P5 no-authority preflight 已完成；真实 P5 canary 未授权、未执行

已经实现：

1. 新增 strict `agentmesh360-package-canary-preflight-v1` Schema、默认
   `authority=none` / `executionStatus=blocked` 模板和中文检查清单；
2. 模板逐字节绑定 P4 最终验收 receipt，同时固定 P4 没有关闭生产 R3、没有保留
   Root/Publisher/云资源或生产常量；
3. 固定当前只有 R1/R2 E0、R3 E1 技术演练和 R6 本地基线，禁止把技术演练伪造成
   本次 canary release chain 已 ready，也禁止把 E1 偷换成 E2 或生产门通过；
4. 固定现有客户端订阅与账户二次校验、600 秒一次性权限批准、32 pending 上限、
   权限扩张确认、显式 rollback、LKG 和稳定 Main Session 契约；
5. 固定 21 项订阅、账户、BYOK/Provider、预算、Package、Trust、Registry 与
   rollback/reconcile 场景；全部保持 `blocked`；
6. 批准卡要求 Release/Package Set、专用内部账号、有效订阅、BYOK Provider/模型、
   四类预算、cohort、窗口、rollback、Abort Owner 与 evidence retention；
7. 无新批准时 network、subscription、Provider、Package Origin、Keychain、外部
   资源和生产常量 mutation 全部为 false/0；
8. 无依赖 CLI 拒绝 unknown/duplicate key、symlink、非法 UTF-8、超限输入、门禁
   伪造、场景缺失/重排和证据敏感字段。

验证证据：

- P5 定向 Node：18/18；
- 全仓库 Node tools：169/169；
- 首次沙箱全量运行中 4 项旧 Origin 测试因禁止监听 `127.0.0.1` 返回 `EPERM`；
  在仅放开本机 loopback、无外部服务的非沙箱复跑中全部通过；
- JSON 3/3、秘密标记扫描和 `git diff --check` 通过；
- Validator 静态证明不导入 network/Keychain/Provider/subprocess capability；
- Provider 请求、credits、Keychain 读取、外部资源和费用均为 0；
- Kimi 继续按用户要求暂停，本轮为主 Agent 加强自主复核，不冒充 Kimi PASS。

计划复盘与后续边界：

- 本轮只完成 P5 的机器阻断式准备，不关闭 R1/R2/R3/R6，不写
  `canary_authorized`、`canary_running` 或 `canary_passed`；
- 真实 P5 前必须先提供针对本次 E1 release chain 的适用前置证据，并另行精确批准专用账号、订阅、BYOK、
  Provider/模型、请求/credits/费用、cohort、窗口、rollback 和清场；
- P6-P8、Apple Developer ID、公证、生产 Trust/Registry 与外部 cohort 不在本轮
  范围。

### 循环 87：P5 E1 精确批准卡

状态：历史批准记录；Cycle 92 已确认其中“现有专用内部测试账号”前提不成立，
该授权不可继续执行

已经实现：

1. 新增 strict `agentmesh360-package-canary-authorization-v1` Schema、留存安全
   authorization receipt 和无依赖 validator/CLI；
2. 固定 1 个专用内部账号、1 台 Mac、`72h` 窗口且禁止自动延长；
3. 固定已保存在受控进程环境中的 Gemini 测试 Key、`google-gemini` /
   `gemini-3.5-flash-lite`、最多 12 次推理、0 AgentMesh credits、Provider
   `$1` 硬上限且禁止静默 fallback；
4. 固定复用 DigitalOcean 账号能力但不复用生产 Droplet：SGP1 唯一 1 GiB
   Droplet、2 Spaces、1 DNS-only record、预计 `$1.15`、基础设施 `$3` 硬上限；
5. 固定重新构建 P4 四 Agent frozen Release Set，生成 2 个临时 E1 Root 和
   2 个 Publisher；P4 私钥不可复用，生产 Trust/Registry 常量不可修改；
6. 固定 Job Agent `0.4.7` baseline、`0.4.8-e1.1` 同权限更新、
   `0.4.9-e1.1` 增加 `process_execution` 的拒绝/批准/rollback 变体；
7. 所有 Package mutation 必须在隔离 canary state home 进行，正常用户状态只做
   前后摘要比对；未知 mutation 不自动重试；
8. 结束时 Registry-first，删除 DNS/Droplet/bucket、撤销 Spaces key、销毁临时
   signing key、provider binding、临时 Keychain credential 和隔离 state；保留
   已保存的源测试 Key。

验证证据：

- P5 authorization 定向 Node：13/13；
- authorization 逐字节绑定 P5 preflight、P4 authorization 和 P4 acceptance；
- 负向覆盖生产/账号/设备扩张、Provider 请求/费用/credits、基础设施成本、
  生产 Trust mutation、rollback/cleanup/evidence 弱化；
- Validator 不具备 network、Keychain、Provider 或 subprocess capability；
- JSON、CLI 与 `git diff --check` 通过；
- 本轮 Provider 请求、credits、Keychain 读取、外部资源和费用均为 0；
- Kimi 继续按用户要求暂停，本轮为主 Agent 加强自主复核。

计划复盘与下一轮：

- P5 是 E1 隔离 canary，不关闭生产 R1-R3，不写 `canary_running` 或
  `canary_passed`；
- 下一步先冻结推送本 authorization，再只读确认专用账号订阅、Gemini credential
  ref、当前 Mac 和 Package baseline；
- 只有四项同时满足且仍在授权窗口/预算内，才允许创建 E1 资源；否则不产生费用。

### 循环 88：P5 E1 凭据来源只读纠正

状态：授权范围不变；外部执行仍未开始，等待纠正 commit 冻结推送

只读基线事实与修正：

1. 已推送授权 commit `bb5dfd9` 后检查默认 `~/.agentmesh360/state.db`，schema
   v10 可用，但账号作用域、Gemini Profile、Package Registry、Trust Cache 均为
   0；没有改写正常用户状态；
2. 产品 Keychain service `com.agentmesh360.client.provider` 不存在凭据项，而当前
   受控执行环境中的 `GEMINI_API_KEY` 存在；全过程没有读取、输出或落盘 secret；
3. 因此授权工件把凭据来源纠正为已保存的进程环境测试 Key，并固定只允许创建一个
   临时 canary Keychain credential 供客户端 Vault 使用；
4. 清场必须删除临时 Keychain credential、临时 binding 和隔离 state，同时保留
   源测试 Key；12 次、0 credits、Provider `$1`、基础设施 `$3`、1 账号、1 Mac、
   72 小时与禁止生产 authority 均未改变；
5. 正常状态库当前目录/文件权限为 `0755/0644`，记录为安全观察项；P5 不顺带修改
   用户正常状态，前后只比较 Package 摘要。

验证与下一步：

- 修正后的 authorization 定向 Node 13/13、CLI、JSON 和 `git diff --check`
  必须通过后冻结推送；
- 下一轮实现只输出计数、布尔值和 typed digest 的本机 baseline capture，校验
  当前 commit、窗口、单 Mac、源 Key 存在性与正常 Package 零变更；
- baseline 通过前不创建 DigitalOcean/Cloudflare 资源、不写 Keychain、不发起
  Provider 请求。

### 循环 89：P5 E1 本机 baseline capture

状态：工具、负向门禁与冻结 commit 上的真实只读 capture 已完成

已经实现：

1. 新增 `capture-local-canary-baseline.mjs`，执行前必须确认当前 HEAD 与本地
   `origin/main` 和显式 executor commit 三者一致，且工作区干净；
2. 固定授权窗口仍有效、cohort 恰为 1 账号/1 Mac、运行平台是 macOS、已保存
   `GEMINI_API_KEY` 满足基本凭据形态，但不记录值、片段或 digest；
3. 产品 Keychain 在装配前必须为空；工具只有只读探测能力，没有写入 Keychain、
   Provider 请求或网络能力；
4. 正常 `state.db` 必须是非 symlink、16 MiB 内 regular file，并通过 SQLite
   `immutable=1` / `query_only` 读取 schema、账号作用域计数、Provider Profile、
   Package Registry、Trust Cache 和 Registry Fetch 计数；
5. 正常 Package tree 只允许目录和 regular file，拒绝 symlink/特殊文件，读取
   上限 64 MiB；receipt 只保留 entry/byte count 与 typed tree digest；
6. capture 前后比较数据库 inode、size、mtime，任何变化立即阻断；正常状态目录和
   DB 当前权限是否收紧只作为布尔安全观察，不在 P5 顺带修改；
7. receipt 只能写到 `/private/tmp` 直接子文件，使用 exclusive create、`0600`、
   fsync；不保留路径、真实账号/设备标识、secret 或原始 Package/Trust 文档；
8. baseline 即使通过也固定 `cloudAssemblyAllowed=false`，下一道门仍是实时订阅
   复验与隔离客户端装配。

验证与计划复盘：

- P5 baseline + authorization 定向 Node 18/18；
- 全仓库 Node 在沙箱内 183/187，唯一 4 项旧 Origin 用例因禁止监听
  `127.0.0.1` 返回 `EPERM`；仅放开本机 loopback、无外部服务复跑后 187/187；
- 缺失源 Key、预存产品 Keychain 项、过期窗口、symlink 状态目录和秘密输出均
  fail-close；
- 本轮真实 Provider 请求、credits、Keychain 写入、Package mutation、外部资源和
  费用仍为 0；
- executor `a236a84...` 与 `origin/main` 一致且工作区干净后，真实 baseline
  capture PASS；源 Key present、产品 Keychain empty、正常 schema v10、
  Package/Profile/Trust count 均为 0，state 前后 unchanged；
- 脱敏 receipt 已固化为
  `docs/operations/tabletops/2026-07-29-p5-local-baseline.json`；临时原件只保留在
  本轮清场范围；
- 下一步规划隔离 state/临时 Keychain 装配与实时订阅复验；该门通过前仍不创建
  DigitalOcean/Cloudflare 资源。

### 循环 90：P5 E1 隔离客户端装配

状态：代码、冻结 commit 与本轮唯一真实隔离 boundary 装配完成

已经实现：

1. 新增桌面 `canary-runtime`，普通启动不改变 `userData`；只有精确
   `AGENTMESH360_P5_E1_CANARY=1`、授权 ID、executor commit 和固定
   `/private/tmp/agentmesh360-p5-e1-client` 同时匹配才启用；
2. boundary、`state`、`user-data` 必须是 `0700` real directory，marker 必须是
   4 KiB 内 `0600` regular file；symlink、group/other 权限或路径漂移均阻断；
3. marker 必须固定 `productionAuthorityGranted=false`、
   `normalStateReadable=false`、`keychainWritePerformed=false`、
   `networkRequestPerformed=false`、`packageMutationPerformed=false`；
4. 通过后仅在 Electron `app.whenReady` 前把 `userData` 切到隔离目录，同时
   `AGENTMESH360_HOME` 已被要求固定到 boundary 内 state；正常用户状态不会被
   canary Host 读取；
5. 新增 `prepare-isolated-client.mjs`，逐字节绑定 authorization 与已通过的
   baseline receipt，要求 HEAD/origin/main/executor 三者一致和 clean tree；
6. assembler 只创建一个 boundary、两个私有子目录和一个非秘密 marker，失败会
   删除本次部分装配；它不具备网络、Keychain、Provider 或 secret 能力；
7. 当前本机 Electron refresh-token 不存在，账号环境变量也不存在；管理控制面
   虽有登录态，但测试筛选没有证明已有且唯一的专用账号，因此禁止退化使用管理员
   个人账号，也不创建账号或修改订阅。

验证与计划复盘：

- P5 authorization/baseline/assembler 定向 Node 22/22；
- 全仓库 Node 在仅放开本机 loopback、无外部服务的复跑中 191/191；
- Desktop 105/105，另 3 项真实 Host 契约按既有环境门跳过；syntax check 通过；
- 本轮外部请求、Provider 请求、credits、Keychain 写入、Package mutation、云资源
  和费用仍为 0；
- 下一步先全量回归、提交并推送，再执行一次真实 boundary 装配；
- executor `308ee14...` 与 `origin/main` 一致且工作区干净后真实装配 PASS：
  boundary/state/userData 均为 `0700`、marker 为 `0600`，网络、Keychain 和 Package
  mutation 保持 0；
- 非秘密装配 receipt 已固化为
  `docs/operations/tabletops/2026-07-29-p5-isolated-client-assembly.json`；
- 下一步只在该 boundary 内构建隔离真实 Host，补跑 3 个真实 Host 契约并启动本地
  客户端登录页；实时订阅仍需专用内部测试账号登录态，未取得前不创建 E1 云资源，
  也不使用管理员个人账号替代。

### 循环 91：P5 E1 真实 Host 与专用账号登录门

状态：真实 Host/隔离客户端通过；当时误把不存在的专用内部测试账号当成待登录资产，
Cycle 92 已纠正并中止

已经完成：

1. 在隔离 boundary 内为 `308ee14...` 创建 detached worktree，Cargo target 同样
   固定在 boundary；仓库根 `target/` 始终 absent；
2. 首次沙箱构建被上游 `protoc` 写 `/dev/stdout` 的 `EPERM` 阻断；无源码错误，
   放开本机构建沙箱后复用缓存成功，未访问 Provider 或云资源；
3. 生成 arm64 `grok 0.2.106 (308ee14)` debug Host，二进制 byte count 与 typed
   digest 已固化；约 10 GiB build cache 仅在可销毁 canary boundary 内；
4. 补跑此前条件跳过的 3 个真实 Host 契约全部通过：
   active/expired subscription 双门、Session Plan/后台任务 replay、持久 Leader
   detach/replacement；
5. 使用固定 P5 flag、authorization ID、executor、隔离 state/userData 与真实 Host
   启动 Electron，真实显示 AgentMesh360 登录页；
6. canary userData 中 refresh token absent，产品 Provider Keychain 仍 empty；
   因此启动没有自动访问生产 Core，也没有 Provider/Package mutation；
7. 管理端只有管理员登录态，测试账号筛选没有提供专用账号客户端凭据；禁止读取
   管理员 token、推断密码、创建账号、修改订阅或改用管理员个人账号。

验证与计划复盘：

- 真实 Host 3/3，隔离客户端登录页可见；非秘密 prelogin receipt 见
  `docs/operations/tabletops/2026-07-29-p5-real-host-prelogin.json`；
- Provider 请求 0/12、AgentMesh credits 0、Provider 费用 `$0/$1`、云资源
  `0`、基础设施费用 `$0/$3`；
- 不能要求用户登录一个不存在的专用内部测试账号，也不能用管理员个人账号替代；
- Cycle 92 已停止该客户端并销毁隔离 boundary；必须先取得新的账号策略授权，才能
  决定是否重新进入 P5。

### 循环 92：P5 E1 错误前提纠正、中止与清场

状态：P5 E1 已在订阅复验前中止；隔离运行态和约 10 GiB 临时构建均已清理，
正常 Package 状态复验未变

纠正事实：

1. 用户明确指出当前并不存在“专用内部测试账号”；Cycle 87 authorization 中
   `existing_dedicated_internal_account` 是执行方把目标条件误当成现有资产；
2. 历史 authorization 与 prelogin evidence 保留，不回写伪造历史；新增
   `2026-07-29-p5-e1-abort.json`，将其标记为
   `aborted_missing_prerequisite` 并取代原执行指引；
3. 原授权禁止创建账号和修改订阅，因此不能自行补建账号，也不能使用管理员个人
   账号绕过 cohort 边界。

清场与复验：

- 已停止隔离 Electron，进程列表中无 P5 Electron 或 Host 残留；
- detached worktree、隔离 boundary、临时 baseline 原件和约 10 GiB Cargo
  build cache 均已删除；仓库根 `target/` 仍 absent；
- 正常 `state.db` 仍为 schema v10，账号作用域、Provider Profile、Package
  Registry、Trust Cache、Registry Fetch 计数均为 0；
- 产品 Provider Keychain 项仍 absent；Keychain 写入、Package/账号/订阅 mutation、
  Provider 请求、AgentMesh credits、云资源、费用和生产 mutation 均为 0；
- Kimi 继续按用户要求暂停；本轮执行完整状态复验、证据/diff/secret 检查，由主
  Agent 加强自主复核。

计划复盘与下一轮：

- P0-P4 的完成状态不变，P5 未通过且不得进入 P6；
- 下一步不是继续登录或创建云资源，而是先取得新的账号策略授权并准备真实存在的
  专用测试账号及有效订阅；
- 未获新授权前，不创建账号、不修改订阅、不使用管理员个人账号、不重建 P5 E1
  release chain。

### 循环 93：P5 E1 owner 线上账号 v2 重新授权

状态：账号范围已重新授权并实现 fail-close 授权链；尚未登录、读取订阅或产生费用

已经实现：

1. 用户直接授权 P5 使用其现有线上账号；仓库只保存
   `p5-owner-online-account-01` 脱敏 alias，不保存邮箱或真实账号 ID；
2. 新增 strict `agentmesh360-package-canary-authorization-v2` 与独立 v2 receipt，
   逐字节绑定旧 v1 authorization 和 Cycle 92 abort receipt；
3. v2 固定原单账号、单 Mac、72 小时停止点、Gemini BYOK 12 请求、Provider `$1`、
   基础设施 `$3`、AgentMesh credits 0 和零生产 authority；用户允许使用 credits
   不等于必须消耗，当前 happy path 仍默认 BYOK；
4. 历史 v1 与 abort 不修改；v2 明确 `priorAuthorizationReusable=false`，禁止把
   旧批准卡直接复活；
5. baseline capture 自动按 schemaVersion 选择 v1/v2 Schema；v2 额外绑定 prior
   authorization/abort 字节；
6. 隔离客户端 assembler 只接受 v2 和与其逐字节匹配的新 baseline；v1 即使配套
   旧 baseline 也 fail-close；
7. Electron canary marker 升级到 schema v2、authorization `...0002` 和 boundary
   `...-02`；普通客户端启动路径不变；
8. 首次真实 v2 baseline capture 在零 mutation 下发现 receipt ID 仍沿用 v1；
   已阻断该 receipt，改为按 authorization schema 生成 `...baseline...0002`，
   禁止 v1/v2 证据编号碰撞。

验证与计划复盘：

- P5 authorization/baseline/assembler：23/23；
- Electron canary runtime：4/4；Desktop 全套：105/105，3 项真实 Host 环境门跳过；
- v2 CLI、JSON、历史证据 digest、diff 检查通过；
- 本轮账号登录、Core/Provider 请求、credits、Keychain 写入、Package mutation、
  云资源和费用仍为 0；
- 下一步先提交推送本 v2 freeze，再在 clean executor 上重做正常状态只读 baseline
  和隔离装配；实时订阅双门前仍不创建云资源。

### 循环 94：P5 E1 owner 账号只读 baseline

状态：冻结 v2 上的真实 baseline capture 已通过；receipt 等待提交推送

执行与证据：

1. executor `232818e...` 与 `origin/main` 一致且工作区 clean；
2. 首次命令因手工提供的完整 commit 与真实 HEAD 不一致而 fail-close，未生成输出；
   使用 Git 返回的精确 40 位 commit 后重新执行通过；
3. receipt ID 为 `package_canary_e1_local_baseline_20260729_0002`，authorization
   与 v2 receipt 字节摘要匹配；
4. 源 Gemini 测试 Key present，但未读取、输出或保存其值；产品 Provider Keychain
   在装配前仍 empty；
5. 正常 state 仍为 schema v10，账号作用域、Provider Profile、Package Registry、
   Trust Cache 和 Registry Fetch 均为 0，Package tree absent；
6. capture 前后正常状态未变化；账号/订阅 mutation、Keychain 写入、Provider
   请求、credits、Package mutation、云资源、费用和生产 mutation 均为 0；
7. 临时 `0600` 原件与入库 receipt 逐字节相同，未保留邮箱、真实账号 ID、路径或
   secret。

计划复盘与下一轮：

- baseline 只关闭本机只读前置门，不代表实时订阅通过或 P5 通过；
- 下一步提交推送 receipt，在新的 clean executor 上运行 v2 assembler；
- 隔离客户端先验证线上账号登录与 Core/Host 双 active，之后才允许临时 BYOK
  Keychain 装配或 E1 云资源。

### 循环 95：P5 E1 v2 隔离客户端、真实 Host 与 owner 登录门

状态：v2 隔离客户端与真实 Host 已通过；“等待 owner 输入密码”已由 Cycle 96
纠正为客户端 OAuth 能力缺口

已经完成：

1. baseline receipt `1bc4bb2...` 推送后，在 `/private/tmp` 重建唯一 v2 boundary；
   boundary/state/userData 为 `0700`，marker 为 `0600`，authorization/boundary
   分别为 `...0002` / `...-02`；
2. 使用同一冻结 commit 创建 detached worktree，Cargo target 固定在 boundary；
   仓库根 `target/` 始终 absent；
3. 冷构建约 5 分钟，生成 `grok 0.2.106 (1bc4bb2)` dev Host，435,634,896 bytes，
   typed digest 已写入非秘密 evidence，约 10 GiB 缓存只保留在可销毁 boundary；
4. 首次真实 Host 全套测试的 3 项只因沙箱禁止监听 `127.0.0.1` 返回 `EPERM`；
   仅放开本机 loopback 后 108/108 全通过，包括 subscription、Session replay 和
   persistent Leader recovery；
5. 隔离 Electron 已显示正确的源码登录页；系统中另有旧打包版 AgentMesh360，
   已按完整 Electron app path 区分，避免在错误窗口登录；
6. 用户明确授权的 owner 邮箱已填入隔离窗口，但仓库/evidence 不保留邮箱；
   密码框仍为空，自动化没有读取或输入密码，也没有提交登录。

当前边界：

- canary refresh token absent，产品 Provider Keychain absent；
- Core 请求、Provider 请求、credits、Keychain 写入、Package/账号/订阅 mutation、
  云资源、费用和生产 mutation 均为 0；
- owner 账号由 Google OAuth 创建，没有可供当前邮箱密码页提交的现成密码；
- 下一步必须先补齐并发布 Google/GitHub 桌面 OAuth，不能要求用户寻找不存在的密码；
- 登录结果由 Core/Host 双重返回 active 前，不装配临时 BYOK，不进入 E1
  Trust/Release/Origin。

### 循环 96：Google/GitHub 桌面 OAuth 根因修复

状态：Core 与 Client 实现、全量测试和登录页视觉检查通过；Client 提交 `8545bc1`
已推送 `main`，Core 提交 `1b6e34f` 先经非生产分支冻结，随后已受控合并、部署并
完成共享产品回归；真实登录结果见 Cycle 97

根因与计划纠正：

1. 生产 Core 的 Google/GitHub OAuth 成功后只把 token pair 写入官网同源
   `localStorage`；桌面客户端仅实现 `/v1/auth/login` 邮箱密码接口；
2. owner 线上账号通过 Google OAuth 创建，没有必须存在的登录密码；Cycle 95
   把“使用该账号”误解为“填邮箱密码”，属于产品缺口，不是用户准备问题；
3. 既定 P5 原范围曾明确“不实现 OAuth”，但真实 owner 登录暴露其为订阅验收的前置
   能力。按用户明确纠正，当前只补身份链路，不扩展 Host、Provider、Package 或 credits。

已经实现：

1. Core OAuth start 新增 `client=desktop` 分支，只接受 `127.0.0.1` / `::1`
   随机端口、随机 callback path、客户端 state 与 S256 PKCE challenge；
2. Google/GitHub 回调成功后生成 90 秒一次性 code，只保存 SHA-256 摘要并绑定用户、
   精确 loopback 与 challenge；浏览器 URL 不含 Access/Refresh/Provider token
   或 verifier；
3. 公开 exchange 不嵌入桌面 client secret，错误 verifier 不消费 code，正确兑换
   原子消费并拒绝重放；
4. Electron 主进程启动本机 loopback listener，以固定 Core HTTPS URL 打开系统
   浏览器；Renderer 只提交 `google` / `github` Provider ID，永远不接触 code、
   verifier 或 token；
5. 登录页加入 Google/GitHub 主入口，并保留邮箱密码兼容路径；旧隔离 Electron
   已停止，约 10 GiB Host build 缓存保留供新提交最终 canary 复用。

验证与计划复盘：

- Core 定向 OAuth/原产品登录交接 10/10，全量 300 passed / 3 skipped；共享产品注册表
  静态 4/4，Ruff、格式和 diff 检查通过；
- Desktop OAuth/identity/Core-client 23/23；复用隔离真实 Grok Host 后全套
  117/117，subscription、Session replay 与 persistent Leader recovery 均真实通过；
- Electron 登录页视觉 smoke 确认 Google/GitHub、邮箱密码和订阅提示均正确显示；
- Core 构建 run `30423443698`、首次部署 run `30423443686` 通过；并发产品合并后的
  中间部署 `30423565215` 因目标 image 不存在且 fallback 与锁定输入不一致，在部署
  前失败关闭；镜像锁定修复后最终 run `30423914020` 通过；
- 最终生产 commit 为 `0ba3db3`，共享产品 live regression 20/20；Cycle 96 的
  “生产未发布”边界已经关闭；
- 本循环仍未执行 Provider 请求、credits、Package/账号/订阅 mutation、云资源或
  费用；随后按计划回到 P5 owner 登录门。

### 循环 97：P5 owner Google 登录、订阅与加密恢复

状态：真实 Google OAuth、Core/Host 双 active 与新进程恢复均通过；P5 下一门为
Gemini BYOK 主路径

执行与证据：

1. 使用官方 assembler 在新冻结 commit `19e9121...` 上重建唯一 v2 boundary，
   detached worktree、Cargo target 和约 10 GiB 构建缓存均保留在可销毁隔离目录；
   仓库根 `target/` absent；
2. 构建 `grok 0.2.106 (19e9121)` dev Host，435,634,896 bytes，SHA-256 为
   `7828dcdc...17db`；首次构建只因沙箱禁止 `protoc` 写 `/dev/stdout` 失败，使用
   相同输入在允许该本机构建动作的边界内重跑成功；
3. 三项真实 Host 合同 3/3：subscription state、Session replay 和 persistent
   Leader recovery 均通过；
4. 隔离客户端使用系统浏览器完成用户授权的 Google 账号登录；未出现新的权限同意
   页面，Core 与 Host 返回 `ready` / `active_subscription`，可进入客户端，并加载
   3 个当前产品 Agent；
5. Refresh Token 只通过 Electron `safeStorage` 写入操作系统凭据存储；证据仅记录
   backend、文件模式和布尔状态，不读取或保存明文、密文、真实邮箱、余额或 URL；
6. 关闭首进程后由新进程只依赖加密 Refresh Token 恢复，同样得到 `ready`、
   `active_subscription`、可进入客户端和 3 个 Agent；
7. 非秘密 receipt：
   `docs/operations/tabletops/2026-07-29-p5-owner-account-oauth-active.json`。

验证与计划复盘：

- Desktop OAuth/identity/Core-client 23/23；完整 Desktop + 真实 Host 117/117；
  新 boundary 三项真实 Host 3/3；
- 生产 Core 最终部署 run `30423914020` 通过，最终全产品 live regression 20/20；
- 本门 Provider 推理 0、AgentMesh credits 0、Provider/基础设施费用 0，
  Package/账号/订阅 mutation 0；
- 真实 Google 登录证明登录方式缺口已经关闭，邮箱密码只保留兼容入口，不再作为
  owner 账号 P5 前提；
- 下一轮严格进入已批准的 Gemini BYOK happy path；不提前创建 E1 云资源、不进入
  Package release chain，也不扩大账号、设备、请求次数或费用上限。

### 循环 98：P5 owner Gemini BYOK、选路与恢复

状态：真实 BYOK happy path、Provider 失败关闭与新进程恢复均通过；临时主 Profile、
Assignment、Binding 和系统凭据保留给 P5 后续门，完整 canary 尚未完成

执行结果：

1. 在已通过 OAuth/订阅的隔离客户端中，从受控进程环境读取已批准测试 Key；Key
   只经主进程传给 Host，未打印、写入仓库、进入 SQLite 或留存 evidence；
2. 创建 `google-gemini` / `gemini-3.5-flash-lite` Profile 和 global `main`
   Assignment；本地 Vault Probe 通过且零网络；
3. 未确认付费的 minimal inference 返回 `confirmation_required` 且零网络；
   未启用模型在请求前拒绝；
4. 明确确认后，官方 Gemini minimal inference 返回非空响应；
5. 一个产品 Agent 的固定 Main Session 完成真实短 Turn，Host 的 Turn Route 精确记录
   所选 Provider、Preset 与模型；Prompt 和响应不进入证据；
6. 无效测试凭据向官方端点失败，未发生 fallback；隔离 loopback 429 同样返回固定
   失败并无 fallback；两个故障 Profile 与临时凭据随即删除；
7. 新 Electron 进程恢复 active 订阅、唯一 Profile/Assignment、系统加密凭据、
   固定 Main Session 历史与同一 Turn Route；恢复检查只执行零网络 Vault Probe，
   未增加 Provider 推理；
8. 非秘密 receipt：
   `docs/operations/tabletops/2026-07-29-p5-owner-account-byok-active.json`。

预算、复核与边界：

- 推理操作 4 次：3 次外部 Provider 尝试（含 1 次无效凭据）和 1 次本机 429 fault；
  低于 12 次上限；客户端不提供 Provider 费用实时报表，因此只记录未观察到 `$1`
  cap breach，不虚报精确费用；
- AgentMesh credits 0，基础设施费用 0，Package/账号/订阅 mutation 0；
- 隔离 state 当前 1 Profile、1 Assignment、1 Binding、1 Turn Route、6 Probe；
  1 个 Agent 为 running、2 个 inactive，仓库根 `target/` absent；
- Provider/P5 定向 42/42、两份临时脚本语法、源 Key 值不在脚本中的扫描均通过；
- Kimi 仍按用户要求暂停，本轮由主 Agent 完整复核，不冒充独立审查；
- 下一轮进入授权内的 frozen E1 Release Chain 重建与唯一隔离 staging；仍不复用生产
  Droplet/Trust，不改生产常量，不推进 P6。P5 结束前必须删除临时 Profile/Binding/
  Keychain 凭据并销毁隔离状态，保留源测试 Key。

### 循环 99：P5 E1 Release Chain 无网络预检

状态：冻结提交上的真实预检已通过；尚未生成签名 key、构建 Release Set 或创建云资源

实现与执行：

1. 新增 `tools/package-canary-e1/prepare-release-chain.mjs`，只读取冻结仓库、P5 v2
   授权、OAuth 与 BYOK 非秘密证据，不具备网络、Provider、Keychain 或云 mutation
   能力；
2. 预检要求 `HEAD`、`origin/main` 与传入的 40 位 commit 完全一致、工作区 clean、
   授权处于精确 72 小时窗口、仓库根 `target/` absent、生产 Trust/Registry 常量为空；
3. 固定两代全新临时 Root/Publisher、四 Agent baseline、Job 同权限与权限扩张版本、
   21 项场景、Registry-first 清场、`$3` 基础设施硬上限和 P6 关闭状态；
4. 首次手工输入错误完整 commit 被写文件前阻断；读取 Git 返回的精确 commit 后，
   冻结并推送的 `7a46455124edf28efe397f45605d31240403b813` 真实预检通过；
5. 临时原件权限为 `0600`，入库 receipt 不含凭据、资源 ID、endpoint、账号标识、
   绝对路径、Prompt 或响应。

验证与计划复盘：

- 定向 17/17；完整 Node 310 passed / 3 skipped / 0 failed；
- `node --check`、`git diff --check` 与敏感模式扫描通过；
- Kimi 仍按用户要求暂停，本轮由主 Agent 完整 diff、负向矩阵和计划边界复核；
- 本轮网络、Provider 推理、AgentMesh credits、Keychain 写入、Package mutation、
  云资源和新增费用均为 0；
- 预检只允许进入执行器实现，不等于 Release Chain、21 场景或 P5 完成。下一轮先
  实现并冻结 P5 专用 Release/场景/清场执行器，冻结前不得创建 DigitalOcean、
  Spaces 或 Cloudflare staging。

### 循环 100：P5 双代 Release Builder

状态：源码、负向测试、完整回归和冻结推送完成；尚未生成本轮 Publisher key 或运行构建

已经实现：

1. P3/P4 的确定性双构建器增加受限 `p5-job-variants` 计划；默认四 Agent 行为不变，
   该计划只允许在保留式 E1 隔离边界中调用；
2. Generation A 固定 Deploy `0.1.1`、Future `1.0.0`、Job `0.4.7` 和
   LectureCast `0.4.0`；Generation B 固定 Job `0.4.8-e1.1` 与 `0.4.9-e1.1`；
3. 同权限版本保持四项原权限，权限扩张版本只增加 `process_execution`；variant
   definition 只写可销毁边界，不修改源仓或冻结 candidate；
4. 两代各使用一个不同的临时 Publisher；每个版本独立双构建、双签名并逐字节比较
   artifact、Envelope、receipt、Host bundle/projection、file manifest、Registry
   record、Release Manifest、signature result 和 signing request 共 10 类输出；
5. 任一代失败或最终状态写入失败，会先销毁此前已生成的 Publisher 私钥，再移除隔离
   build/worktree 边界；状态文件只能写入固定 `/private/tmp` P5 路径；
6. Builder 只接受 P5 专用 DNS-only Origin、一台 Droplet、两个 Spaces bucket、
   clean pushed executor 和 Cycle 99 preflight ancestor；不具备创建云资源的能力。

验证与计划复盘：

- 新增定向 6/6；完整 Node 316 passed / 3 skipped / 0 failed；
- 语法、diff、固定路径、秘密模式和 P3/P4 回归检查通过；
- 提交 `6a7fded feat: build p5 two-generation release chain` 已推送 `main`；
- Kimi 继续按用户要求暂停，本轮由主 Agent 复核失败清理、权限差异和旧路径兼容；
- 本轮没有运行真实 Builder，因此新增签名 key、Package mutation、网络、Provider、
  credits、云资源和费用均为 0；
- 下一轮实现并冻结 P5 专用 Droplet/Spaces/DNS/Origin 执行器。该执行器通过完整
  回归前仍不创建 staging，之后才运行本 Builder、发布和 21 场景。

### 循环 101：P5 隔离基础设施边界执行器

状态：源码、负向测试、完整回归和冻结推送完成；尚未创建本轮 Droplet、Spaces
bucket 或 Cloudflare DNS

已经实现：

1. 新增 P5 专用基础设施执行器，固定 `/private/tmp` 下唯一 `0700` 边界、`0600`
   状态/凭据、SGP1、`s-1vcpu-1gb`、Ubuntu 24.04、单 Droplet、双 Spaces bucket
   与单 DNS-only 记录；
2. P4 Spaces SigV4 client 与 Origin 配置解析只扩展到独立 `am360-p5-e1-*`
   namespace；P4 原 namespace 与 principal binding 保持兼容，P4/P5 混用会
   fail-close；
3. `probe-spaces`、`prepare`、`create`、`record-dns` 都必须绑定仍有效的 72 小时
   v2 授权、授权文件逐字节摘要、clean pushed executor 与 Cycle 99 preflight
   ancestor；只有 `destroy` 可在授权过期或工作区变化后继续调用；
4. Droplet 创建前先落盘 cleanup receipt；创建返回异常、ID 输出异常或后续验证失败
   时，可按专用 tag 与精确名称重新发现资源。销毁只接受匹配 ID/名称，并要求专用
   tag 最终清零；
5. cloud-init 禁止 root/password 登录，只安装 Origin 所需最小依赖并启用
   22/80/443 防火墙；不启用 backups/monitoring，临时 SSH 私钥在销毁时覆写并删除；
6. Cloudflare 不由脚本持有 API token；执行器只接受由已认证控制面写入的固定
   `0600` DNS receipt，且必须与 Droplet IPv4、DNS-only、TTL 60 和固定 hostname
   完全一致；
7. 授权停止点写入 prepared state；过期后任何新 probe、创建或 DNS 绑定都被阻断，
   但清理通道保持可用。

验证与计划复盘：

- P5 基础设施与共享 Spaces 定向 15/15；完整 Node 325 passed / 3 skipped /
  0 failed；
- 语法、diff、P4/P5 namespace、凭据/邮箱/私钥模式扫描通过；
- 提交 `eb6a6fd feat: gate p5 isolated infrastructure` 已推送 `main`；
- Kimi 仍按用户要求暂停，本轮由主 Agent 复核授权时窗、孤儿资源恢复、tag 清零、
  P4 兼容和销毁路径；
- 本轮只冻结执行器，没有创建 Droplet、bucket、DNS 或密钥，没有 Provider 请求、
  credits、Package/Keychain mutation 或新增费用；
- 下一轮按序实现并冻结 P5 Origin 部署与发布适配；在该模块完成回归前不调用本轮
  云 mutation 动作。之后才创建唯一 staging、运行双代 Builder、Registry-last
  发布、21 场景和 Registry-first 清场；P6 继续关闭。

### 循环 102：P5 隔离 Origin 部署适配

状态：源码、测试、完整回归和冻结推送完成；尚未连接或部署云端 Origin

已经实现：

1. 复用 P4 已验证的 SSH、Caddy、systemd、DNS/HTTPS 等待和 fault-token 探针，
   但引入显式 `p4` / `p5` scope；默认 P4 CLI 不能误入 P5；
2. P5 wrapper 不接受 boundary 或 credentials 参数，只能使用固定
   `/private/tmp/agentmesh360-p5-e1-infrastructure` 和 P5 Spaces 凭据；
3. 部署前再次验证 v2 授权摘要与 72 小时时窗、clean pushed executor、
   Cycle 99 preflight ancestor、单 Droplet/双 bucket/单 DNS、DNS-only、TTL 60、
   hostname/IP/suffix 和未到期的自动销毁时间；
4. P4/P5 共享 Origin 只接受各自 bucket、Droplet 和 hostname namespace；
   P4 行为保持原 live-state 覆写，P5 则从 `dns-state.json` 生成一次性的
   `origin-state.json`，防止跨阶段状态被静默改写；
5. P5 `origin-state.json` 继续保留在 `0600` 隔离边界，fault token 和只读
   Origin principal 不进入仓库或输出；Renderer、Provider、生产 Trust/Registry
   不参与该路径；
6. 基础设施 receipt 补齐不可延长停止点的 live/DNS 逐阶段传递，清理入口仍可在
   授权到期后执行。

验证与计划复盘：

- P5 Origin/基础设施与 P4 回归定向 27/27；完整 Node 329 passed / 3 skipped /
  0 failed；
- 语法、diff、固定路径、namespace、邮箱/API key/私钥模式扫描通过；
- 提交 `9f25c2e feat: adapt p5 isolated origin deployment` 已推送 `main`；
- Kimi 继续按用户要求暂停，本轮由主 Agent 复核 P4 兼容、授权时窗、DNS/HTTPS
  fail-close、状态单写和远端失败后的可清理性；
- 本轮没有运行 wrapper，因此 Droplet/Spaces/DNS/Origin 连接与 mutation、Provider、
  credits、Package/Keychain mutation 和新增费用均为 0；
- 下一轮按序实现并冻结 P5 双代 Registry-last 发布器；在完整回归前仍不创建
  staging。随后才进入真实基础设施、Builder、发布、21 场景和清场；P6 关闭。

### 循环 103：P5 双代 Registry-last 发布器

状态：源码、负向测试、完整回归和冻结推送完成；尚未生成本轮 Root key 或上传对象

已经实现：

1. P4 已验证的 canonical Registry、Trust、Ed25519、对象摘要、SigV4 PUT/GET
   readback 原语开放为共享内部能力；P4 CLI、四 Agent 和 14 项 fault matrix 行为
   保持不变；
2. P5 publisher 只接收 frozen executor commit，固定读取 P5 Origin、
   Release Chain、Spaces 凭据和唯一 publication state；再次验证 v2 时窗、
   clean pushed executor、空生产常量、两代双构建和隔离边界/私钥模式；
3. Generation A 固定 Root A / Publisher A / Trust sequence 1 / Registry
   revision 1；Generation B 的两个 Job 版本对象与 baseline 一同按不可变路径准备；
4. Publisher overlap、Publisher A revoke 和 Root B rotation 分别使用 Trust
   sequence 2/3/4；同权限、权限扩张、Publisher revoke 和 Root rotation 分别使用
   Registry revision 2/3/4/5，禁止把轮换与撤销混成同一个状态；
5. Registry 每个 package ID 只能出现一次，因此同权限与权限扩张是两个独立
   Job record snapshot，而不是在同一 Registry 中并列同 package 的多个版本；
6. canonical Trust 先发布，六个版本的不可变 Release 对象和受 fault token 保护的
   transition 文档随后发布，`metadata/registry.v2.json` 必须最后上传并 readback；
7. Origin fault allowlist 从 P4 的 14 项扩展到 21 条路由，新增同权限、权限扩张拒绝/
   批准、Root rotation、Publisher rotation/revoke 与 Registry withdrawal；旧 14
   项顺序和 runner 不变；
8. publication state 在生成 Root 前先落盘两个固定私钥目标；任何中断都留下完整
   planned object/root/publisher 清理线索，且 Release 文件/状态 symlink 被拒绝。

验证与计划复盘：

- P5 publisher 与共享 Registry 定向 10/10，Origin 路由联测 15/15；完整 Node
  335 passed / 3 skipped / 0 failed；
- 语法、diff、固定路径、单调序列、Registry-last、邮箱/API key/私钥模式扫描通过；
- 提交 `1e56f6b feat: publish p5 two-generation release chain` 已推送 `main`；
- Kimi 继续暂停，由主 Agent 复核 package ID 唯一性、Root/Publisher 独立迁移、
  中断恢复、symlink 边界和 P4 兼容；
- 本轮没有运行 publisher，因此新增 Root/Publisher key、Spaces 上传、网络、
  Provider、credits、Package/Keychain mutation、云资源和费用均为 0；
- 下一轮按序实现并冻结 21 项场景执行器与 Registry-first 清场执行器。两者完整
  回归通过后，才进入真实 staging 执行；P6 关闭。

### 循环 104：P5 21 场景、隔离 Client 升级与 Registry-first 清场

状态：源码、自主复核与完整回归完成；尚未升级保留式 Host、创建 staging、生成本轮
Root/Publisher、上传对象或执行真实场景

已经实现：

1. 正式 Host 新增严格 P5-only Package runtime：只有固定环境变量、固定 `0700`
   隔离目录、`0600` 配置、v2 授权 ID、不可延长停止点、DNS-only E1 hostname、
   两把指定测试 Root 和固定 fault 场景同时匹配时，才注入测试 Trust/Registry；
   生产 Root、Trust Bundle URL 与 Registry URL 常量继续为空；
2. Registry 与 Artifact 下载复用真实签名、单调序列、摘要、MIME、大小、超时和
   no-redirect 校验；中断安装只替换受 fault token 保护的传输目标，不放宽已签名
   Release URL 或生产 Origin；
3. Electron 驱动器复用已加密恢复的 Google OAuth owner 账号，要求 Core、Host、
   subscription 三者均为 active；14 项场景走真实 Host，包括 Future Agent 新装、
   Job baseline、同权限更新、权限扩张拒绝/批准、截断传输、篡改、Registry 回退、
   Trust 过期、Package rollback、Skill 投影、Publisher/Root 轮换和 Registry 撤回；
4. 最终 21 项矩阵由 14 项 live Host、2 项订阅/跨账户契约、4 项已通过的真实 BYOK
   与失败关闭证据、1 项执行前合成预算超限门组成；本轮执行器不再发 Provider 请求，
   预算保持 4/12、AgentMesh credits 0，且不记录邮箱、余额、Key、Prompt 或响应；
5. 保留式隔离 Client 升级器只接受 clean pushed 后继 commit，拒绝 source/build
   symlink 或路径漂移；先在固定 build 目录完成正式 Host 构建并核对版本 commit，
   再原子更新 marker，保留加密 Refresh Token、BYOK 绑定和 Agent 状态；
6. Registry-first 清场器必须先 DELETE/HEAD/public HTTPS 复验 Registry 404，再按
   反序删除并复验所有对象，随后经隔离 signer 销毁两把 Root 与两把 Publisher 私钥；
   清场授权不因 72 小时窗口结束而失效，但凭据、Bucket、Origin、场景回执、Signer
   和授权文件的全部传递依赖必须仍是当前已推送版本；
7. 清场第一段完成后只允许继续删除 Cloudflare DNS、Droplet、Spaces bucket/临时
   principal、临时 BYOK Profile/Assignment/Binding/Keychain 凭据和整个隔离 Client；
   只有这些均销毁并保留非秘密证据后，P5 才能关闭。

自主测试与复核：

- P5 新执行器定向 Node 17/17；完整工具链 Node 238/238；
- Desktop 114 passed / 3 skipped / 0 failed；Google/GitHub OAuth 的 PKCE、
  loopback callback、state mismatch、取消、超时和并发门均通过；
- Rust P5 runtime 2/2，另有 5,994 项非目标测试被过滤；`cargo fmt --check` 与
  正式 lib `cargo clippy -- -D warnings` 通过；
- 自审先后修复无效 Ed25519 测试公钥、仅在 `cfg(test)` 可用导致正式 Host
  编译失败的 Root 构造器，以及 retained build symlink/清场传递依赖未完全锁定；
- 仓库根 `target/` absent，Node 语法、`git diff --check` 通过；Kimi 继续按用户
  要求暂停，本轮为主 Agent 完整 diff、负向边界与正式构建自主复核。

计划复盘与下一轮：

- 与产品蓝图和 P5 预检的 21 项顺序一致；没有引入第二套 Harness、第二套 Package
  校验栈或生产 Trust，也没有把历史 evidence 冒充全部 live 场景；
- 本轮新增云资源、签名 key、Spaces 对象、Package mutation、Provider 请求、
  AgentMesh credits 和费用均为 0；
- 下一轮只执行已冻结顺序：提交并推送 Cycle 104，升级保留式隔离 Client，创建唯一
  DigitalOcean/Spaces/Cloudflare staging，运行双代 Builder、Registry-last 发布和
  21 场景；通过后立即进入 Registry-first 全清场。P6 继续关闭。

### 循环 105：P5 staging hostname 执行值纠偏

状态：云资源创建前 fail-close；hostname 已与既定基础设施契约统一，等待冻结推送后
重新升级隔离 Host

执行前复核与修复：

1. Cycle 104 提交推送后，保留式隔离 Client 已成功从 `19e9121...` 升级到
   `f66ae01...`；正式 Host 版本为 `grok 0.2.106 (f66ae01)`，marker 原子前移，
   state/userData 和加密 OAuth/BYOK 状态保留，凭据未读取；
2. 第一项 Spaces 权限探针因固定 P5 凭据文件尚不存在而在网络请求前失败关闭；没有
   创建 Bucket、Droplet、DNS、key、对象或费用；
3. 准备进入 DigitalOcean 已登录控制台前，对实际基础设施 state 值再次对账，发现
   既定 Origin 为 `packages-p5-e1-<suffix>.agentmesh360.com`，而 Cycle 104 的
   Host runtime、Electron driver 和场景编排器误写为 `packages-e1-<suffix>`；
4. 三层消费者和测试夹具现已统一为精确 P5 hostname；不扩大到 P4 hostname、
   production hostname、任意端口、query、fragment 或 redirect，生产常量仍为空；
5. 该错误若未纠正会在真实 Host 前正确 fail-close，但会造成已创建 staging 的无谓
   清理；本轮在第一个付费/外部资源 mutation 前发现并关闭。

验证与计划复盘：

- hostname/基础设施/发布/场景定向 Node 21/21；Rust P5 runtime 2/2；
- Node 语法、`git diff --check`、仓库根 `target/` absent；
- Kimi 继续暂停，本轮由主 Agent 对基础设施 state、Origin/publisher、Electron
  input 与 Rust exact-origin 做逐值对账；
- 下一步提交推送本纠偏，删除旧的非秘密 advance 临时 receipt，再把同一隔离 Client
  和 Host 前移到新提交；之后才创建两个 P5 Bucket、两组 bucket-scoped key、唯一
  Droplet 与 DNS。21 场景和 Registry-first 清场顺序不变，P6 关闭。

### 循环 106：P5 Spaces 与最小权限 principal 实际落地

状态：两个 P5 隔离 Bucket、两把 bucket-scoped Key 和真实权限探针已通过；尚未创建
Droplet、DNS、Origin 对象、测试 Root/Publisher 或 Package

实际执行：

1. 在 DigitalOcean `SGP1` 创建
   `am360-p5-e1-releases-9aa7c042` 与
   `am360-p5-e1-metadata-9aa7c042`；两者均为 Standard Storage、CDN 关闭，
   未触碰两个处于待删除状态的 P4 Bucket；
2. 创建 `am360-p5-e1-publisher-9aa7c042`，只绑定上述两个 Bucket，权限为
   Read/Write/Delete；创建 `am360-p5-e1-origin-9aa7c042`，只绑定上述两个
   Bucket，权限为 Read；
3. Access ID/Secret 只经已登录控制台进入固定
   `/private/tmp/agentmesh360-p5-e1-spaces-credentials.json`，文件模式为 `0600`；
   未输出秘密、未写仓库、未写项目文档；
4. 首次 Origin Key 生成期间，控制台仍展示上一把 Publisher Secret；执行器用
   `SignatureDoesNotMatch` 在 Origin read 阶段失败关闭，Publisher 创建的探针对象
   仍由 `finally` 清除，未进入 Droplet/DNS/发布阶段；
5. 经用户动作前确认后只轮换该 Origin Key；新 Access ID 与 Secret 均不同于旧值，
   Key 名称、两个 Bucket scope 和 Read-only 权限保持不变；
6. 再次运行冻结的 `probe-spaces` 真实通过：Publisher write/read/delete 成功，
   Origin read 成功且 write 得到预期拒绝；探针对象已删除。

自主验证与计划复盘：

- `infrastructure-boundary.mjs probe-spaces` 基于 clean pushed executor
  `1b963e8...` 通过；凭据文件、隔离基础设施目录和 Cloudflare receipt 的固定路径
  与 Cycle 101 契约一致；
- 当前新增外部状态只有两个 P5 Bucket 和两把 limited Key；Droplet、DNS、Spaces
  正式对象、Root/Publisher、Provider 请求、AgentMesh credits 与 Package mutation
  仍为 0；
- Kimi 继续按用户要求暂停，本轮由主 Agent 对 Bucket namespace、scope、权限、
  失败清理、轮换后 Key 独立性和 mode `0600` 做执行后复核；
- 本轮没有扩大到生产 Droplet、生产 Trust、P4 Bucket、CDN 或第二套对象存储；
  仍符合 P5 预检的唯一 staging 与 Registry-last/Registry-first 顺序；
- 下一轮只把当前进展冻结推送并升级同一保留式隔离 Client，然后执行 Cycle 101
  已冻结的 `prepare`/`create`：创建唯一 `SGP1`、`s-1vcpu-1gb`、Ubuntu 24.04
  Droplet，再创建一个 TTL 60、DNS-only 的 P5 A 记录。两者复验通过前不部署
  Origin、不生成测试签名 key、不运行 Builder 或 21 场景，P6 继续关闭。

### 循环 107：P5 唯一 Droplet 与 DNS-only Origin 地址实际落地

状态：唯一 P5 Droplet 与唯一 Cloudflare A 记录已创建并通过冻结执行器复验；尚未
部署 Origin、生成本轮测试签名 key、上传正式对象或运行 21 场景

实际执行：

1. 基于 clean pushed executor `435d706...` 依次通过 `prepare` 与 `create`，在
   DigitalOcean `SGP1` 创建唯一 `am360-p5-e1-9aa7c042` Droplet；规格固定为
   `s-1vcpu-1gb`、Ubuntu 24.04，备份与 monitoring 关闭，生产 Droplet 未触碰；
2. staging hostname 固定为
   `packages-p5-e1-9aa7c042.agentmesh360.com`，Cloudflare 只创建一条指向该
   Droplet 当前公网 IPv4 的 A 记录；Proxy 关闭，TTL 为 60 秒；
3. Cloudflare 当前域名行提供的真实 Zone ID、该 A 记录 ID、hostname、IPv4、
   `proxied=false` 与 `ttlSeconds=60` 只写入固定
   `/private/tmp/agentmesh360-p5-e1-cloudflare-state.json`，文件模式为 `0600`；
   未创建 API Token，未把账号 ID 误作 Zone ID，未将 IP 或标识写入仓库；
4. 冻结的 `infrastructure-boundary.mjs record-dns` 对 live state 与 Cloudflare
   receipt 做逐值复验并通过；Zone ID 同账号 ID、record ID 均不同，记录与唯一
   Droplet 的 hostname/IP 精确一致；
5. 自动销毁截止时间仍为 `2026-07-31T17:48:33Z`；本轮没有生成第二台 Droplet、
   第二条 DNS、额外 Bucket/Key，也没有部署或上传 Origin 对象。

自主验证与计划复盘：

- `prepare`、`create`、`record-dns` 均基于同一 clean pushed executor 通过；
  live state、凭据、Cloudflare receipt 与基础设施目录继续留在固定本机隔离路径，
  权限边界不变；
- 当前实际外部资源与 P5 预检精确一致：两个 SGP1 Standard Bucket、两把
  bucket-scoped limited Key、一台最小 SGP1 Droplet、一条 DNS-only/TTL 60 A 记录；
- Kimi 继续按用户要求暂停，本轮由主 Agent 对 Droplet 唯一性、规格、DNS
  hostname/IP、proxy、TTL、Zone/record 标识独立性和 receipt 模式自主复核；
- 产品蓝图下一项仍是已冻结的 Origin 部署，不提前生成 Root/Publisher、不运行
  Builder/publisher/21 场景；下一轮先冻结推送本状态并升级同一保留式隔离 Client，
  再运行 P5 Origin 部署器，要求 systemd/Caddy active、公网 HTTPS health 与只读
  Spaces 路由全部通过。P6 继续关闭。

### 循环 108：P5 基础设施与 Origin 执行提交 provenance 分离

状态：Origin 首次调用在联网前失败关闭；错误的同提交约束已修复并完成回归，等待
冻结推送后重新升级隔离 Host 与部署同一 Origin

执行前发现与修复：

1. Cycle 107 推送后，保留式隔离 Client 已成功从 `435d706...` 升级到
   `a10acad...`，正式 Host 为 `grok 0.2.106 (a10acad)`；state、userData、
   加密 OAuth/BYOK 状态均保留，执行器未读取凭据；
2. Origin 部署器在任何 DNS/SSH/Spaces 请求前以
   `live origin state differs from the approved P5 E1 boundary` 失败关闭；
   Droplet、DNS、Bucket、Key 和 Package 对象均未新增或修改；
3. 根因是 DNS state 正确记录基础设施创建提交 `435d706...`，当前 Origin 部署
   提交则为后继的 `a10acad...`；旧验证错误要求两者字节相同，与每模块记录进展、
   提交推送、再运行下一模块的既定闭环互相冲突；
4. 修复后不改写历史 receipt，也不把后继提交冒充基础设施创建提交：P5 部署器先
   要求 DNS state 中的 infrastructure executor 为合法 40 位提交，再用
   `git merge-base --is-ancestor` 证明它是当前 clean pushed deployment executor
   的祖先；基础设施顶层 provenance 与 `origin.executorCommit` 继续分别保留；
5. P4 的原有精确提交验证保持不变；未知、反向、无关或格式错误的提交仍失败关闭，
   wrapper 的固定路径、凭据、网络和生产 authority 边界没有扩大。

自主验证与计划复盘：

- Origin/P5 定向 20/20；P4/P5 Package 与 Distribution 工具链在沙箱外重跑
  135/135，通过本机回环 Origin 的四项真实服务测试；
- Node 语法、`git diff --check` 通过；Kimi 继续按用户要求暂停，本轮由主 Agent
  复核未修改 live receipt、未放宽当前 executor 的 clean pushed 门、未引入
  任意分支或时间替代 ancestry；
- 产品蓝图下一项没有变化，仍只部署当前唯一 Droplet 上的 Spaces-backed HTTPS
  Origin；下一轮冻结推送本修复、升级同一保留式 Client 后重试部署。Origin 通过前
  不生成测试 Root/Publisher、不运行 Builder/publisher/21 场景，P6 继续关闭。

### 循环 109：P5 Spaces-backed HTTPS Origin 实际通过

状态：唯一 P5 Origin、Caddy TLS、公网 health、受保护 fault probe 与只读
Spaces 路由均通过；尚未生成测试 Root/Publisher、构建或发布 Release Chain

实际执行：

1. Cycle 108 修复提交 `fb51833...` 推送后，同一保留式隔离 Client 与正式 Host
   成功升级到 `grok 0.2.106 (fb51833)`；state、userData、加密 OAuth/BYOK
   状态保留，凭据未读取；
2. 冻结的 P5 Origin 部署器通过 ancestry 证明 Cycle 107 的基础设施 executor
   是当前 deployment executor 的祖先，随后只连接既有唯一 Droplet；没有创建或
   替换 Droplet、DNS、Bucket、Key；
3. cloud-init 完成后安装 Caddy；Origin service 以非特权 `agentmesh-e1` 账号
   运行，配置只含 Origin Reader principal，不含 Publisher；systemd 与 Caddy
   均通过 active 检查；
4. Caddy 为固定 P5 hostname 获取托管 TLS，公网 `/healthz` 精确返回
   `{"environment":"e1","status":"ok"}`；direct-to-approved-IP、stdin token 的
   fault probe 同时通过；
5. 公网 `/v1/trust-bundle.json` 在尚未发布 Trust 时精确返回
   `404 application/json`，证明固定 HTTPS 路由已到达只读 Spaces-backed Origin，
   没有伪造预置对象或提前进入发布；
6. `/private/tmp/agentmesh360-p5-e1-infrastructure/origin-state.json` 为 mode
   `0600`：顶层继续保留基础设施创建提交，`origin.executorCommit` 单独记录本次
   部署提交，TLS 为 `caddy_managed_lets_encrypt`，生产 authority 仍为 false。

自主验证与计划复盘：

- P5 部署器完整返回 `Spaces-backed HTTPS origin passed`；公网 health 与 Trust
  404 另行无 redirect 复验通过，Origin state 的权限、双 provenance 和部署字段
  逐值复核通过；
- 当前新增 Package/Trust/Registry 对象仍为 0，Root/Publisher 私钥为 0，
  Provider 请求仍为 4/12、AgentMesh credits 为 0；没有扩大费用或生产权限；
- Kimi 继续按用户要求暂停，本轮由主 Agent 对非特权服务、只读 principal、Caddy
  TLS、公网路由、fault token 不上 argv 和 state 双 provenance 自主复核；
- 产品蓝图下一项严格是已冻结的双代 Release Chain Builder：先冻结推送本状态并
  升级同一隔离 Client，再生成本轮临时两把 Publisher、执行四 Agent
  baseline/variant 双构建与逐字节复现；两把 Root 留在后续 publisher 模块生成，
  Builder 全部通过前不调用 publisher 或 21 场景，P6 继续关闭。

### 循环 110：P5 双代 Release Chain 实际构建通过

状态：Generation A/B 的六个 Release 均完成双构建、双签名复验与 10/10 逐字节
一致；两把临时 Publisher 私钥保留待发布，Root 与 Spaces 正式对象尚未生成

实际执行：

1. Cycle 109 提交 `42ff4ca...` 推送后，同一保留式隔离 Client 与正式 Host 已
   升级到该提交；三个首方源仓库均 clean，Deploy、Job、LectureCast 的冻结 commit
   object 均存在，Builder 只创建这些历史 commit 的 detached worktree；
2. 前两次受限沙箱执行均在 `builder A offline executor build` 阶段失败，完整诊断
   确认为 macOS 沙箱拒绝 `protoc` 写 `/dev/stdout`；失败发生在生成 Publisher Key
   前，runner 已移除 candidate/source worktree、target 与隔离 boundary；
3. 诊断 target 随后删除；同一 `--offline --locked` Builder 在沙箱外重跑，只解除
   本机 `/dev/stdout` 限制，不开放网络、不改变 candidate/source/lock 或构建参数；
4. Generation A 固定 Deploy `0.1.1`、Future `1.0.0`、Job `0.4.7`、
   LectureCast `0.4.0`；Generation B 固定 Job `0.4.8-e1.1` 同权限更新与
   `0.4.9-e1.1` 权限扩张变体；
5. 六个 Agent Release 均完成 builder A/B 两次构建、两次签名复验和 Artifact、
   signing request、Host projection、Envelope、Release Manifest 等十类输出
   10/10 逐字节一致；
6. 两代分别生成一把临时测试 Publisher 私钥；各自 boundary 为 `0700`，
   private/public key 文件为 `0600`，代际与 key ID 不复用；构建 state 为 `0600`，
   生产 authority 为 false、cleanupRequired 为 true；
7. 本模块没有生成 Root 私钥，没有上传 Trust/Registry/Release 对象，没有调用
   Provider、扣除 credits 或修改正常 Package 状态。

自主验证与计划复盘：

- `/private/tmp/agentmesh360-p5-e1-release-chain-state.json` 精确为
  `release_chain_built`，executor 为 `42ff4ca...`、两代、4+2 个 Agent，全部
  `buildCount=2`、`signatureVerificationCount=2`、十类比较全为 byte-identical；
- 失败路径与成功路径均没有仓库根 `target/`；诊断 target 已删除，source repos
  保持 clean；Kimi 继续暂停，由主 Agent 复核冻结源码、lock、边界权限、代际隔离、
  私钥数量与未上传状态；
- 产品蓝图下一项严格是 Registry-last publisher：先冻结推送本状态并升级同一
  隔离 Client，再生成两把临时 Root、按两代上传 Release/Trust，最后上传 Registry
  并从公网逐字节复验。发布通过前不运行 21 场景，P6 继续关闭。

### 循环 111：P5 Origin、Builder 与 Publisher 提交 provenance 串联

状态：发布前发现的同提交约束已修复并完成回归；尚未生成 Root、上传对象或运行
21 场景

执行前复核与修复：

1. Cycle 110 提交推送并升级保留式 Client 后，发布前逐值检查发现 publisher
   仍要求 `origin.executorCommit`、Release Chain `executorCommit` 与当前
   publisher executor 三者字节相同；
2. 真实 state 分别正确记录 Origin 部署提交 `fb51833...`、双代 Builder 提交
   `42ff4ca...` 与当前后继提交；旧约束会在生成 Root 和第一个 Spaces PUT 前
   失败，与逐模块记录、推送再进入下一模块的既定闭环冲突；
3. publisher 现要求有序的两段 Git ancestry：
   `Origin executor → Release Builder executor → Publisher executor`；每段均调用
   已回归的 `git merge-base --is-ancestor`，未知、反向、无关和格式错误提交失败
   关闭；
4. 不改写 Origin/Release state，不把后继提交冒充历史创建提交；publication state
   继续分别记录当前 executor 与 `releaseExecutorCommit`，Origin state 继续保留
   自己的部署 executor；
5. 当前 executor 仍必须 clean、pushed、在授权窗口内；固定路径、两代身份、对象
   inventory、Registry-last、Publisher/Root 数量、Spaces scope、生产关闭态和清理
   传递依赖均未放宽。

自主验证与计划复盘：

- Publisher/Origin 定向 27/27；P4/P5 Package + Distribution 工具链沙箱外
  136/136，通过本机回环 Origin 四项服务测试；
- Node 语法、`git diff --check` 通过；Kimi 继续暂停，本轮由主 Agent 复核没有
  改写历史 state、没有接受平行分支、没有在结构校验前生成 key 或上传对象；
- 当前外部 Package 对象与新增 Root 仍为 0。下一轮冻结推送该修复、升级同一
  隔离 Client，再执行一次 Registry-last publisher；发布 PASS 和公网逐字节复验
  前不运行 21 场景，P6 继续关闭。

### 循环 112：P5 部分发布失败边界与 Registry-first 回滚器

状态：第一次 Registry-last 发布在 11/61 对象后失败；Registry 从未发布，第 12 个
对象不存在；严格部分回滚器已实现并完成回归，等待冻结推送后执行清场

实际失败状态：

1. Cycle 111 提交 `dd0d006...` 推送并升级保留式 Client 后，publisher 通过
   `Origin → Builder → Publisher` ancestry，生成两把临时 Root 并开始逐对象 PUT；
2. publication state 为 mode `0600`、`executionStatus=publishing`，计划 61 个
   唯一对象，已完成并回执 11 个；最后一个完成对象是 Release，Registry-last 标记
   仍为 false；
3. 对失败点第 12 个 Release 对象执行只读 HEAD，结果为不存在；因此失败发生在该
   对象 PUT 前，未留下未回执对象。固定 Registry 对象从未进入发布，正常客户端没有
   可消费的半成 Registry；
4. 两把临时 Root 已生成并留在各自 `0700` generation boundary；两把 Publisher
   和完整双代 Release Build 保留。21 场景、Package mutation、Provider、credits
   均未启动或增加。

回滚与清理修复：

1. 既有最终清理器只接受 `61/61 published + 21/21 scenarios`，不能处理
   `publishing` 前缀；现新增同一受权清理器的固定
   `rollback-partial --executor-commit <commit>`，不接收 bucket、key、路径或
   inventory 参数；
2. 部分 inventory 必须是完整 Registry-last 计划的严格回执前缀；rollback 首先
   HEAD/校验/删除可能存在的 Registry，并用 direct-to-approved-IP HTTPS 确认公开
   404，随后检查可能未回执的下一个对象，再反序删除已回执对象并由 Origin Reader
   对每个验证 404；
3. 如果下一个对象已存在，必须先由 Origin Reader 回读并与计划 SHA-256 一致才能
   删除；未知内容失败关闭。当前实际 HEAD 已证明下一个对象不存在；
4. 回滚只销毁两把本次 Root、移除失败 publication state；两把已完成验证的
   Publisher、两个 Release boundary 和 build state 保留，以便重新生成 Root 并
   从空 Bucket namespace 重试；
5. 最终 P5 清理器同时修正旧 P4 hostname 正则，并改为
   `Origin → Builder → Publisher → Scenario → Cleanup` 有序 ancestry；所有阶段
   的真实 executor 继续分别保留，不改写历史 state。

自主验证与计划复盘：

- 部分清理、Publisher、Origin 定向 20/20；P4/P5 Package + Distribution 沙箱外
  138/138；Node 语法和 `git diff --check` 通过；
- Kimi 继续暂停，本轮由主 Agent 复核 Registry-first、回执前缀、未回执对象摘要
  门、Root-only 销毁、Publisher/Release 保留和 P5 hostname；
- 下一轮先冻结推送本回滚器并升级同一隔离 Client，再执行部分回滚；必须得到
  Registry 公网 404、11 个对象删除/缺失复验、两把 Root 销毁与 publication state
  移除证据后，才重新运行 publisher。21 场景和 P6 继续关闭。

### 循环 113：P5 首次部分发布完整回滚

状态：11 个部分对象与两把临时 Root 已清除，Registry/Trust 公网均为 404；两把
Publisher 和双代 Release Build 保留，客户端正常 Package 状态未改变

实际执行与证据：

1. Cycle 112 提交 `2b400f4...` 推送后，同一保留式 Client/Host 升级成功；固定
   `rollback-partial` 基于 `dd0d006... → 2b400f4...` ancestry 接受失败 state；
2. Registry 首先执行 HEAD/可能撤回，并以 direct-to-approved-IP HTTPS 复验公开
   404；实际 Registry 从未存在，因此 Registry DELETE 计数为 0，但
   `registryWithdrawnFirst=true`；
3. 未回执第 12 个对象再次确认不存在；随后 11 个回执对象按反序 DELETE，每个均由
   Origin Reader HEAD=404。最终 deletedObjectCount 为 11，
   verifiedAbsentObjectCount 为 13（Registry、下一个对象、11 个已回执对象）；
4. 两把临时 Root 经隔离 signer 销毁，两个 Root 文件均不存在；失败
   publication state 已移除；
5. 两把 mode `0600` Publisher 私钥、两个 mode `0700` Release boundary 与
   `release_chain_built` state 全部保留；未重做构建、未创建新 Root、未调用
   Provider、未扣 credits；
6. 另行公网复验 `/v1/trust-bundle.json` 与 `/v2/registry.json` 均为
   `404 application/json`，正常客户端与 canary Client 均没有可见 Package 目录
   变更。

自主验证与计划复盘：

- 部分回滚 receipt 为 mode `0600`、`partial_publication_rolled_back`、
  cleanupRequired=false；Root absent、Publisher present、publication state absent
  与两个 Release boundary retained 均逐项通过；
- Kimi 继续暂停，本轮由主 Agent 对 Registry-first、对象计数、公网 404、Root
  销毁、Publisher/Release 保留与正常 Package 零 mutation 自主复核；
- 计划下一项仍是同一 Registry-last 发布，但 61 对象需要约 180 次独立 Spaces
  请求；首次失败点对象不存在，符合瞬时 HEAD/传输失败特征。下一轮先为单对象
  HEAD/PUT/readback 增加有界、摘要证明的幂等恢复：未知 PUT 结果必须先 HEAD+GET
  验证计划摘要，绝不盲目覆盖；回归与冻结推送后才重新生成 Root 并发布。21 场景
  与 P6 继续关闭。

### 循环 114：Spaces 单对象有界重试与不确定 PUT 摘要恢复

状态：发布传输恢复已实现并完成完整回归；尚未重新生成 Root 或上传对象

实现与安全边界：

1. HEAD 与 GET 仅对明确的 timeout、fetch/network/socket 错误以及
   408/425/429/500/502/503/504 做最多三次有界重试；403、签名错误、对象已存在、
   非预期 4xx 和摘要错误不重试；
2. PUT 不盲目重放：如果请求结果不确定，先用 Publisher HEAD 判断对象是否存在；
   若存在，再由 Origin Reader GET 并与计划 typed SHA-256 逐字节核对；只有摘要
   完全一致才把第一次 PUT 视为成功；
3. 不确定 PUT 后对象仍不存在时，最多重试到三次；若存在但摘要不同，立即失败关闭，
   绝不覆盖已经出现的 immutable object；
4. PUT 成功或摘要恢复后，仍执行独立 Origin Reader GET 与摘要核对，原有
   Registry-last 和每对象 receipt 顺序不变；
5. 该恢复位于 P4/P5 共用的单对象发布原语，不引入并行 PUT、resume state、覆盖
   语义、生产 endpoint、Provider 或额外云资源。

自主验证与计划复盘：

- Spaces/Publisher/Cleanup 定向 29/29；P4/P5 Package + Distribution 沙箱外
  141/141；覆盖 transient HEAD 三次、未知 PUT 后同摘要恢复、不同摘要拒绝覆盖；
- Node 语法、`git diff --check` 通过；Kimi 继续暂停，本轮由主 Agent 对重试分类、
  次数上限、unknown PUT 分支、Origin Reader 独立摘要和非瞬时错误自主复核；
- 产品计划不变：下一轮冻结推送、升级同一隔离 Client，然后从空 namespace
  重新生成两把 Root 并运行一次 Registry-last publisher。完整 61/61 与公网
  Trust/Registry/Release 复验通过前不运行 21 场景，P6 继续关闭。

### 循环 115：P5 双代 Release Chain Registry-last 实际发布通过

状态：61/61 对象全部发布并回读复验，Registry 最后上线；公网 Trust、Registry
与真实 Release 均通过，21 场景尚未启动

实际执行：

1. Cycle 114 提交 `5700589...` 推送并升级保留式 Client 后，publisher 从已清空
   namespace 重新生成两把临时 Root；两把既有 Publisher 与双代 Release Build
   不变；
2. 61 个计划对象全部按唯一顺序完成 Publisher HEAD=404、PUT 和 Origin Reader
   GET 摘要复验；publication state 为 mode `0600`、`published`，61 条 receipt
   与 61 条计划在 bucket class、object key、typed SHA-256 上逐项一致；
3. 四段 Trust sequence 固定为 1/2/3/4，五版 Registry revision 固定为
   1/2/3/4/5；`metadata/registry.v2.json` 是第 61 个且最后一个 receipt，
   `registryPublishedLast=true`；
4. 两把 Root 私钥与两把 Publisher 私钥继续分别位于两个 `0700` generation
   boundary，文件为 `0600`，等待场景完成后由 Registry-first 清理器统一销毁；
5. 独立公网复验：`/v1/trust-bundle.json` 与 `/v2/registry.json` 均为
   200 `application/json`；随机选取一个真实 Release 对象为 200、MIME 在批准
   白名单、无 redirect，下载字节 typed SHA-256 与 publication plan 完全一致；
6. 本轮没有新增 Droplet、DNS、Bucket 或 limited key，没有 Provider 请求或
   AgentMesh credits；生产 Trust、Registry 常量和 endpoint 仍为空。

自主验证与计划复盘：

- 第二次 publisher 明确返回 `two-generation Release Chain published
  Registry-last`；61/61、Root mode、双 provenance、Trust/Registry monotonic
  序列和公网三类对象独立复验全部通过；
- 首次部分发布的非秘密 rollback receipt 保留；失败 Root/对象已销毁，新 publication
  state 只描述本次成功发布，不混合旧 receipt；
- Kimi 继续暂停，本轮由主 Agent 对 Registry-last、逐项 plan/receipt、两代 key、
  公网 HTTP/MIME/redirect/摘要和生产关闭态自主复核；
- 产品蓝图下一项严格是 21 场景矩阵：先冻结推送本状态并升级同一隔离 Client，
  再运行 14 项真实 Host 场景和 7 项已绑定的订阅/BYOK/预算证据。矩阵必须全部通过
  且恢复最终 canary Package 状态，才进入 Registry-first 全清场；P6 继续关闭。

### 循环 116：P5 Scenario executor 有序 provenance

状态：21 场景执行前的同提交约束已修复并完成完整回归；Electron/Host 场景尚未启动

执行前复核与修复：

1. 场景器仍要求 publication executor、Origin executor 与当前 scenario executor
   字节相同；真实 state 分别记录 `fb51833...` Origin、`42ff4ca...` Builder、
   `5700589...` Publisher 和当前后继执行器；
2. 修复后严格要求
   `Origin → Release Builder → Publisher → Scenario` 三段 Git ancestry，
   并从 publication state 的 `releaseExecutorCommit` 绑定 Builder provenance；
3. publication/Origin executor 均必须是合法 40 位提交；反向、无关、未知或格式
   错误提交失败关闭，不改写已发布 state；
4. 61/61 inventory、Registry-last、两 Root public evidence、固定 hostname、
   fault token、授权窗口、Provider 4/12、credits 0、固定 Client/Host/Electron
   路径和输出不存在门均保持不变。

自主验证与计划复盘：

- Scenario/Publisher/Cleanup/Origin 定向 28/28；P4/P5 Package + Distribution
  沙箱外 142/142；Node 语法、`git diff --check` 通过；
- Kimi 继续暂停，本轮由主 Agent 对三段 ancestry、发布 inventory、Driver 输入、
  生产常量关闭态和不新增 Provider 调用自主复核；
- 下一轮冻结推送、升级同一保留式 Client 后只执行一次 21 场景矩阵；要求 14 项
  live Host 和 7 项契约/历史真实证据全部 PASS、Provider 新增 0、credits 0、
  production mutation 0，并把 canary Package 状态恢复到矩阵定义的最终状态。
  通过前不进入清场，P6 继续关闭。

### 循环 117：P5 Host 的隔离 Origin DNS 兼容边界

状态：场景首次启动在任何 Package mutation 前安全停止；P5-only Origin IPv4
覆写已实现并完成回归，21 场景等待冻结提交与隔离 Host 升级后重跑

执行证据与根因：

1. Cycle 116 提交 `e2b24f3...` 推送并升级保留式 Client 后，场景 Driver 在
   baseline Trust 刷新处返回安全错误码 `baseline_trust_invalid`；没有生成 Host
   receipt 或 matrix receipt；
2. 隔离 `state.db` 只读核对确认 Package/Trust 相关表均为 0 行，场景未发生
   Package mutation；公网 Trust 与 Registry 使用相同 fault header 均为 200，
   因此没有改写已发布 Release Chain；
3. 本机 TUN DNS 把 P5 hostname 解析到 RFC 2544 `198.18.0.0/15` Fake-IP。Node/curl
   经过系统代理可访问，但正式 Rust `reqwest` Package metadata/data client 的直连
   路径无法连接该 Fake-IP；
4. 场景输入现在从已经审批并复验的 P5 `origin-state.json` 绑定唯一 Droplet IPv4。
   Electron Driver 与 Rust canary runtime 都要求合法 IPv4，并显式拒绝私网、
   loopback、link-local、CGNAT、multicast、broadcast 和 RFC 2544 Fake-IP；
5. 只有固定 `AGENTMESH360_P5_E1_CANARY`、固定 Client boundary、固定 P5 hostname
   和有效 Root/场景文档同时成立时，Registry fetcher 与 Release downloader 才向
   `reqwest::ClientBuilder::resolve` 注入该地址；URL、HTTPS hostname、TLS SNI、
   Release 签名 URL 和 Origin allowlist 均保持 hostname，不降级 HTTP；
6. 普通生产构造器、测试 transport override 和生产 Package 常量继续传入
   `None`，没有 DNS 覆写、生产 endpoint、Provider 请求、credits 或新增云资源。

自主验证与计划复盘：

- P5 canary runtime 2/2、Registry fetcher 4/4、Downloader 10/10；P4/P5 Package +
  Distribution Node 142/142；场景输入定向 8/8；
- `cargo fmt --check`、Node 语法与 `git diff --check` 通过；编译 target 位于
  `/private/tmp`，项目根目录没有恢复大体积 `target`；
- Kimi 继续暂停，本轮由主 Agent 对输入来源、地址拒绝集合、TLS hostname、
  生产 `None` 路径和首次失败零 mutation 自主复核；
- 产品顺序未改变：本修复只打通已经冻结的 21 场景执行路径，不建立通用自定义 DNS
  功能，不扩大到 P4/生产，不新增场景或云资源。下一轮先提交推送并升级同一隔离
  Client/Host，清除首次失败遗留的未消费 Driver 输入，再重跑 21 场景；全 PASS
  前不得执行 Registry-first 清场，P6 继续关闭。

### 循环 118：签名 Package 缓存保留 expiry 精度

状态：第二次场景启动在任何 Package 安装前安全停止；缓存精度 bug 已修复并完成
回归，21 场景等待冻结提交与同一隔离 Host 升级后重跑

执行证据与根因：

1. Cycle 117 提交 `1e75099...` 推送并升级同一 Client/Host 后，baseline Trust 与
   Registry 网络获取、Root/Publisher 验签和 revision/sequence 校验均成功；
2. 隔离 `state.db` 只读核对显示 Trust/Registry cache 各 1 行而
   `agent_package_registry` 仍为 0 行；Driver 在 `new_agent_not_discovered` 处停止，
   没有 Package 安装、Host receipt 或 matrix receipt；
3. 安全诊断进一步确认 discovery 为 `cache_rejected`，内部原因是
   `Agent Package trust cache metadata does not match signed documents`；
4. 已发布 Trust/Registry 的签名 `expiresAt` 为毫秒精度，而 cache 写入统一使用
   `SecondsFormat::Secs`，把 `.064Z` 截断成整秒。首次接受返回内存中的原值，但随后
   discovery 从 SQLite 重验时，签名值与缓存元数据不再相等，因此正确地失败关闭；
5. 修复后只有来自签名文档的 Trust/Registry expiry 使用
   `SecondsFormat::AutoSi` 保留有效小数精度；本地 `verifiedAt/updatedAt` 继续固定
   整秒，避免把本机经过时间噪声混入既有审计语义；
6. 新增毫秒 expiry 的接受、SQLite 精确落盘和“模拟进程重启后重新验签”回归；
   整秒旧文档、反回滚、equivocation、过期、缓存摘要损坏和生产空 Root 行为不变。

自主验证与计划复盘：

- Package Trust Cache 6/6（新增毫秒跨重启用例）、Registry fetcher 4/4；
  P4/P5 Package + Distribution Node 142/142；
- `cargo fmt --check` 与 `git diff --check` 通过；为诊断临时创建的 17GB target 在
  触发磁盘硬门槛后立即销毁，项目根目录仍无 `target`，P5 保留式 build/state 未删；
- 临时详细日志与诊断脚本均已撤销，不进入仓库；Kimi 继续暂停，本轮由主 Agent 对
  精度分流、签名值不变、旧整秒兼容、零 Package mutation 和磁盘边界自主复核；
- 产品计划与场景顺序不变，本轮只修复 H2d4 已有签名缓存的确定性跨重启语义，不增加
  新协议、网络或生产 authority。下一轮提交推送并升级同一隔离 Client/Host，
  清除第二次失败遗留输入，再从 baseline 重跑 21 场景；全 PASS 前仍不清场，
  P6 继续关闭。

### 循环 119：Package mutation receipt 的桌面数值契约

状态：第三次场景已通过网络、签名 cache 与 discovery，并完成首个隔离 Future Agent
安装；桌面 receipt 契约问题已修复并完成回归，等待恢复 pre-Package baseline 后重跑

执行证据与根因：

1. Cycle 118 提交 `41734ce...` 推送并升级同一 Client/Host 后，baseline Trust/
   Registry、cache reload 与四个远端 Package discovery 全部通过；
2. Driver 成功安装 `future-agent 1.0.0` 后在 Job baseline mutation receipt 处返回
   安全码 `invalid_package_response`；为判定不确定 mutation，隔离 DB 与安全原始
   receipt 对账确认 Future 已安装，随后诊断批准也实际安装 `job-agent 0.4.7`；
3. Rust `PackageMutationReceipt` 外层为 camelCase，但 tagged enum
   `PackageRuntimeVisibility` 只对 variant 名应用 snake_case，variant 内字段仍输出
   `catalog_generation/catalog_revision`；桌面白名单只接受
   `catalogGeneration/catalogRevision`，因此 mutation 已提交但响应被正确拒绝；
4. 动态本地 Catalog revision 取 SHA-256 前 64 位，真实值还可能超过 JavaScript
   `Number.MAX_SAFE_INTEGER`；即便只修字段名，桌面随后读取 Catalog/Status 仍会失败；
5. 修复后 enum variant 状态继续为 `visible/superseded/refresh_pending`，但字段统一
   camelCase；动态本地 Catalog revision 保持相同输入的确定性 SHA 派生，只截取
   53 位并保证非 0。远端签名 Registry revision、Trust sequence、Package 版本与
   digest 全部不变；
6. Rust 新增真实 receipt JSON 的字段名、禁止 snake_case 和 53 位上限断言；动态
   Catalog 测试同时验证序列化值为 JS 安全整数。桌面继续严格拒绝未知或超界 Host
   payload，没有放宽 Renderer 白名单。

自主验证与计划复盘：

- 动态 Agent Catalog 9/9、Package Delivery 14/14、桌面 Package Controller
  12/12、Trust Cache 5/5；P4/P5 Package + Distribution Node 142/142；
- `cargo fmt --check` 与 `git diff --check` 通过；临时 raw receipt 诊断只输出 Rust
  已证明不含路径、摘要、账户与秘密的公开字段，并已删除；
- Kimi 继续暂停，本轮由主 Agent 对 mutation 不确定性、Rust/JS 字段合同、53 位
  revision、签名 Registry 不变和 Renderer 仍失败关闭自主复核；
- 本轮属于既有 Package Center Host→Desktop 合同修复，不增加场景、权限、网络、
  Provider 或生产 authority。下一轮先提交推送，按授权精确删除两个 canary
  Package 行及其两个隔离 version 目录，保留 OAuth/BYOK/Trust/Provider 状态，再升级
  同一 Host 并重跑 21 场景；矩阵 PASS 前不进入 Registry-first 清场。

### 循环 120：Origin Reader 原地轮换与 Host 回执恢复收口

状态：P5 隔离 Origin Key 已原地再生成并恢复只读服务；14/14 真实 Host 场景回执
已通过正式校验，安全恢复收口器完成回归，21 场景矩阵等待冻结提交后固化

实际执行与恢复边界：

1. DigitalOcean 对固定 `am360-p5-e1-origin-*` Key 执行原生 regenerate；旧
   Access ID/Secret 永久失效，新 ID/Secret 均发生变化，Key 名称、两个 P5 Bucket
   和 `Read` 权限不变；
2. 新凭据只写入既有 mode `0600` 隔离凭据与 Origin config；Publisher principal
   逐字节未改，Root/Publisher 私钥、Release 对象、Trust、Registry、Droplet、
   DNS 和生产常量均未修改；
3. 同一 Droplet 的非特权 Origin 服务更新 config 并重启；direct-to-approved-IP
   HTTPS health、Trust 与 Registry 分别返回 `200 application/json`，证明新 Reader
   已生效且 61/61 Registry-last 发布链仍可读；
4. 完整场景执行已经写出 mode `0600` Host receipt：14 个固定场景全部唯一
   `passed`，Package mutation 精确为 5，Provider inference 新增 0、credits 0、
   production authority false，账户标识、凭据与 prompt/response 均未记录；
5. 外层 Electron 进程在 Host receipt 写入后没有向 wrapper 提供可靠终态，因此
   wrapper 返回通用失败且未写 matrix receipt；正式 `validateHostReceipt` 和
   `buildScenarioResults` 独立复验为 Host 14/14、总矩阵 21/21；
6. 新增唯一 `finalize-host-receipt` 恢复入口：只接受固定 Client/source、原
   Driver input、Host receipt、publication/Origin state 和当前 clean pushed
   executor；要求
   `Origin → Builder → Publisher → Host → Finalizer` 全序 ancestry，并逐字节
   重建 Driver input 后才能写 matrix receipt；
7. 恢复路径不会再次启动 Electron、不会重复 5 次 Package mutation，也不能指定
   任意路径、场景、Endpoint、Key 或输出；receipt 额外绑定 Host executor 与
   Driver input typed SHA-256。

自主验证与计划复盘：

- Scenario/Cleanup 定向 16/16；P4/P5 Package、Distribution、Key Ceremony 与
  Release Evidence 工具链沙箱外 246/246；Node 语法和 `git diff --check` 通过；
- 沙箱内同一套 242/246，唯一四项仍是环境禁止 Origin 测试监听
  `127.0.0.1` 的 `EPERM`；沙箱外四项全部通过，不属于产品失败；
- Kimi 继续按用户要求暂停，本轮由主 Agent 复核旧 Key 已失效、新 Reader 只读、
  Publisher 未变、Host receipt 无秘密字段、Driver input/receipt/提交链不可替换；
- 产品计划没有增加场景或进入 P6。下一轮先冻结、提交、推送本恢复器，再以现有
  `dd7030c...` Host executor 收口 21/21 matrix receipt；通过后立即进入既定
  Registry-first Release Chain 清场，不重跑 Host 场景。

### 循环 121：矩阵预算字段终态映射修复

状态：首次恢复执行在 matrix receipt 写入前安全停止；原场景器的确定性
ReferenceError 已修复并完成完整回归，Host/Driver/Package 状态未重复修改

根因与修复：

1. Cycle 120 恢复器提交 `e8e4e08...` 推送后，第一次使用精确完整提交执行；
   authority、Client/source、Driver input、Host receipt、发布 inventory、预算和
   五段 ancestry 全部通过，最后在构造 matrix receipt 的 `budget` 时停止；
2. 原正常场景器早已把局部变量命名为 `providerOperationsUsed`，但 receipt 对象
   使用了不存在的 shorthand `providerInferenceOperationsUsed`，触发
   `ReferenceError`；这解释了此前 14 项 Host 已完成、外层仍返回通用失败的完整
   因果链；
3. 正常执行和 Host receipt 恢复执行两个分支都改为显式
   `providerInferenceOperationsUsed: providerOperationsUsed`；字段名仍与既有
   receipt Schema 相同，值仍来自已批准 BYOK evidence，没有改动预算或新增请求；
4. 回归固定要求两个分支均存在显式映射，并禁止独立 shorthand 再次出现；第一次
   恢复没有创建 matrix receipt，不存在需要删除或覆盖的半成 evidence。

自主验证与计划复盘：

- Scenario/Cleanup 定向 16/16；P4/P5 完整工具链沙箱外 246/246；Node 语法与
  `git diff --check` 通过；
- Provider 请求仍为历史 4/12、本轮新增 0，credits 0，Package mutation 没有
  重跑；Kimi 继续暂停，由主 Agent 复核字段名、值来源和失败发生在唯一输出写入前；
- 下一轮只冻结、提交、推送该一行双分支修复，再以相同 Host receipt 执行一次
  恢复收口；成功生成 21/21 matrix receipt 后立即更新进展并进入
  Registry-first 清场，不延伸到 P6。

### 循环 122：P5 Package Canary 21 场景矩阵实际通过

状态：14 项真实 Host 场景与 7 项既有订阅/BYOK/预算证据已合并为严格
21/21 PASS matrix receipt；最终 canary Package 状态符合计划，等待 Registry-first
清场

实际执行与证据：

1. Cycle 121 提交 `b541e97...` 推送后，恢复器以 `dd7030c...` Host executor 和
   当前 finalizer executor 执行；完整提交、clean/pushed、固定 Client/source、
   Driver input、Host receipt、Origin/Builder/Publisher ancestry 全部通过；
2. mode `0600` matrix receipt 精确记录 `scenarioCount=21`、21 个唯一
   `status=passed`，execution status 为 `scenario_matrix_passed`；
3. input digests 同时绑定 authorization、OAuth、BYOK、61/61 publication state、
   原 Driver input 和 live Host receipt；Host executor 与 finalizer executor
   分开记录，没有改写历史 provenance；
4. Provider inference 保持历史 `4/12`，本场景新增 0；AgentMesh credits 0，
   Package mutation 5，账号/订阅/生产 mutation 0，生产 authority false，
   receipt 不记录账户标识、凭据或 prompt/response；
5. 隔离数据库最终 Package 状态为 Future `1.0.0`；Job active
   `0.4.8-e1.1`、previous `0.4.9-e1.1`；Trust sequence 4、Registry revision 5，
   恰好对应矩阵定义的安装、同权限更新、权限扩张批准、回滚、Publisher/Root
   轮换与 Registry withdrawal 后 LKG 状态；
6. 本轮没有再次启动 Electron，没有重复 Package mutation，没有新增 Provider、
   云资源、Root/Publisher 或生产常量。

自主验证与计划复盘：

- 正式 runner 返回 `P5 E1 21-scenario matrix passed with no additional
  Provider inference`；receipt mode、场景唯一性、预算、mutation 和六类输入摘要
  逐项复核通过；
- Kimi 继续按用户要求暂停，本轮由主 Agent 对 14+7 覆盖、最终 DB 状态、预算、
  provenance 和无秘密留存自主复核；
- P5 唯一下一步是既定 Registry-first 清场：先冻结、提交、推送本进展，再由清理器
  首先撤回公开 Registry、验证 404，随后反序删除其余对象并销毁两 Root、两
  Publisher 与两个 Release boundary；清场通过前不删 Droplet/Reader，也不进入
  P6。

### 循环 123：P5 Registry、对象与临时签名材料实际销毁

状态：Registry-first 撤回、61 个对象删除、四把临时私钥与两个 Release boundary
销毁全部完成；DNS、Droplet、limited key、Bucket 和本机隔离 Client 仍待删除

实际执行与证据：

1. Cycle 122 进展提交 `34e8e95...` 推送后，清理器验证
   `Origin → Builder → Publisher → Scenario → Cleanup` 完整 ancestry、21/21
   matrix receipt 和 61/61 publication inventory；
2. 首先删除固定 Registry 对象，并通过 direct-to-approved-IP HTTPS Origin 验证
   `404 application/json`；独立复验同样返回 404，没有 redirect；
3. 其余对象按 publication inventory 反序删除；最终 planned、deleted 和
   verified absent 均为 61，没有跳过或额外对象；
4. 两把临时 Root 与两把临时 Publisher 私钥均通过隔离 signer destroy；两个
   Release boundary 删除，`/private/tmp` 对应 retained boundary 计数为 0；
5. mode `0600` cleanup receipt 为 `release_chain_withdrawn`，
   `registryWithdrawnFirst=true`、Root 2、Publisher 2、Release boundary 2，
   Provider 新增 0、credits 0、生产 mutation 0；
6. publication/release state 只作为下一阶段固定清理 inventory 暂时保留，不含
   仍可用私钥；Droplet 与 Reader 尚在，便于本模块完成前执行独立公网 404 复验。

自主验证与计划复盘：

- 正式清理器返回 `P5 Registry withdrawn first; 61 objects and four private keys
  destroyed`；receipt 计数、boundary absence 与公网 Registry 404 独立复核通过；
- Kimi 继续暂停，本轮由主 Agent 复核 Registry-first 顺序、61/61、一共四把
  私钥、两个 boundary 和生产零 mutation；
- 下一步先冻结、提交、推送本进展，再按固定顺序删除 Cloudflare DNS、销毁唯一
  P5 Droplet、撤销 Publisher/Origin limited key、删除两个空 Bucket；完成云端
  计数复验后才删除本机 credential、SSH key、OAuth/BYOK 隔离状态和 build，不进入
  P6。

### 循环 124：P5 云基础设施与 limited credentials 实际清场

状态：P5 DNS、Droplet、SSH 私钥、两个 limited key 和两个 billable Bucket
均已撤回；两个空 Bucket 进入 Provider 永久删除队列且停止计费，本机
credential、隔离 Client/state/build 尚待 finalizer 销毁

实际执行与复验：

1. Cloudflare 只删除固定
   `packages-p5-e1-9aa7c042.agentmesh360.com` DNS-only A record；确认对话框精确
   显示该 hostname、A、DNS only、1 min，删除后 Records 列表匹配为 0；
2. 固定 `agentmesh360-p5-e1` tag 下唯一 Droplet 由 approved destroy runner
   销毁；doctl 删除后精确匹配数为 0；
3. destroy runner 同时覆盖删除本机临时 operator SSH 私钥，文件已不存在；
4. 两个 P5 Bucket 删除前均为 `0 Bytes / 0 items`；删除后 active link/menu
   均 absent，各自只保留 Provider 的永久删除排队状态，并明确不再计费；
5. 先对新 Origin Reader 与 Publisher key 的名称、两 Bucket grant 逐项复验，
   再按 Access ID 永久删除；DigitalOcean Access Keys 页面两个精确名称匹配均为
   0。删除最后一个 Key 后 doctl list 返回 Provider 空集合的 404，页面独立复验
   消除歧义；
6. 非秘密 cloud cleanup evidence 只记录 DNS/Droplet/key/billable bucket 计数、
   预算与时间；不含 IP、record ID、Access ID、Secret、路径或账户标识；
7. 从资源创建到撤回约 4 小时，保守基础设施成本上界 `0.10 USD`，低于 `3 USD`
   硬上限；最终 invoice 尚未结算，不冒充实际账单。

自主验证与计划复盘：

- Cloudflare target count 0、doctl tagged Droplet count 0、operator private key absent、
  Access Keys target count 0、两个 active Bucket link 0 均独立通过；
- Kimi 继续暂停，本轮由主 Agent 复核 DNS 精确目标、Droplet tag、Key 名称/grant、
  Bucket 0 items 与删除后停止计费；生产 mutation 0；
- 下一步实现 P5 专用本机 finalizer：只接受上述仓库 cloud evidence、21/21 matrix
  receipt 和 Registry-first cleanup receipt；精确删除临时 Keychain credential、
  Provider Profile/Assignment/Binding、隔离 Client/build 以及剩余 P5
  credential/state，保留正常用户状态与源 Gemini Key；完成前不进入 P6。

### 循环 125：P5 本机终态清理器冻结

状态：专用 finalizer 与产品内 Provider 清理 Driver 已实现并完成静态/合同回归；
等待 clean pushed executor 执行后销毁最后的隔离 Client、Keychain 与临时状态

实现与安全边界：

1. finalizer 只接受当前 clean、已推送且仍在授权窗口内的完整提交，并要求生产
   Publisher Trust、Trust URL 与 Registry URL 三个常量继续为空；
2. 输入 inventory 固定为 `/private/tmp` 下精确 11 个 P5 项；同时校验非秘密 cloud
   cleanup evidence、21/21 matrix、Registry-first 61/61 cleanup、两代
   Root/Publisher 已销毁和
   `Scenario executor → Cleanup executor → Finalizer executor` ancestry；
3. 修复 retained Host provenance 读取目录错误：现在从固定隔离 `source` 仓库读取
   Host commit，不再误读主仓库 HEAD；
4. 临时 Gemini Provider 不由 SQL 直接删除，而是通过现有
   `ProviderController.deleteProfile` 产品 API 同时移除 Keychain credential、
   Profile 与 Assignment；Driver 不创建 Profile、不运行 probe、不读取源
   `GEMINI_API_KEY`，Provider inference 新增 0、credits 0；
5. 删除前将 opaque credential ref 写入隔离 mode `0600` 恢复状态；如果产品删除
   已完成但后续本机步骤异常，可验证 Keychain 与数据库终态后继续，且该恢复状态
   随 Client boundary 一并销毁；
6. retained Host PID 必须同时匹配固定 build binary 与 `agent leader` 命令才允许
   终止；build/source 普通递归删除，state、user-data、credential、receipt 与
   SSH/云临时状态使用 `O_NOFOLLOW` 有界覆盖后删除；
7. finalizer 不含 Cloudflare、DigitalOcean 或 Provider 推理 mutation 能力，不触碰
   正常 AgentMesh360 Client 状态与已保存源 Gemini Key，也不进入 P6。

自主验证与计划复盘：

- finalizer 与 Electron Driver 语法通过；新增 5/5 清理合同测试，P5 工具目录
  78/78 通过；完整 P2–P5、Distribution 与 Release 工具链 251/251 通过，其中
  沙箱内 247/251，四项 loopback Origin 测试按既定方法在沙箱外复跑 5/5 通过；
  覆盖精确 inventory、CLI、预算上限、完整场景/清理计数、ancestry 与
  destructive scope；
- Kimi 继续按用户要求暂停，本轮由主 Agent 复核 provenance cwd、Keychain
  产品删除路径、失败恢复状态、符号链接防护和生产常量关闭；
- 下一步只提交、推送本 finalizer，然后以该完整提交执行一次终态清理；执行成功
  后复验 `/private/tmp` P5 项为 0、P5 Host 进程为 0、仓库 `target/` 仍不存在，
  更新 P5 完成文档并运行最终回归，不启动 P6。

### 循环 126：P5 Package Canary 完整关闭

状态：已完成；P5 真实 Package canary、Registry-first 撤回、云端与本机清场全部
通过，生产常量继续为空，P6 未启动

终态执行与证据：

1. 以 clean 且已推送的 `5a2b2fb...` executor 执行专用 finalizer；先复验固定
   11 项本机 inventory、21/21 matrix、61/61 Registry-first cleanup、两代
   Root/Publisher 私钥与 Release boundary 已销毁、cloud cleanup evidence 和完整
   executor ancestry；
2. 产品 `ProviderController.deleteProfile` 删除隔离 Gemini Profile 1 个、
   Assignment 1 个与对应 Keychain credential 1 个；历史 Binding 1 个随隔离
   state boundary 销毁，源 Gemini Key 与正常客户端状态未进入清理范围；
3. 固定 retained Host PID 只在命令匹配隔离 build binary 与 `agent leader` 后终止；
   独立进程复验该 PID 已不存在；
4. 删除 26 GiB 隔离 Client build/source/state/user-data、基础设施 boundary 与
   9 个独立 P5 临时文件；`/private/tmp` 的 P5 与 release-provenance 匹配项为 0，
   仓库根 `target/` 仍不存在；
5. 非秘密终态 evidence 只保留计数、executor、关闭状态与时间；不含邮箱、账户 ID、
   IP、URL、Access ID、secret、credential ref、本机路径、prompt 或响应；
6. Provider inference 本轮新增 0、AgentMesh credits 0、生产 mutation 0；完整 P5
   历史使用仍为批准范围内 4/12 Provider 请求，基础设施保守成本上界 0.10 USD，
   最终账单尚未结算。

自主验证、计划复盘与后续边界：

- finalizer 正式返回 `local_secret_state_destroyed`；本机残留 0、原 P5 Host PID
  absent、HEAD 与 `origin/main` 一致；
- 清理器新增测试 5/5、P5 工具 78/78、完整 P2–P5/Distribution/Release 工具链
  251/251；桌面语法检查通过，桌面测试 114 passed / 3 个真实 Host 环境门
  skipped / 0 failed；四项 Origin 与五项 OAuth loopback 测试均在沙箱外复验通过；
- Kimi 继续按用户要求暂停，本轮由主 Agent 完成完整 diff、产品 API 删除路径、
  Keychain/DB/进程/文件终态、预算与生产关闭常量加强复核；
- 对照产品蓝图和生产准备计划，P5 的 Package canary 目标已完整实现，没有把 staging
  PASS 写成生产 R1-R6 关闭；下一顺序仍是 P6 R4 Desktop Candidate，但它需要
  Developer ID、Apple 公证、更新渠道与恢复矩阵的独立授权。本轮在 P5 关闭处停止，
  不自行生成凭据、不签名、不公证、不发布 Desktop Candidate。

### 循环 127：P6 R4 Desktop Candidate 阻断式预检

状态：已完成 no-authority preflight；R4、Developer ID、Apple 签名/公证、更新渠道
和真实 Desktop Candidate 继续保持 blocked

实际实现与现状审计：

1. 新增 strict `agentmesh360-desktop-candidate-preflight-v1` Schema、默认 blocked
   JSON 模板、中文清单和无依赖 Node validator/CLI；
2. 模板逐字节绑定 P5 本机清场 evidence 与当前 `desktop/package.json`/lock，
   固定实际 `0.1.0`、bundle ID、Electron/electron-builder、DMG/ZIP、Host extra
   resource、Login Item 与持久 Host 开发基础；
3. 同时固定真实缺口：未验证 Apple membership/Developer ID identity，未读取
   Keychain 或 Apple credential，未配置 signing、notarization、显式 Hardened
   Runtime、entitlements、`electron-updater`、publish provider、update channel、
   rollback 或仓库 Release workflow；
4. R4 合同要求固定 commit/version/bundle/architecture/macOS floor、所有 nested
   executable 签名、Hardened Runtime、最小 entitlement、notarization/stapling/
   Gatekeeper、更新 artifact 真实性、禁止 unsigned update/静默 downgrade、LKG、
   Login Item/Host 恢复和卸载用户状态策略；
5. 固定 18 项 build/signing/notarization/install/lifecycle/update/rollback/uninstall
   矩阵，每项均为 `blocked`，不能从模板推断执行或通过；
6. future approval card 必须明确 candidate environment/version/commit、bundle、
   architecture、最低 macOS、Developer ID、notarization credential、更新
   provider/channel、rollback、设备/cohort、窗口、Abort Owner、预算和安全 evidence
   retention；
7. 本轮只读查阅 Apple/electron-builder 当前官方要求；产品预检执行器本身 network
   请求 0，且没有 subprocess、Keychain、Apple service、签名、构建、安装、上传、
   Provider、credits 或费用能力。

自主验证与计划复盘：

- 定向 15/15，覆盖 P5/manifest/lock 字节绑定、当前 unsigned 事实、完整 R4 合同、
  authority/credential/network/build 升级拒绝、18 场景顺序、留存安全、重复 JSON
  key、symlink、UTF-8、大小与 CLI 路径脱敏；
- 完整发布工具链 266/266；沙箱内 262/266，四项 loopback Origin 测试按既定方法
  在沙箱外 5/5；桌面语法通过，桌面测试 114 passed / 3 个真实 Host 环境门
  skipped / 0 failed；
- Kimi 继续按用户要求暂停，本轮由主 Agent 完成 diff、Schema/模板、源码现状、
  官方要求、权限边界、负向测试和计划顺序加强自主复核；
- 对照产品蓝图与生产准备计划，本轮没有把“继续开发”扩大解释为 Apple credential
  或发布 authority，只关闭 P6 no-authority preflight。下一步真实候选必须先取得
  单独批准；P7/P8、生产发布和外部 cohort 继续关闭。

### 循环 128：P6 未签名内部体验版构建合同

状态：源码实现与合同回归已完成；等待 clean pushed executor 生成首份真实内部
DMG/ZIP。该阶段不关闭生产 R4

产品决策与实现：

1. 用户确认在客户端达到能够承担 Apple Developer Program 年费的规模前，macOS
   采用未签名、未公证的内部体验版；首次打开只指导单应用“隐私与安全性 → 仍要
   打开”，不要求全局启用“任何来源”；
2. `npm run build:mac` 现在显式路由到 `build:mac:internal`；执行器只接受 clean
   且已经推送到 `origin/main` 的 commit，并拒绝已识别的 Apple、CSC、notarization
   和发布凭据；
3. Host 使用 `/private/tmp` 隔离 Cargo target 构建，Electron 固定
   `identity: null` 与 `--publish never`；失败删除不完整输出，结束销毁临时 Cargo
   目录，不恢复仓库根 `target/`；
4. 每次成功先逐字节核对 unpacked `.app` 内 Host 与 release Host，并确认可执行位；
   随后删除 unpacked/build 调试文件，只保留当前架构的一份 DMG、一份 ZIP、strict
   `unsigned-internal-build-v1.json` 和 `SHA256SUMS`；symlink、路径穿越、大小/摘要
   漂移、重复 JSON key、持久 update metadata 或额外能力声明全部失败关闭；DMG
   关闭 update info，Electron Builder 对 ZIP 强制生成的临时 blockmap 在核验后
   删除；固定 `.icon-icns/` 图标转换缓存同样删除，其他未知目录继续拒绝；
5. receipt 固定 Developer ID、公证、Apple credential、外部上传、自动更新和
   `productionR4Satisfied` 全部为 false；同渠道 SHA-256 不冒充发布者身份，分发时
   仍需从官网或对应 Git commit 独立核对；
6. 当前 manifest 只要出现 publish、notarize、签名 identity、可执行 builder hook
   或 `electron-updater` 就拒绝内部构建，避免未来配置漂移静默扩大权限；
7. 新增中文内部发行说明，明确本阶段不做 Developer ID、Apple service、自动更新、
   外部 cohort 或生产 R4。

自主验证与计划复盘：

- 新模块 16/16、与 P6 preflight 合计 31/31；完整工具链沙箱内
  278 passed / 4 个 loopback Origin 因监听权限失败，沙箱外对应文件 5/5 通过；
- 桌面语法检查通过，完整桌面测试沙箱外 114 passed / 3 个真实 Host 环境门
  skipped / 0 failed；离线依赖审计 0 vulnerability；
- 联网 `npm audit` 因会向 npm 服务发送依赖元数据而未获准，本轮没有绕过该边界；
- Kimi 继续按用户要求暂停，本轮由主 Agent 复核构建环境、subprocess 参数、临时
  目录清理、流式摘要、Schema/receipt 一致性、生产门关闭和秘密扫描；
- 本轮没有执行真实 Host/Electron build，没有 Apple/Provider 请求、credits、
  Keychain、上传、外部 cohort 或费用；新增 executor 必须先提交并推送才能运行；
- 对照原计划，本轮只是 P6 下的受限内部工程子阶段，不改变 Cycle 127 的生产 R4
  blocked 结论，也不提前实现自动更新或启动 P7/P8；
- 下一轮先冻结并推送本 executor，再执行一次真实 arm64 内部构建，复验 DMG/ZIP、
  Host extra resource、receipt/SHA-256、临时 `target` 清理和无上传事实；通过后才
  进入未签名安装、首次打开与持久 Host 生命周期矩阵。

### 循环 129：P6 首份未签名内部 arm64 构建

状态：已完成；首份真实 `unsigned_internal_only` DMG/ZIP 已由 clean pushed commit
构建并复验，不关闭生产 R4

真实构建与产物证据：

1. 构建 commit 为 `9db201f43a49d0cc58dd466a500d40f48c8fe933`，执行时
   `HEAD == origin/main` 且工作区 clean；Host 使用 `/private/tmp` 隔离 Cargo target
   完成 release 构建，仓库根 `target/` 构建前后均不存在；
2. 沙箱内首次尝试因 Rust `protoc` 构建脚本访问 `/dev/stdout` 被系统拒绝而停止，
   随后按既定本机构建方法在沙箱外重跑；这不是产品代码或打包产物通过证据；
3. 两次真实打包分别暴露 Electron Builder 强制生成 ZIP `.blockmap` 与固定
   `.icon-icns/` 图标转换缓存；提交 `13bdbf9`、`9db201f` 将两者收敛为精确已知的
   临时项，校验后删除，其他未知文件或目录仍失败关闭；
4. 最终目录严格只含 DMG、ZIP、`unsigned-internal-build-v1.json` 与
   `SHA256SUMS`，总计约 353 MiB；ZIP 为 181,147,410 bytes、SHA-256
   `7409150d8b82466c28813fda6964b465054d88f30e7c9b9900bf8b4a0e4164d6`，
   DMG 为 181,359,004 bytes、SHA-256
   `c2cfcd1f024e39a52f253aa95e17684778afa23490ed5ed8e5d16c6702ca996f`；
5. 构建器内层已逐字节核对 packaged Host；独立 verifier 和
   `shasum -a 256 -c` 再次通过，ZIP 中
   `Resources/bin/agentmesh360-host` 为 arm64 Mach-O 且保持可执行位；
6. `hdiutil verify` 通过；只读挂载后 Bundle ID 为 `com.agentmesh360.client`、
   版本 `0.1.0`。主 Mach-O 只有 linker ad-hoc 标记，没有 Developer ID 或 Team ID；
   `codesign --verify --deep --strict` 失败，不能被描述成 Apple 签名或公证通过；
7. receipt 明确记录 Developer ID、公证、Apple credential、上传、自动更新和
   `productionR4Satisfied` 均为 false；Provider 请求 0、AgentMesh credits 0、
   Apple service 请求 0、产品/生产 mutation 0；
8. 只读 DMG 已卸载，构建临时目录为 0，未保留 unpacked App、blockmap 或图标缓存，
   仓库工作区保持 clean。

自主验证与计划复盘：

- 构建前新模块 16/16、P6 合计 31/31；完整工具链 278 passed，四项受沙箱 loopback
  限制的 Origin 测试在沙箱外对应文件 5/5；桌面 114 passed / 3 个真实 Host 环境门
  skipped / 0 failed，离线依赖审计 0 vulnerability；
- 构建后 receipt verifier、双 Artifact SHA-256、ZIP Host inventory/权限、
  DMG checksum、Bundle metadata、Developer ID 缺失、deep codesign 失败和清理终态
  均逐项复验；
- Kimi 继续按用户要求暂停，本轮为非 Kimi 独立审查，由主 Agent 对构建日志、产物
  白名单、Host、签名边界、无上传声明和临时状态完成加强复核；
- 对照产品蓝图与 P6 计划，本轮只把 unsigned internal build 从“源码合同”推进到
  “真实 arm64 产物”，没有把 ad-hoc 标记写成 Developer ID，没有进入 notarization、
  自动更新、外部 cohort、P7/P8 或生产 R4；
- 下一轮只执行隔离安装/首次启动检查点：先冻结安装与恢复矩阵，再在不覆盖既有
  `/Applications/AgentMesh360.app`、不关闭全局 Gatekeeper 的前提下验证 DMG/ZIP
  安装、单应用放行边界、后台 Host、UI detach/reopen、Login Item 状态和清理恢复。

### 循环 130：P6 未签名内部版隔离安装与生命周期

状态：已完成；冻结执行器在真实 Mac 上 11/11 通过并清场，不关闭生产 R4 或 P7

执行器与安全边界：

1. 新增 `run-isolated-lifecycle.mjs` 和中文操作清单；执行器只接受 clean pushed
   commit、绝对 strict build receipt、四文件 Artifact 边界和普通 macOS 登录用户；
2. `/Applications/AgentMesh360.app` 或 `~/Applications/AgentMesh360.app` 任一存在
   就停止，不覆盖系统安装；本轮两处均为 absent；
3. 子进程只取得 HOME、userData、AgentMesh state、PATH、locale 和固定 loopback
   Core 等白名单环境，不继承 Provider、Apple、发布或其他秘密；
4. DevTools 只绑定运行期随机 `127.0.0.1` 端口，用来调用 preload 已有的脱敏 IPC；
   不进入产品配置，App 退出后端口关闭；
5. Login Item 只有“开启 → 读取 → 关闭”一个有界往返；未确认关闭时执行器失败关闭，
   不会先输出成功；
6. DMG 只读挂载，失败会停止；第二实例、后台实例和前台 App 均有超时终止，成功后
   卸载镜像并删除完整隔离边界；
7. 本机直接构建文件通常没有浏览器 quarantine，因此自动矩阵只验证 Developer ID/
   Team ID 缺失、deep codesign/Gatekeeper assessment 不通过和必须人工单应用放行；
   不伪造官网下载后的“仍要打开”人工体验通过。

真实 11/11 结果：

- executor commit `15507ae62a58317b8bc91b39a4f98f20e1e97dd7`，Artifact commit
  `9db201f43a49d0cc58dd466a500d40f48c8fe933`；
- strict build receipt、DMG verify/只读复制、ZIP 解压、Host 与 `app.asar` 双摘要、
  Bundle ID/版本/可执行位全部通过；
- 未签名边界按预期成立：没有 Developer ID/Team ID/notarization，deep codesign 与
  Gatekeeper assessment 均不通过，人工单应用放行仍为 true，全局关闭 Gatekeeper
  为 false；
- 隔离首次启动为 `signed_out`，Host 未在身份准入前运行；关闭窗口后第二实例快速
  退出并由原主进程恢复新窗口，没有第二个 Host；
- 打包 App 的 Login Item 返回 supported，开启后为 enabled，关闭后为
  not-registered；最终明确恢复关闭；
- 未登录 `--agentmesh360-background` 无 Host/socket 并自动退出；
- 打包 Host 对 Job、Lecturecast、Deploy 三个 Agent 的不同固定 Main Session、
  Bridge detach、同一 Leader 恢复、Leader SIGKILL 后替代 Leader 与原 Session 恢复
  真实通过；
- 自动场景 11/11，Provider 请求 0、AgentMesh credits 0、Apple service 请求 0、
  上传 0、生产 mutation 0；Login Item 关闭、测试进程/挂载/socket/目录为 0，仓库
  根 `target/` absent，系统/用户 Applications 仍 absent；
- 终态进程复核发现一个本轮之前已运行约 22 小时的旧
  `desktop/dist/mac-arm64/AgentMesh360.app`，它不含本轮临时前缀且未被修改或终止。

自主验证与计划复盘：

- 新执行器 6/6，P6 合计 37/37；完整工具链 288 项中沙箱内 284 passed，四项
  loopback Origin 在沙箱外对应文件 5/5；桌面 114 passed / 3 个真实 Host 环境门
  skipped / 0 failed，语法和离线依赖审计 0 vulnerability；
- Kimi 继续按用户要求暂停，本轮为非 Kimi 独立审查；主 Agent 复核 subprocess
  参数、环境白名单、loopback 限制、Login Item 补偿、超时进程、成功输出时序、
  DMG detach、临时状态清理、秘密扫描和执行后终态；
- 对照产品蓝图和 P0-P8，本轮只完成 P6 unsigned internal 自动矩阵。它不满足 R4 的
  Developer ID/notarization/更新真实性，也不能跳到 P7/P8；
- 当前无 authority 可安全继续的 P6 自动工程项已收口。下一实际体验点是从受控下载
  渠道取得带 quarantine 的同一内部版，并由明确知情的种子用户只对单应用执行
  “仍要打开”；上传渠道、设备/cohort、窗口和清理边界必须在执行前另行冻结。

### 循环 131：P6 验收证据与种子下载无授权预检

状态：源码与本地验证已完成；真实下载 canary 保持 `not_approved / blocked`

实现与安全边界：

1. 将 Cycle 130 的终端结果补成 strict、非秘密、可机读验收证据，固定 Artifact 与
   executor commit、build receipt、DMG/ZIP 文件名/大小/摘要、11 个场景、未签名
   Gatekeeper 边界、生命周期、清理、外部使用和生产门状态；
2. 新增共享 strict JSON 读取与最小 Schema 校验，拒绝 symlink、超限文件、非法
   UTF-8、重复 JSON key、未知字段、类型/范围/顺序漂移；
3. 新增 P6 种子下载预检 Schema、模板、校验器和中文清单；模板逐字节绑定留存验收
   证据，并再次固定 build receipt、ZIP 与 DMG provenance；
4. 下载预检明确为 `authority=none`、`approvalStatus=not_approved`、
   `executionStatus=blocked`；channel、credential、账号、设备、窗口、Abort Owner
   与 retention 均为空，网络/上传/Provider/credits/Apple service/费用全部为 0；
5. 固定九项真实体验矩阵：独立 checksum、上传/readback、浏览器 quarantine、
   Gatekeeper 首次拦截、单应用“仍要打开”、订阅门、Login Item 用户选择、卸载
   清理和渠道撤回；在独立授权前全部为 `blocked`；
6. 禁止全局关闭 Gatekeeper、伪称 Developer ID/公证、自动更新、真实账号登录、
   Provider/credits 使用及生产可见性或 mutation；校验器不含网络、subprocess、
   Keychain 或上传能力。

自主验证与计划复盘：

- 新增验收证据与下载预检定向 12/12；覆盖精确 provenance、验收字节绑定、
  authority/channel/cohort/预算升级拒绝、九场景和十二 stop condition 顺序、
  Gatekeeper/签名/更新边界、留存安全、CLI 路径脱敏、重复 key、symlink、UTF-8
  和大小；
- 完整工具链 300 项中沙箱内 296 passed，四项 loopback Origin 受沙箱监听限制，
  同一 Origin 文件在沙箱外 5/5；桌面 114 passed / 3 个真实 Host 环境门 skipped /
  0 failed，语法通过，离线依赖审计 0 vulnerability；
- Kimi 按用户要求继续暂停，本轮为非 Kimi 独立审查；主 Agent 逐项复核 strict
  parser、Schema 与语义双门、证据字节绑定、能力扫描、负向测试、秘密扫描和
  P0-P8 顺序；
- 本轮没有上传 Artifact、配置渠道、登录真实账号、修改 Gatekeeper、调用 Provider/
  Apple 服务、消耗 credits 或产生费用，也没有把 unsigned internal 写成 production；
- 对照产品蓝图和生产计划，P6 本机工程证据已经收口。下一真实动作只能是在独立批准
  中冻结下载 provider/hostname/path/可见性、同一 Artifact、账号与设备、起止时间、
  Abort Owner、上传/费用上限和证据/撤回策略，再执行 quarantine 下载 canary。
  Developer ID/notarization、生产 R4、P7 和 P8 继续关闭。

### 循环 132：P6 未签名内部版本机交付

状态：已完成；DMG 只复制到 owner Mac 的 `~/Downloads`，没有在线发布

本轮结果：

1. 用户明确取消在线下载地址，改为从当前电脑直接取得安装包；
2. 复用 Cycle 129-131 已验收的 arm64 DMG，不重新构建、不改变 Artifact 字节；
3. 本机交付目录只包含 DMG、单文件 `SHA256SUMS` 和中文安装说明；
4. 交付副本与原件 `cmp` 逐字节一致，SHA-256 仍为
   `c2cfcd1f024e39a52f253aa95e17684778afa23490ed5ed8e5d16c6702ca996f`，
   `hdiutil verify` 通过；
5. 曾创建一个不含资产且不可见的 GitHub Draft；在公开上传未获明确授权时立即停止，
   Draft 已删除，公开 Release、tag 和上传资产均为 0；
6. 没有使用 DigitalOcean、Provider、credits、Apple service 或产生费用。

计划复盘：

- 本轮只改变交付位置，不改变产品代码、构建 receipt、未签名状态或生产门；
- 本地复制不会产生浏览器 quarantine，因此下一真实验证是 owner 从本机 DMG 安装，
  观察首次启动、订阅登录和持久 Agent；它不能代替未来公开下载后的 Gatekeeper
  场景；
- Kimi 继续按用户要求暂停。本轮由主 Agent 复核本机目录冲突、Artifact 摘要、
  逐字节一致性、DMG checksum、在线 Draft 清理和计划边界；
- Developer ID/notarization、自动更新、生产 R4、P7/P8 和在线分发仍关闭。

### 循环 133：后台订阅复验不再打断工作区

状态：已完成；修复已提交、推送，并生成和交付新的本机未签名内部体验版

用户体验问题与根因：

1. owner 内部体验发现，客户端每次切回窗口超过 30 秒、每 5 分钟定时复验、Mac
   恢复或 Host 重连时，都会把已有 `ready` 身份切换为 `checking`；
2. Renderer 把所有 `checking` 都当成首次准入，使用全屏“正在建立安全工作区”替换
   整个工作区 DOM；
3. 这不仅造成视觉中断，还会直接销毁 Provider 表单和对话输入框，因此用户尚未提交
   的显示名称、Base URL、模型列表、API Key 或消息草稿可能丢失；
4. 该问题属于客户端状态建模与渲染错误，不是用户订阅无效，也不是 Provider 配置
   错误。

本轮实现：

1. 首次启动、登录、从 blocked 手动复验仍使用阻塞式 `checking`；已经进入工作区的
   focus/periodic/resume/Host reconnect 复验保持原 `ready` 状态，验证完成后只发布
   新的 `validationRevision`；
2. Renderer 将同账号 `ready → ready` 的新验证版本识别为后台身份刷新，只原位更新
   账号、订阅、credits 和验证时间，不重建当前工作区 DOM；
3. 窗口 focus 不再按 30 秒固定触发，只有上次成功验证已超过既有 5 分钟复验周期且
   当前没有身份操作时才补做复验；周期复验、系统 resume 和 Host reconnect 仍保留；
4. 安全门没有放宽：刷新令牌过期仍立即清除安全身份并回到登录页，订阅失效、
   Core/Host 不一致或 Host 不可用仍按原规则失败关闭；
5. 为已有 Provider Electron smoke 注册 `npm run test:provider-ui`，使本轮关键回归
   可以直接重复执行。

测试用例与结果：

- 身份控制器 14/14：覆盖后台复验等待期间保持 `ready`、完成后只发布一次 `ready`、
  focus 五分钟 freshness、刷新令牌过期仍失败关闭；
- 完整桌面 Node 测试 117 passed / 3 个真实 Host 环境门 skipped / 0 failed；
- Provider Electron UI 回归通过：填入未保存的显示名称、Base URL、模型列表和合成
  测试 Key 后注入一次 focus 复验结果，原表单节点和全部字段保持不变，全屏 spinner
  不存在；
- Conversation 与 Package Electron UI 回归均通过；`npm run check` 和
  `git diff --check` 通过；
- 沙箱内完整测试的五个 OAuth 用例因 loopback 监听权限失败；按既定方法在沙箱外
  重跑完整测试后全部通过，未把环境限制记成产品缺陷；
- Kimi 继续按用户要求暂停。本轮由主 Agent 对完整 diff、身份状态机、focus 频率、
  失败关闭语义、Renderer DOM 保留、秘密投影和测试结果进行加强自主复核。

构建与本机交付：

- 修复 commit `dc8d9e78c82761b5084a052bc71c82f95348705e` 已推送到
  `origin/main`；构建时 `HEAD == origin/main` 且工作区 clean；
- 沙箱内首次构建命中既有 `protoc` `/dev/stdout: Operation not permitted` 限制，
  构建器失败关闭并清除临时目录；沙箱外按既定方法重跑后通过；
- strict receipt 为 `desktop_internal_p6_dc8d9e78c827_arm64`，输出仍是
  `unsigned_internal_only`，Developer ID、公证、Apple credential、上传、自动更新、
  Provider 请求、credits 和费用全部为 0/false；
- ZIP 为 181,148,642 bytes，SHA-256
  `4e5744347a6c65e4f841fa8dba282360c90e3a2274f0a129407aaf5afdcfd46d`；
  DMG 为 181,359,593 bytes，SHA-256
  `934efda2d050a92bdc119885408c7f8dcb9ffc3313e065395e77fc47305b4d86`；
- strict receipt verifier、双 Artifact `shasum -c`、DMG `hdiutil verify`、ZIP 内
  `app.asar` 与可执行 arm64 Host inventory 均通过；仓库根 `target/` 和构建临时
  目录均为空；
- 新 DMG 已逐字节复制并复验到
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-30-dc8d9e7-arm64/`，附单文件
  `SHA256SUMS` 和中文安装/验收说明；旧安装包未删除，避免无授权覆盖用户文件。

计划复盘与下一轮：

- 本轮只修复已登录工作区的后台复验体验，没有改变“订阅无效不能进入客户端”的产品
  规则，没有引入新 Provider、调用模型、消耗 credits 或触碰 Package/生产发布门；
- 新包已经交付，下一步继续 owner UAT。当前已记录的下一项用户可见问题是简化 Provider
  配置与首次使用引导；它们必须作为独立产品切片执行，不与本轮修复混做重构。

### 循环 134：后台复验期间 Provider 不再误报未认证

状态：已完成；修复、验证、推送与新本机未签名内部体验版均已交付

用户问题与根因：

1. Cycle 133 让已登录工作区在后台订阅复验期间继续可用，但 Host 的
   `ClientAccess::bootstrap` 仍会在发出 Core 请求前立即把旧授权清成
   `Unverified`；
2. 新订阅结果返回前存在一个短暂授权空窗。用户此时进入 Provider 页面，
   `providers/list` 会命中 Host 的认证门并返回 `Authentication required`；
3. Renderer 又把 Electron IPC、方法名和 `HostRequestError` 原样显示，因此形成
   “Provider 页面进不去”的用户可见故障；
4. 这不是 Provider Key、模型配置或用户订阅失效，而是后台复验与业务请求的时序
   错误。

本轮实现：

1. 桌面 ACP Client 为账户 bootstrap 建立顺序门；订阅复验尚未结束时，Provider、
   Package、Agent 与其他 Host 扩展请求在本机短暂等待，验证完成后自动继续，不触发
   全屏 loading，也不重建或清空 Renderer 表单；
2. Host 将授权刷新改为原子替换：非空 Token 发起复验时保留尚在有效期内的旧
   `Granted` 状态，新结果成功返回后一次性替换；401/403、网络失败、合同非法或订阅
   拒绝落定后仍按原规则失效或进入 Denied；
3. 空 Token 注销仍立即清空 Host 授权；Core 与 Host 结果不一致、订阅失效和登录过期
   的失败关闭语义没有改变；
4. Renderer 不再展示 `provider:get-snapshot`、Electron remote method 或
   `HostRequestError` 等内部错误链；极短恢复窗口只显示“本地身份正在恢复，请稍后
   重试。”

验证与自主复核：

- ACP Client 14/14：新增确定性延迟 bootstrap 回归，证明 Provider 请求在验证完成前
  没有进入 Host，完成后自动继续；
- Rust Host access 定向 6/6：覆盖成功刷新等待期保留旧授权，以及失败刷新结果落定后
  清除旧授权；原有 active、denied、401、合同/可信时间失败关闭测试继续通过；
- 完整桌面测试在本机 loopback 环境中 118 passed / 3 个真实 Host 环境门 skipped /
  0 failed；沙箱内只有既有五个 OAuth loopback 权限失败，不属于产品回归；
- Provider Electron UI smoke 通过：未保存表单仍保留，认证错误只显示稳定中文文案，
  内部 IPC/Host 错误不进入 DOM；Conversation 与 Package UI smoke 均通过；
- `npm run check`、`cargo fmt --all --check`、`git diff --check` 通过；
- Kimi 继续按用户要求暂停。本轮由主 Agent 复核跨层时序、失败关闭、注销语义、
  Renderer 脱敏、共享 ACP Client 影响面和产品计划顺序。

构建与本机交付：

- 修复与首轮进展 commit `d35da9c9657ae9bb1d29363a1e4a0748415ebb16` 已推送
  `origin/main`，内部构建开始时 `HEAD == origin/main` 且工作区 clean；
- strict receipt 为 `desktop_internal_p6_d35da9c9657a_arm64`，状态
  `unsigned_internal_only / passed`；Developer ID、公证、Apple credential、
  上传、自动更新、Provider 请求、credits 和费用均为 0/false；
- ZIP 为 181,153,933 bytes，SHA-256
  `396f843c5fc58f6af65c5d544cee7006be11d60cf578f12490e9f1bda5c68c64`；
  DMG 为 181,360,639 bytes，SHA-256
  `144c5bdf38a2d95e8e46e4fa8c5ab7a2e81929863bcc361a94c11c3b27e0a409`；
- strict receipt verifier、双 Artifact `shasum -c`、DMG `hdiutil verify` 与构建器
  包内 Host 字节/arm64 inventory 均通过；
- DMG 已逐字节复制并复验到
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-30-d35da9c-arm64/`，附单文件
  `SHA256SUMS` 和中文安装/验收说明；旧包未删除，也没有在线发布。

计划复盘与下一轮：

- 本轮是 Cycle 133 的直接 UAT 缺陷修复，没有改变订阅有效才能进入客户端、BYOK、
  credits、Provider Key 本地保存或 Package/生产发布边界；
- 原定下一产品切片仍是“简化 Provider 配置”，随后才是首次使用引导；本轮没有借机
  重构 Provider Catalog、增加模型供应商、调用 Provider 或扩展生产 authority；
- 当前缺陷包已经完成。下一轮回到既定产品顺序：先简化 Provider 配置，再做首次使用
  引导；不把本次修复扩展成 Provider Catalog 或生产发布重构。

### 循环 135：Provider 自动配置与测试后保存

状态：功能、验证、推送、新本机未签名内部体验版与磁盘清理均已完成

用户问题与产品判断：

1. 官方 Google Gemini 虽然实际使用其 OpenAI Chat Completions 兼容接口，但原页面
   直接要求普通用户选择“协议”和“认证”，容易被误解为 Gemini 被错误配置成 OpenAI；
2. 原表单只有“安全保存”，用户无法在 Key 写入本机 Vault 前确认 API Key、模型 ID、
   网络和接口地址是否真的可用；
3. 该问题属于 Provider 接入体验，不需要增加供应商、改变 Catalog、修改 BYOK/订阅/
   credits 规则，也不应把现有已保存 Profile 的诊断 Probe 混同为新 Profile 的前置测试；
4. 本轮严格执行 Cycle 134 记录的既定顺序：先完成 Provider 配置简化，首次使用引导
   留到下一独立切片。

本轮实现：

1. Provider 下拉框按“官方供应商（自动配置）”与“兼容和本地接口（高级）”分组；
   官方 OpenAI、xAI、Anthropic、Google Gemini 选择后自动写入 Catalog 声明的协议、
   认证方式、官方 Base URL 和模型，不再要求用户判断技术字段；
2. 官方配置只展示“已自动配置”说明，技术内容收进可折叠的“查看技术信息”；
   原始协议和认证控件只在兼容/本地/自定义端点的“高级连接设置”中出现，并使用
   “OpenAI Chat Completions 兼容”等中文语义；
3. 新增 `providers/test-connection` Host ACP 方法。它使用尚未保存的
   `ProviderProfileInput`、测试模型和一次性 API Key 建立 Grok Sampling Client，
   发出最小推理并只返回非秘密结果；
4. 测试 Key 从 ACP 请求移入 `SecretValue` 零化内存和不可序列化 resolver；测试路径
   不写 Credential Vault、Provider Profile、Assignment、Session Binding、
   Turn Route 或 Probe history，也不把模型响应文本返回 Renderer；
5. 测试前必须明确确认“可能产生极小 Provider 费用”；页面同时明确不消耗
   AgentMesh credits、不写 Agent 会话、未保存 Key 不会落库；
6. 新 Provider 的“安全保存”默认禁用，只有真实测试返回非空模型响应后才解锁；
   Key、模型、协议、认证或地址发生变化会立即使旧测试失效并重新禁用保存，名称变化
   不会无意义地要求重测；
7. 编辑现有 Provider 可保留原配置直接保存名称；若更换 Key、模型或连接字段，则必须
   重新输入 Key 并测试。客户端不会为了测试而读回已经保存在系统 Vault 的 Key；
8. 连接失败、超时、无文本、身份恢复和本地输入错误均投影为稳定中文说明，不把
   Electron IPC、Host 错误链、authorization 或 Key 显示到页面。

验证与自主复核：

- Provider Host 定向回归 6/6：覆盖未确认零网络、订阅拒绝零网络、已保存 Probe、
  未保存 OpenAI Chat 兼容请求、Bearer Header、模型 ID、非空响应，以及测试后
  Profile/Probe history 仍为空；
- 完整 AgentMesh360 Host lib 回归 191 passed / 1 个显式外部源测试 ignored /
  0 failed；
- 桌面完整 Node 回归 120 passed / 3 个真实 Host 环境门 skipped / 0 failed；
  Provider Controller + ACP 定向 22/22；
- Provider Electron UI smoke 通过：未测试时提交不会创建 Profile，官方配置隐藏
  高级协议，确认后测试请求只携带一次 Key，成功后才允许保存，保存后 Key 从 DOM
  清空；原后台复验表单保留和认证错误脱敏用例继续通过；
- Conversation、Package Electron UI smoke、`npm run check`、`cargo fmt --all
  --check`、`git diff --check` 均通过；官方供应商自动配置视觉状态已由主 Agent
  本机截图复核；
- Kimi 继续按用户要求暂停。本轮由主 Agent 复核完整 diff、Catalog/UI 语义、
  测试前订阅门、付费确认、一次性凭据生命周期、非持久化证明、Renderer 脱敏、
  测试结果失效规则和 P0-P8 计划顺序；
- 自动测试只连接本机 loopback mock，没有调用真实 Provider、使用用户 Key、
  消耗 AgentMesh credits 或产生费用。

构建与本机交付：

- 功能 commit `1fe769f116e2b9668f54d7ded6fd3c952246cf7b` 已推送
  `origin/main`；构建开始时工作区 clean 且 `HEAD == origin/main`；
- strict receipt 为 `desktop_internal_p6_1fe769f116e2_arm64`，状态
  `unsigned_internal_only / passed`；Developer ID、公证、Apple credential、上传、
  自动更新、Provider 请求、AgentMesh credits 和费用均为 0/false；
- ZIP 为 181,172,601 bytes，SHA-256
  `bad92c5f1dfc3f034c3eb4cdcd312d0d99fc664d1c955311c8ad43c29006ffa5`；
  DMG 为 181,414,072 bytes，SHA-256
  `76e5e865546a15bc062abd0e071775169413d247ac1f47fff9f3dde2053d0c07`；
- strict receipt verifier、双 Artifact `shasum -c`、DMG `hdiutil verify` 与 ZIP 内
  `app.asar` / 161,419,520-byte 打包 Host inventory 均通过；
- DMG 已逐字节复制并复验到
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-30-1fe769f-arm64/`，附单文件
  `SHA256SUMS` 和中文安装/验收说明；旧体验包未删除，也没有在线发布；
- 构建与测试产生的仓库根 `target/` 已按 owner 既定要求清空，回收约 20 GiB；
  本轮保留 346 MiB 构建证据目录和 173 MiB 本机交付目录。

计划复盘与下一轮：

- 本轮没有增加 Provider、修改模型能力、自动分配角色、触碰 Package/生产发布、
  Developer ID、公证或自动更新；BYOK 与“订阅无效不能进入客户端”的规则不变；
- Provider 配置简化切片已完成，下一产品切片按原计划是首次使用引导：让首次登录者
  清楚看到“先配置 Provider，再打开/激活 Agent，再开始对话”的产品路径；
- 在完成本轮提交、推送、内部构建与本机交付前不启动首次使用引导，避免把两个产品
  切片混为一次无边界重构。

### 循环 136：内部测试包单版本留存

状态：已完成；旧包与重复构建产物已清理，单包留存规则已固化

用户要求与执行边界：

1. owner 明确要求后续每次生成并验证新包后删除上一份测试包，始终只保留最新一份，
   避免内部构建持续占满磁盘；
2. 清理范围只包括 AgentMesh360 内部体验版交付目录、历史构建证据目录和
   `desktop/dist/` 的重复中间产物，不删除 `/Applications/AgentMesh360.app`，
   不触碰账户、Provider、Agent、会话或其他项目文件；
3. 删除前重新执行最新 `1fe769f` 下载包单 Artifact `SHA256SUMS` 和构建归档双
   Artifact `SHA256SUMS`，DMG 与 ZIP 均通过，确认存在可保留的最新有效包。

清理结果：

1. `~/Downloads` 原有 4 个 AgentMesh360 测试包目录，已删除 3 个旧版本，只保留
   `AgentMesh360-Internal-Test-2026-07-30-1fe769f-arm64/`，占用约 173 MiB；
2. `desktop/dist/internal/` 原有 4 个版本，已删除 `dc8d9e7`、`d35da9c` 和
   `9db201f` 三个历史归档，只保留
   `0.1.0-1fe769f116e2-arm64/`，占用约 346 MiB；
3. `desktop/dist/` 根目录的重复 DMG、ZIP、blockmap、unpacked App、builder
   调试文件和图标转换缓存均已删除；最终只有一个下载交付包和一个与之对应的构建
   证据目录；
4. 已知历史目录至少释放约 1.5 GiB，另清除了同轮构建根目录的重复 Artifact 与
   中间产物；清理后数据卷可用空间约 37 GiB。

规则固化与计划复盘：

- `P6_UNSIGNED_INTERNAL_DISTRIBUTION.md` 已新增 fail-safe 单包留存规则：新包必须先
  完成 receipt、摘要、DMG 和交付副本复验，再删除上一包；若新包失败则保留上一份；
- 后续每次打包完成都执行相同清理，并在进展文档记录保留版本和最终状态；
- 本轮只处理本机发行产物留存，没有修改运行时代码、订阅、BYOK、Provider、
  credits、Package、Developer ID、公证或生产发布边界；
- 复核既定产品顺序后，下一产品切片仍是首次使用引导：清楚呈现“配置 Provider →
  激活/打开 Agent → 开始对话”，不因本次磁盘清理改变开发方向。

### 循环 137：动态模型发现与主流 Provider 一等支持

状态：完成

owner UAT 问题与产品判断：

1. 原页面仍把 Catalog 示例模型自动填入表单，用户看起来只能使用一个固定模型；
2. 连接测试把包含 `HostRequestError` 的任意错误误判成“接口地址无效”，真实 Key
   失败时没有可行动诊断；
3. 模型发现成功后“测试连接”按钮没有重新启用，自动化复核发现并在本轮修复；
4. 现有四个官方预设不足以覆盖 owner 明确要求的 OpenAI、xAI、DeepSeek、GLM 与
   Kimi；GLM/Kimi 的普通 API 和 Coding Plan 不能混成同一个入口。

本轮实现：

1. 官方 Provider 改为“选择供应商 → 输入 Key → 官方目录动态读取模型 → 选择模型
   → 最小真实推理 → 保存”，不再以 Catalog 示例模型充当用户选择；
2. Host 新增一次性模型发现 ACP 方法，禁止重定向，12 秒超时，响应上限 1 MiB、
   模型上限 512；Key 只进入零化内存，不写 Vault/Profile/Probe/Session；
3. Catalog revision 3 增加 DeepSeek、GLM API、GLM Coding Plan、Kimi 国际 API、
   Kimi 中国 API 与 Kimi Coding Plan；合计十个官方入口，全部固定官方端点；
4. xAI 使用 `/language-models` 并纳入 alias；其余官方预设使用 `/models`；
   模型目录成功只解锁模型选择，仍需真实推理返回非空文本后才能保存；
5. GLM/Kimi Coding Plan 展示专属 Key、专属端点和官方适用范围提示；Kimi
   Standard/HighSpeed 保留官方稳定 ID，但实际选项仍以当前 Key 响应为准；
6. Anthropic Sampling 路径补齐强制 `anthropic-version: 2023-06-01`，修复真实
   Messages 请求可能因缺 Header 失败的问题；
7. 表单控件增大到至少 50px、输入文字 13px，模型改成动态单选框；错误分类区分
   认证、权限、模型不存在、限流、网络、超时、空响应，IPC/Host 原始错误不进 DOM。

验证与自主复核：

- AgentMesh360 Rust lib：195 passed / 1 ignored / 0 failed；
- Provider Rust 定向：19 passed / 0 failed；
- 桌面 Node：122 passed / 3 个真实 Host 环境门 skipped / 0 failed；
- Provider Controller + ACP Client 定向：24 passed / 0 failed；
- Provider Electron UI smoke 完整通过十个官方入口、模型发现、模型选择、测试门禁、
  保存、Key 清空、后台复验草稿保留与错误脱敏；
- Conversation 与 Package Electron UI smoke 均通过；
- 1180px Kimi Coding Plan 视觉状态由主 Agent 复核，表单尺寸、流程、套餐提示和
  动作层级清晰；
- 自动测试只使用 loopback mock，没有使用用户真实 Provider Key，没有 Provider
  推理请求、AgentMesh credits 或费用；
- Kimi 独立复核继续按 owner 要求暂停，本轮由主 Agent 自主检查跨层合同、安全边界、
  官方端点、UI 状态机、完整 diff 和既定产品顺序。

提交、推送与内部包：

- 功能与文档 commit：`9e6ea87439d606f87a651fc364c0c443313d73cf`，已推送
  `origin/main`；
- 从该 clean pushed commit 构建
  `desktop_internal_p6_9e6ea87439d6_arm64`，receipt verifier、构建目录双
  `SHA256SUMS`、`hdiutil verify` 和 Downloads 交付副本逐字节复验全部通过；
- DMG：181397339 bytes，
  `1143297c8b86c338febc7c12104bed7a6678834025cb0dadb4da72722e4d4668`；
- ZIP：181182416 bytes，
  `6686908b0d001ea7e34855ad79f5be092c4a9f557da269292c9795975c27408d`；
- owner 本地交付目录：
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-30-9e6ea87-arm64/`；
- 已删除上一份 `1fe769f` Downloads 包、上一份构建证据和本轮 24GB 隔离 Rust
  target；仓库根 `target/` 仍不存在；
- 最终只保留一份 Downloads 交付包和一份对应的 `desktop/dist/internal` 构建证据，
  `desktop/dist/` 根没有重复 DMG、ZIP、blockmap、unpacked App 或调试文件；
- 构建与复验没有 Provider 请求、AgentMesh credits、Apple service、上传或费用。

计划复盘与下一轮：

- 本轮是 Cycle 135 Provider 配置简化的直接 UAT 完善，没有改变订阅有效才能进入、
  BYOK 默认、Key 本机保存、持久 Agent、Package 或未签名内部发行边界；
- owner 本轮明确扩展 Provider 范围，因此新增官方预设属于已授权产品范围，不是自行
  延伸；价格比较、余额读取、自动模型推荐与 capability 推断没有加入；
- 本轮 commit/push/单包替换已经完成；下一产品切片仍回到首次使用引导，呈现“配置
  Provider → 激活/打开 Agent → 开始对话”，不提前启动 P7/P8 或在线分发。

### 循环 138：内部包安装后旧持久 Host 未轮换

状态：完成

owner UAT 事实：

1. `9e6ea87` DMG 与 `/Applications/AgentMesh360.app` 的 `app.asar`、打包 Host
   均包含 DeepSeek、GLM 与 Kimi；
2. 新 Electron 于 22:35 启动，但专属 Leader 仍是 21:50 启动的旧进程；
3. 新 stdio Bridge 因新旧 Host 都报告上游固定 `0.2.106`，合法采用了旧 Leader，
   Provider Catalog 因而仍显示上一包内容；
4. 受控终止旧 PID 后，当前安装包立即于 22:41 拉起新 Leader，证明 Artifact 和
   Provider 实现正确，缺陷位于常驻 Host 的升级传播。

修复：

- Desktop 版本提升至 `0.1.1`，ACP `clientVersion` 改为直接读取 `package.json`，
  后续不再手工漂移；
- 内部构建从 Desktop 版本与 source commit 时间派生 `1000.x.y` 单调 Host runtime
  SemVer，并使用专属 `AGENTMESH360_HOST_RUNTIME_VERSION` 编译 Host；
- 构建器在 electron-builder 前实际运行 release Host `--version`，必须逐字匹配
  派生版本与 commit，否则失败关闭；
- 新 Bridge 复用 Grok 现有严格版本方向、锁、有界让位和重连流程替换旧 Leader；
  旧客户端不能驱逐更高版本 Leader；
- 没有读取或迁移账户、Provider Key、Agent、Session、Workspace；本机旧 Leader
  轮换后持久数据路径保持不变。

当前验证：

- 桌面 Node：122 passed / 3 个真实 Host 环境门 skipped / 0 failed；
- 内部构建器：19 passed / 0 failed；
- Leader Rust：30 passed / 0 failed；
- 专属 runtime version 方向定向测试：1 passed / 0 failed；
- `xai-grok-version` 与 `xai-grok-shell` Clippy `-D warnings` 通过；
- `cargo fmt --all`、桌面语法检查和 `git diff --check` 通过；
- 所有自动测试均为本机隔离环境，没有 Provider 请求、credits 或费用。

构建门禁复盘：

- 首次 `0.1.1` Release 构建在 Host `--version` 精确门禁处按设计失败，上一份可用包
  未删除；
- 复核确认 Host 已嵌入新 runtime version，但 `--version` 会读取 owner 现有
  `~/.grok/version.json` 并追加 channel 标签，导致构建器把展示装饰误判为注入失败；
- 构建器现使用隔离 `HOME` 与 `GROK_HOME` 检查 release Host，既不读取用户 Grok
  缓存，也继续要求原始 runtime version 与 commit 逐字匹配；补齐相应单元回归后
  再重新生成候选包；
- 隔离后第二次构建继续由同一精确门禁拦截；隔离诊断证明 `xai-grok-version`、
  Leader 与 ACP 已嵌入 `1000.x.y`，但实际 `--version` 由 `xai-grok-pager`
  自己的 build script 生成，该入口仍只读取上游 `GROK_VERSION`，所以展示
  `0.2.106`；
- 已把专属 runtime version 同步补入 Pager CLI build script，并给
  `xai-grok-version` 的 build script 增加环境变化追踪；下一候选包必须在真实
  `--version` 输出中同时证明版本与 commit，避免只修半条版本链路。

真实安装与交付证据：

- 修复 commits `882ba9e`、`a4f6d8a`、`79005ea` 已推送 `origin/main`；
- 从最终 clean pushed commit `79005ea2f0744251cd00c28963aaca8742ea27ba`
  构建 Desktop `0.1.1`；打包 Host 实际输出
  `grok 1000.1.1785426085001 (79005ea)`；
- 旧安装基线为 Desktop `0.1.0 / Host 0.2.106 (9e6ea87)`；旧 Leader PID
  `17250` 保持常驻时覆盖安装并启动 `0.1.1`，旧 PID 自动退出；
- 当前新 Electron、stdio Bridge、Leader 分别为 PID
  `27515 / 27577 / 22000`，均从 `/Applications/AgentMesh360.app` 正常启动；
- owner 账户仍恢复为 `jiyangnan@gmail.com`，本地身份凭据文件和状态目录保留；
  未读取 Key 或会话正文，运行只新增正常缓存/锁文件；
- 真实 Provider 页面显示 Catalog revision 3，供应商下拉逐项可见 OpenAI、xAI、
  Anthropic、Google Gemini、DeepSeek、智谱 GLM API、智谱 GLM Coding Plan、
  Kimi 国际/中国 API 与 Kimi Coding Plan；
- 最终 receipt `desktop_internal_p6_79005ea2f074_arm64`、双
  `SHA256SUMS`、`hdiutil verify` 与 Downloads 交付副本逐字节复验全部通过；
- DMG：181398630 bytes，
  `d092ab82af2cd5c2b1a1c70956c11cb2825ea75e62437b0332cc80f73be162e2`；
- ZIP：181183125 bytes，
  `15ebc6ea5360fa7368ff443dda132fa54688f1bf50ef6f1c5ef1eb05032ef00d`；
- owner 本地交付目录：
  `~/Downloads/AgentMesh360-Internal-Test-2026-07-31-79005ea-arm64/`；
- 已删除 `9e6ea87` 旧交付包与旧构建证据、诊断 Rust target、临时旧 App 备份，
  并卸载 5 个遗留旧 DMG 与本轮验证 DMG；最终只保留一份 Downloads 包与一份
  `desktop/dist/internal` 构建证据，仓库根 `target/` 不存在；
- 构建、复验和可见 UI 检查没有 Provider 请求、AgentMesh credits、Apple 服务、
  外部上传或费用；Kimi 交叉测试继续按 owner 指令暂停，本轮由主 Agent 自主复核。

计划复盘：

- 这是 Cycle 137 的真实安装回归，没有新增产品能力；真实“旧 Leader 运行 →
  安装新包 → 新 Leader 接管 → 十个 Provider 可见”已完成，Cycle 138 关闭；
- 下一产品切片仍是首次使用引导，不提前进入价格、余额、自动路由、
  P7/P8 或在线分发。

### 循环 139：产品用户旅程测试基线、GLM 5.2 连接修复与草稿恢复

状态：功能与自动化已完成；等待 clean pushed commit 的单包构建、安装复验和最终留存

owner UAT 与根因：

1. owner 使用真实 GLM Coding Plan Key 已成功动态读取 8 个模型，但选择
   `glm-5.2` 后，连接测试收到 Provider 响应却判为没有有效内容；
2. 智谱官方合同显示 GLM Coding Plan 的 OpenAI Chat Base URL 为
   `https://open.bigmodel.cn/api/coding/paas/v4`，`glm-5.2` 默认开启思考，可用
   `reasoning_effort=none` 关闭；原连接测试只有 16 个输出 token，可能全部消耗在
   `reasoning_content`，没有可见 `content`；
3. 这说明此前测试按模块堆叠，但缺少“真实用户故事 → 输入 → 交互 → 预期输出 →
   失败恢复”的全产品基线，owner 才会成为首个发现产品断点的人。

本轮实现：

1. `docs/test-cases/test-cases.md` 已重写为 45 条核心旅程，覆盖安装、登录、订阅、
   持久 Agent、会话、Provider、Package、后台 Host 和本地交付 9 个领域；
2. 每条用例固定用户故事、优先级、设计状态、前置条件、输入、交互步骤、预期输出、
   失败恢复、验证层和本轮结果；新增机器校验器，低于 30 条、缺字段、缺领域或状态
   非法都会失败；
3. GLM 修复只对 Catalog 复验后的官方 `glm` / `glm-coding-plan` 与精确
   `glm-5.2` 连接测试注入 `reasoning_effort=none`，仍使用短提示、无工具和 16-token
   上限；其他模型、Provider 与自定义端点完全不变；
4. 新增 wire 回归，真实解析一次本机 SSE 请求，证明请求包含
   `"reasoning_effort":"none"`、模型 `glm-5.2` 和有界输出，并且可见 `content`
   才判通过；
5. 按新用例进行真实客户端操作时，又发现 Provider 与对话草稿在侧栏切换后被清空；
   已加入账户内 Renderer 内存草稿恢复，账户切换、注销和成功提交时清理；
   Provider Key 只恢复到 password input 的 value property，不进入 HTML markup、
   Host、日志、SQLite 或构建证据。

当前验证：

- AgentMesh360 Rust：197 passed / 1 ignored / 0 failed；
- GLM 定向单元与本机 wire：2 passed / 0 failed；
- `xai-grok-shell --lib` Clippy `-D warnings` 与 `cargo fmt --all -- --check` 通过；
- Desktop Node：122 passed / 3 个显式 real-Host 环境门 skipped / 0 failed；
- Repository 工具链：306 passed / 0 failed；
- Provider、Conversation、Package 三组 Electron UI smoke 全部通过；新增复验证明
  Provider 名称、协议、地址、模型、假 Key 和对话草稿跨侧栏切换保留，假 Key/草稿
  不出现在 HTML markup；
- 真实安装版只用本地假 Key 完成供应商目录和草稿失败复现，没有点击模型发现或连接
  测试，没有 Provider 请求、AgentMesh credits 或费用；
- 修复后真实 GLM `glm-5.2` 付费最小请求仍需本轮明确费用授权，而且 Host/Vault
  不提供 secret readback；因此当前只保留为外部真实服务阻断，不借用旧授权、不读取
  owner Key，也不把 loopback 回归冒充真实 Provider 通过；
- Kimi 按 owner 指示继续暂停，本轮由主 Agent 自主复核。

计划复盘与下一步：

- 本轮没有新增 Provider、改变 BYOK/订阅硬门、实现 fallback、读取真实 Key、触碰
  Package 生产 Trust、P7/P8、Apple Developer ID、公证或在线分发；
- 当前只剩从 clean pushed commit 构建 unsigned internal arm64 包、覆盖安装验证
  新 Host 接管与草稿修复、确认唯一包留存，再回填最终 receipt 和摘要；
- 包交付后下一产品切片仍是首次使用引导，把“配置 Provider → 激活/打开 Agent →
  开始对话”的路径直接展示给首次用户；不会因本轮测试体系建设改变既定产品顺序。
