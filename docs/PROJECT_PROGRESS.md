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
| 持久产品 Agent | Registry、确定性 Main Session、激活、恢复与 pin 基础已实现 | 独立后台 Host、自启动与 UI 重连 |
| 订阅硬门禁 | Core、Host 与桌面身份外壳已经接通 | OAuth 不是当前 Provider 主线前置条件 |
| Provider Control Plane | 切片 A/B 已完成：Profile/Vault、Catalog、Capability、Policy、Assignment、RouteCompiler | 切片 C：不可变 Session Binding 与 Turn 路由快照 |
| Provider Sampling | 仍使用 Grok 原有配置路径，AgentMesh 路由尚未接入 | 切片 D：PreparedRoute 投影到现有三协议 Backend |
| Provider UI | 尚未向 Renderer 暴露 Provider 管理能力 | Session Binding 完成后实现最小设置 UI |
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

本地提交：`feat: add provider catalog and routing control plane`

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

状态：开发中

本轮目标：

1. 固化 `SessionProviderBinding` 的追加式 revision 与非秘密快照契约；
2. 首次绑定保存完整 `PreparedRoute` 快照，Profile/Catalog/Assignment 更新不改写它；
3. 显式切换时生成新 binding revision，同时保留旧 revision；
4. 建立每 Turn 的非秘密实际路由记录接口，为切片 D 调用；
5. Profile 删除或 Key 失效时保留 Binding 与历史，但执行必须失败关闭。

本轮非目标：不发送真实模型请求、不声称跨 Provider 历史可无损迁移、不实现 UI。

完成切片 C 后再次更新本文档并复盘，再进入切片 D。切片 D 的第一步不是注入 Key，
而是先清除 Grok Sampling/subagent 日志中的认证值片段并建立泄露回归测试。
