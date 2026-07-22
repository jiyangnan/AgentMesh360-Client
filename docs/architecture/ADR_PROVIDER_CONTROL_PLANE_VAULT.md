# ADR：Provider Control Plane、Host Vault 与 Profile 生命周期

状态：已接受，切片 A-D1 实施依据

日期：2026-07-23

相关文档：

- [`CC_SWITCH_PROVIDER_RESEARCH.md`](CC_SWITCH_PROVIDER_RESEARCH.md)
- [`PRODUCT_BLUEPRINT.md`](PRODUCT_BLUEPRINT.md)
- [`PERSISTENT_PRODUCT_AGENTS.md`](PERSISTENT_PRODUCT_AGENTS.md)

## 背景

AgentMesh360 Client 采用 BYOK。用户的 Provider API Key 必须支持持久产品 Agent 在
Electron 窗口关闭后继续工作，因此秘密不能由 Renderer、Electron 生命周期或 Agent
Package 持有。Grok Build 已有 OpenAI Responses、OpenAI Chat Completions 和
Anthropic Messages Sampling Backend，但现有 `auth_provider` 是运行外部命令并读取
bearer token 的 Helper，不是操作系统安全凭据库。

本 ADR 固定切片 A 的所有权、持久化、管理 API 和失败语义。它不实现 Catalog、
RouteCompiler、模型能力探测或 Session Binding；这些属于后续切片。

## 决策

### 1. Control Plane 与 Sampling 数据面分离

AgentMesh360 Host 拥有 Provider Control Plane：Provider Profile、CredentialVault、
Model Assignment、Session Binding 与 RouteCompiler。Grok Build 继续拥有 Sampling
数据面。后续路由只能按以下方向流动：

```text
Host Control Plane
  -> PreparedRoute + 短生命周期内存凭据
  -> Grok SamplingClient
  -> 用户选择的 Provider
```

AgentMesh360 不建立第二套推理循环或 HTTP Sampling 栈。

### 2. Provider Profile 与秘密分离

`state.db` 只保存非秘密 Profile 字段：

- 本地 Profile ID 和 AgentMesh360 `owner_account_id`；
- Preset ID、显示名、协议、Base URL、认证类型；
- 用户启用的模型 ID；
- Host 签发的随机不透明 `credential_ref`；
- Key 最后四位、配置状态和时间戳；
- 单调递增的 `route_revision`。

完整 API Key、Refresh Token、Cookie、云私钥和认证 Header 值不得进入 SQLite、
Session、日志、错误响应、Catalog 或 Agent Package。

### 3. Host 独占 CredentialVault

CredentialVault 由独立 Host 直接访问。Electron 只在 Profile 创建或秘密替换时通过
管理通道一次性提交秘密；Host 不提供秘密读取或列举 API，也不向 Electron 回传秘密。

当前桌面发行目标是 macOS，因此首个生产 Backend 使用 macOS Keychain。Vault trait
保留 Windows Credential Manager 与 Linux Secret Service 的实现位置；在平台 Backend
完成前必须返回 `unsupported_platform` 并失败关闭，禁止退回明文文件或普通环境变量。

Grok 现有外部命令 `auth_provider` 保持不变，不承担 AgentMesh360 Vault 职责。

### 4. Credential Ref 必须不可预测并校验归属

`credential_ref` 由 Host 使用密码学安全随机 UUID 签发，格式类似：

```text
credential://vault/h_<opaque-id>
```

调用方不能指定或替换该值。每次解析前，Host 必须先从 Profile Store 按当前
`owner_account_id + profile_id` 读取记录，再使用记录内的句柄访问 Vault。管理 API
永远不接受独立 `credential_ref` 参数。

### 5. 账户隔离

Provider Profile 绑定 AgentMesh360 `account_id`。列表、更新、秘密替换和删除都使用
当前已通过 `/v1/account/client-bootstrap` 的账户范围查询。切换登录账户不会显示或
操作前一账户的 Profile；操作系统账户边界再由 Keychain 提供第二层隔离。

### 6. Route Revision

Profile 新建时 `route_revision = 1`。修改 endpoint、protocol、auth kind、preset 或
模型映射时递增 revision；只替换同一 Profile 的秘密不递增 revision。后续 Session
Binding 必须保存具体 revision，Profile 更新不能静默改变已有 Session 的路由。

### 7. 删除和跨存储写入顺序

- 创建：先写 Vault，再插入 Profile；数据库失败时尽力删除刚创建的 Vault 项。
- 替换秘密：覆盖已有 Vault 项，再更新脱敏元数据；即使元数据更新失败，Profile 仍
  指向同一句柄，不会产生未引用的新秘密。
- 删除：先删除 Vault 项，再删除 Profile。Vault 删除失败时保留 Profile 并返回错误；
  不允许留下“数据库显示已删除但 Keychain 仍残留”的假成功。

切片 A 的删除操作始终同时删除 Profile 和凭据。若以后产品需要“删除 Profile 但保留
凭据”，必须先设计可恢复的归档记录，不能制造无主 Vault 项。

### 8. 管理 API

订阅硬门禁通过后，Host 提供以下 ACP 扩展：

```text
x.agentmesh360/providers/list
x.agentmesh360/providers/create
x.agentmesh360/providers/update
x.agentmesh360/providers/replace-secret
x.agentmesh360/providers/delete
```

`create` 和 `replace-secret` 是唯一接受秘密的入口。响应只包含脱敏 Profile；没有
`get-secret`、`export-secret` 或返回完整认证配置的接口。保存 Profile 不自动调用模型，
避免产生 Provider 费用。

## 数据优先级

切片 A 只建立 Profile。后续路由编译必须遵守：

```text
Session Binding 快照
  > Session Model Assignment
  > Agent Model Assignment
  > 全局 Model Assignment
  > Catalog 默认值
```

Catalog 是公开默认值，不得覆盖用户 Profile 或已经绑定的 route revision。

## 安全日志

允许记录 Profile ID、Preset ID、Provider 分类、route revision、状态码和已脱敏 Origin。
禁止记录请求参数整体、API Key、`credential_ref` 对应内容、认证 Header、含 userinfo 的
URL 或操作系统安全存储原始错误体。

当前实现还在共享 ACP Gateway 的 debug 序列化层递归脱敏 `apiKey`、`token`、
`authorization`、`password`、`secret` 等常见秘密字段，覆盖 Provider 管理请求和
订阅 bootstrap 请求。D0 已把同一边界扩展到 Sampling、subagent、工具、上传、认证
恢复、OIDC、配置 `Debug`、错误正文和 URL；业务 Handler 仍不得依赖该兜底去主动记录
完整参数。

## 后果

正面影响：

- Provider 秘密不依赖 Renderer 或 Electron 常驻；
- Profile 与秘密可以独立迁移和测试；
- 现有 Grok Sampling 数据面保持稳定，上游同步面较窄；
- 后续 Session Binding 能检测 Profile 路由变化。

代价与后续工作：

- Vault 与 SQLite 不能共享原子事务，需要遵守补偿顺序；
- Windows/Linux 客户端在各自 Vault Backend 完成前不能配置 BYOK；
- 独立 Host/Supervisor 完成前，进程生命周期仍未达到最终常驻目标；
- Catalog、Assignment、Binding、RouteCompiler、Credential Lease、三协议投影和产品
  Session 主 Prompt 的 Sampling/Turn Route 接入已实现，并已用本机 mock Provider 验证；
  完整 Host ACP E2E、辅助推理旁路、Provider UI 与真实 Provider E2E 仍需后续切片实现。
