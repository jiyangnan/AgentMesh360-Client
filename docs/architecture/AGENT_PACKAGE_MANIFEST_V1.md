# AgentMesh360 Agent Package Manifest v1

状态：H0 与 H1 已实现；动态运行时载入和 Registry 分发待 H2

本文档固定 AgentMesh360 产品 Agent 的第一个版本化 Package 契约。它解决的核心问题
不是“把 Prompt 搬进 TOML”，而是让客户端里的持久 Agent 与用户自行安装到 Codex、
Claude Code、OpenClaw 等宿主 Agent 的 Skill，来自同一个受版本控制的产品来源。

## 1. 一个 Package，两个受控投影

```mermaid
flowchart LR
    SOURCE["Agent 源仓库"] --> MANIFEST["agentmesh-agent.toml"]
    SOURCE --> WORKFLOW["Canonical Workflow"]
    SOURCE --> ADAPTERS["Host Skill Adapters"]

    MANIFEST --> VERIFY["Schema、身份、路径、权限校验"]
    WORKFLOW --> VERIFY
    ADAPTERS --> VERIFY

    VERIFY --> CLIENT["客户端持久 Agent 投影"]
    CLIENT --> PROFILE["AgentDefinition"]
    CLIENT --> SESSION["固定 Main Session"]
    CLIENT --> WORKSPACE["账户隔离 Workspace"]
    CLIENT --> POLICY["Provider Model Policy"]

    VERIFY --> HOST["宿主 Agent Skill 投影"]
    HOST --> CODEX["Codex"]
    HOST --> CLAUDE["Claude Code"]
    HOST --> OPENCLAW["OpenClaw"]
```

两个投影共享 `packageId`、`version`、`agentId`、产品说明、Canonical Workflow、
能力声明和发布来源。宿主 Adapter 只是对同一工作流的安装/发现适配，不是另一份
Agent 实现。某个宿主没有真实 Adapter 时，Manifest 必须如实省略，不能由客户端
临时拼出一份未经测试的安装指令。

## 2. H0 已实现的 Package 布局

当前三个内置 Package 位于：

```text
crates/codegen/xai-grok-shell/src/agentmesh360/packages/
  job-agent/agentmesh-agent.toml
  lecturecast-agent/agentmesh-agent.toml
  deploy-agent/agentmesh-agent.toml
```

H0 采用编译期嵌入，目的是先验证 Schema、运行时投影和旧状态兼容性，不代表未来
新增 Agent 还需要重新发布客户端。H1/H2 会把相同 Manifest 放入已签名 Package
产物，通过本地安装目录和 Registry 动态载入。

## 3. Manifest v1 字段

| 区域 | 字段 | 作用 | H0 消费者 |
| --- | --- | --- | --- |
| Package | `schemaVersion` | Manifest Schema，v1 只接受 `1` | 失败关闭解析器 |
| Package | `packageId` | 不随版本变化的发布身份 | Package Catalog |
| Package | `version` | 严格 SemVer | Registry 元数据升级 |
| Package | `publisher` | 发布者身份；H1 与信任密钥绑定 | Catalog |
| Package | `sourceRepository` | 不含凭据和参数的 HTTPS 源仓库 | Catalog/审计 |
| Package | `requestedPermissions` | Package 请求的能力声明 | H0 校验与展示元数据 |
| Agent | `agentId` | 不随升级变化的产品 Agent 身份 | Registry、Session、路由 |
| Agent | `displayName` / `description` | 客户端产品信息 | Agent 列表、Profile |
| Agent | `sortOrder` | Catalog 稳定排序 | Agent 列表 |
| Persistence | `mainSessionStrategy` | Main Session 身份算法 | Agent Registry |
| Persistence | `workspaceStrategy` | Workspace 账户隔离规则 | Agent Registry |
| Runtime | `promptMode` / Skill 发现开关 | Grok AgentDefinition 行为 | Harness |
| Runtime | `promptBody` | 当前持久 Agent Profile | Harness |
| Model | `modelPolicy` | 工具、视觉、结构化输出等要求 | RouteCompiler |
| Skills | `canonicalWorkflow` | 产品工作流的唯一来源路径 | H1/H2 投影器 |
| Skills | `adapters[]` | 已存在且经过维护的宿主 Skill 入口 | Catalog；H2 安装器 |

`requestedPermissions` 在 H0 只是声明，不授予任何 Host、Sandbox、操作系统或云端
权限。真正授权仍由 Host 的权限策略、用户审批、操作系统边界和 Core 的订阅/credits
校验共同决定。Package 不能通过新增字符串扩权。

## 4. 当前内置目录

| Agent | Package 版本 | Canonical Workflow | 已声明宿主 Adapter |
| --- | --- | --- | --- |
| Job Agent | `0.4.7` | `docs/agent-onboarding.md` | Claude Code、OpenClaw |
| LectureCast Agent | `0.4.0` | `skills/shared/director-workflow.md` | Codex、Claude Code、OpenClaw |
| Deploy Agent | `0.1.1` | `AGENTS.md` | 暂无独立 Skill Adapter |

这些版本和路径来自三个现有 Agent 源仓库。Deploy Agent 当前只有仓库级
`AGENTS.md`，因此 H0 不虚构 Codex/Claude/OpenClaw Adapter。

## 5. 运行时投影与兼容性

Manifest 已经成为以下数据的唯一来源：

1. `product_agents` 的名称、说明、版本和排序；
2. 激活时注入 Grok Harness 的 `AgentDefinition`；
3. 账户 + `agentId` 的确定性 Main Session 策略；
4. 账户隔离 Workspace 策略；
5. 产品 Agent 的 `AgentModelPolicy`；
6. 只读 ACP `x.agentmesh360/agent-packages/catalog`。

稳定 `agentId` 保持不变，因此 Main Session UUID 算法和现有 Session 历史都不变。
旧 `state.db` 再次打开时只更新 Package 管理的目录元数据，不覆盖
`desired_state`、`runtime_state`、`main_session_id`、`workspace_dir` 或
`activated_at`。

## 6. 失败关闭规则

H0 对以下情况直接拒绝整个 Package Catalog，不使用旧硬编码回退：

- 未支持的 `schemaVersion`；
- Manifest 任意未知字段；
- 未知 `requestedPermissions`；
- 非 SemVer 版本；
- 非法或重复 `packageId`、`agentId`、`sortOrder`；
- 重复宿主 Adapter；
- 绝对路径、`.`、`..` 等不规范 Package 内路径；
- 带账号、密码、query 或 fragment 的源仓库 URL；
- 空的身份、Prompt、Workflow 或权限声明。

公开 Catalog Schema 中没有 Provider Key、Access/Refresh Token、Credential Ref、
账户 ID、Session ID、Workspace 实际路径或用户业务数据字段。Provider 密钥仍只存在
于 Host-owned Vault。

## 7. H1a 已实现的签名产物验证

H1a 定义 `.ampkg.tar.zst` 产物、外部 JSON 签名信封和包内
`package-files.v1.json`。签名信封包含：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 签名信封版本，当前只接受 `1` |
| `keyId` / `publisher` | 必须同时匹配 Host 内置的受信发布密钥 |
| `packageId` / `version` | 与解包后的 Manifest 身份再次交叉校验 |
| `artifactSha256` | 对完整压缩产物的 SHA-256 |
| `signature` | 对确定性文本信封的 Ed25519 签名 |

验证使用 Ed25519 strict verification，先检查完整 Artifact digest 与发布密钥，再创建
staging。Artifact 只打开一次：验签前完成摘要后 rewind 同一文件句柄，再由该句柄
解包，避免“验签一个文件、解包另一个文件”的 TOCTOU。解包后还会逐文件核对
uniquely sorted 的路径、长度与 SHA-256 清单，因此 Artifact 完整性和 Package
文件清单形成双层验证。

staging 失败关闭边界包括：

- 压缩产物最大 32 MiB、单文件最大 32 MiB、解包总量最大 128 MiB、最多 1024 个
  文件和 2048 个 Archive entry；目录 entry 也计入上限；
- 拒绝绝对路径、反斜杠、`.`、`..`、重复路径、symlink、hardlink 和其他非普通文件；
- staging 目录使用不可复用名称创建，Unix 目录为 `0700`、文件为 `0600`；
- `agentmesh-agent.toml`、文件清单、Canonical Workflow 和所有声明的 Adapter 文件
  必须真实存在；
- 校验对象离开作用域但未提交时自动删除 staging；验证失败也清理 staging；
- 未知 key、签名篡改、Artifact 篡改、清单遗漏和签名/Manifest 身份不一致全部拒绝。

生产信任根目前故意为空。正式 AgentMesh360 发布公钥和轮换方案完成独立审计之前，
外部 Package 全部拒绝；测试只使用临时目录和固定测试密钥。H1a 没有 ACP 安装入口，
不会读取网络、真实 Package 目录或用户凭据。

## 8. H1b 已实现的原子安装与回滚

H1b 最初在共享 `state.db v7` 中增加 `agent_package_registry`；独立交叉测试发现
Previous 回滚只检查身份、没有可信的已解包文件锚点后，Registry 加固为 `state.db v8`。
每个 `packageId` 只保存一个 Active 和一个 Previous 指针，并为两者保存已签名
`package-files.v1.json` 的 SHA-256。安装顺序固定为：

1. H1a 完成签名、Artifact、文件清单、Schema、引用和身份验证；
2. 比较 Active 与新 Manifest 的权限集合；首次安装按“从零权限增加”处理；
3. 没有显式批准时返回 `approval_required`，staging 自动清理；
4. 对 staging 文件执行同步，再在同一 Package 文件系统中原子 rename 到不可变版本目录；
5. 通过 SQLite `IMMEDIATE` transaction 比较并提交 Active/Previous 指针；
6. 数据库提交失败时，旧 Active 不变；已 rename 的新目录只会成为未引用 orphan；
7. 显式 rollback 先将文件清单摘要与 Registry 锚点比对，再逐项复核整棵已安装目录的
   路径、类型、数量、大小与 SHA-256；全部通过后才在单个 SQLite transaction 中交换
   Active/Previous；
8. 同 digest 的幂等重装也复核 Active 目录，不能用幂等捷径掩盖安装后篡改。

安装/升级还固定以下不变量：

- 一个 `agentId` 只能属于一个已安装 `packageId`；
- 同一 `packageId` 的升级不能改变 `agentId`；
- 相同 SemVer precedence 不能通过 build metadata 换成另一个 Artifact digest；
- 低于 Active 的版本不能伪装成普通升级，只能回到已验证的 Previous；
- Active/Previous 记录保存版本、Artifact digest、文件清单 digest、相对路径、
  已批准权限和签名 key ID；
- v6→v8 迁移不改变既有 Agent Main Session、Provider Profile、Binding 或其他状态；
  空的 v7 Package Registry 可无损升级。由于 v7 从未开放生产入口，若开发数据库中
  已存在缺少可信文件清单锚点的 v7 Package 行，迁移会保留原数据并失败关闭，要求删除
  该未发布开发记录后重新安装，绝不在迁移时从可能已篡改的目录反向“补签”摘要。

当前安装服务仍是 Host 私有模块，没有 ACP/Renderer mutation 入口；生产 Trust Store
仍为空，因此不会对真实用户目录产生动态安装。正式发布密钥、权限确认 UI 和管理入口
必须作为独立发布门槛。未引用 orphan 的安全清理也留到 H2，不影响 Active 一致性。

## 9. H2 边界

H2 负责“动态分发与双投影”：

- **H2a1 已实现**：复用 H1 的锚定文件清单复验，让本地 Registry 的 Active Package
  在 Host 启动时确定性合并进运行时 Catalog；Registry、AgentDefinition、Model
  Policy、Session/Workspace 均消费同一合并结果；
- **H2a2 已实现并通过两轮 Kimi 交叉测试**：Host 通过原子共享 Catalog 快照让 Runtime、Model
  Routing 和产品 Turn 复用同一结果；安装/回滚后可调用 Host 私有显式 refresh，失败
  保留最后可信快照与稳定 Main Session；
- 提供订阅门禁且不暴露绝对路径、digest、签名 key、账户或 Session 数据的只读
  Active/Previous/invalid/orphan 状态；用户主动读取状态会复验已安装树，但普通 Turn
  不会逐次访问 Package 文件；
- 状态存储不可读时返回固定 `status-inventory` 故障条目，Catalog 不可用时只返回固定
  公开错误；原始 anyhow/OS 诊断只进入 Host 日志；
- 从 AgentMesh360 Package Registry 获取签名元数据和产物；
- 用户确认新增权限后安装/升级；
- 生成或安装 Manifest 声明的宿主 Skill Adapter；
- 执行受版本控制的状态迁移并支持回滚；
- 让新增 Agent 在未超出已支持 Schema/Capability 时无需客户端发版。

H2 完成前，远端 Package 不会被下载、解包或执行；H1 安装服务也不会暴露给客户端
界面。运行时已经能消费通过复验的本地 Active，但生产 Trust Store 与安装入口仍为空，
所以当前三个内置 Package 继续是唯一生产可用目录。

## 10. H2b0 Publisher Trust Bundle v1（已通过交叉测试）

H2b0 把 Package 的发布密钥从单个硬编码列表升级为两级信任链：

```text
客户端内置、经审计的 Ed25519 Root Key
  -> 验证 Publisher Trust Bundle
  -> 只装载当前有效的 active Publisher Key
  -> 验证 H1 的 Package Signature Envelope
  -> 验证 Artifact 与包内文件清单
```

Trust Bundle 是最多 64 KiB 的严格 JSON：

| 字段 | 约束 |
| --- | --- |
| `schemaVersion` | 当前只接受 `1` |
| `sequence` | 正整数，不能低于调用方提供的 `minimumSequence` |
| `rootKeyId` | 必须命中客户端内置 root |
| `generatedAt` / `expiresAt` | RFC3339；显式可信时间必须位于半开区间内 |
| `keys` | 最多 64 项，按 `keyId` 严格递增 |
| `signature` | root 对确定性 v1 文本载荷的 Ed25519 strict signature |

每个 Publisher key 记录包含 `keyId`、`publisher`、固定 `ed25519` algorithm、
canonical Base64 公钥、`active/retired/revoked` 状态和 key 自身有效期。仅当前有效的
active key 会进入 `TrustedPublisherStore`；重叠 active key 支持轮换，retired/revoked
不能验证新的安装。签名载荷有固定 domain separator，key 列表逐行编码，不依赖 JSON
对象顺序。

H2b0 已完成自主测试和两轮本机 Kimi 交叉测试，但只交付验证与审计契约。生产
`TrustedRootStore` 和嵌入 Bundle 仍为空；
`minimumSequence` 尚未持久化，远端可信时间、Registry Snapshot、缓存、防回滚状态、
下载和安装入口都属于 H2b1 以后。因此当前外部 Package 仍全部拒绝，不能把本节解读为
生产密钥已经上线。
