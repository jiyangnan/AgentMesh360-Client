# AgentMesh360 Client 产品蓝图

状态：目标架构，持久化基础能力已实现
建立日期：2026-07-22

本文档是 AgentMesh360 桌面客户端在产品与工程层面的共同地图。它描述的是
完整目标产品，而不只是第一阶段的 Rust 实现。标记为**已实现**的能力已经存在
于当前 Fork 分支中；标记为**目标**的能力是仍待实现的设计约束。

为避免翻译造成工程歧义，文档保留以下产品与技术术语：Agent、Main Session、
Host、Harness、BYOK、Provider、Agent Package、ACP。

## 已确定的产品决策

- AgentMesh360 订阅是进入客户端的硬门槛。用户登录后，如果订阅无效、已过期
  或被暂停，只能看到账号与订阅引导页面，不能进入 Agent 工作区。
- BYOK 是默认推理模式。用户明确选择模型 Provider，并自行承担 Provider 侧的
  模型费用。首批目标是 OpenAI、xAI 和 Anthropic；Claude Opus 使用 Anthropic
  API Key。
- BYOK 模型调用不消耗 AgentMesh360 credits。Credits 只用于明确标识的
  AgentMesh360 云端动作。
- Job Agent、LectureCast Agent、Deploy Agent 以及未来的产品 Agent，都是单例、
  持久化的产品身份。每个已激活 Agent 只有一个固定 Main Session；它会持续常驻，
  并在系统重启后恢复。
- 所有产品 Agent 共享一套受监管的 Grok Build Harness，而不是分别运行完整
  运行时的副本。Grok 子 Agent 只承担有边界的临时任务。
- 未来以 Agent Package 作为桌面客户端安装和宿主 Agent Skill 安装的唯一来源。
  新增产品 Agent 不应要求发布新版客户端。

## 1. 产品结构图

```mermaid
flowchart TB
    CLIENT["AgentMesh360 客户端"]

    subgraph ENTRY["准入门禁"]
        LOGIN["登录 AgentMesh360 账号"]
        ENTITLEMENT["校验订阅状态"]
        PAYWALL["订阅或续费"]
    end

    subgraph HOME["Agent 首页"]
        HOME_NAV["Agent 首页"]
        CATALOG["Agent 目录"]
        ACTIVE["已激活 Agent"]
        UPDATES["Agent Package 更新"]
    end

    subgraph WORKSPACE["持久化 Agent 工作区"]
        MAIN["固定主对话"]
        PROJECTS["项目与结构化状态"]
        TASKS["任务与后台活动"]
        ARTIFACTS["产物与验证证据"]
        APPROVALS["权限与审批"]
    end

    subgraph SETTINGS["设置"]
        PROVIDERS["BYOK Provider 与模型"]
        ACCOUNT["账号、订阅与 credits"]
        DATA["本地数据与导出"]
        SECURITY["权限与安全"]
    end

    subgraph AGENTS["可安装的产品 Agent"]
        TYPES["Agent 类型"]
        JOB["Job Agent"]
        LECTURE["LectureCast Agent"]
        DEPLOY["Deploy Agent"]
        FUTURE["未来的 Agent Package"]
    end

    CLIENT --> LOGIN
    LOGIN --> ENTITLEMENT
    ENTITLEMENT -->|"订阅无效"| PAYWALL
    ENTITLEMENT -->|"订阅有效"| HOME_NAV
    HOME_NAV --> CATALOG
    HOME_NAV --> ACTIVE
    HOME_NAV --> UPDATES
    HOME_NAV --> PROVIDERS
    HOME_NAV --> ACCOUNT
    HOME_NAV --> DATA
    HOME_NAV --> SECURITY
    CATALOG --> TYPES
    TYPES --> JOB
    TYPES --> LECTURE
    TYPES --> DEPLOY
    TYPES --> FUTURE
    CATALOG -->|"安装或激活"| ACTIVE
    ACTIVE --> MAIN
    MAIN --> PROJECTS
    MAIN --> TASKS
    MAIN --> ARTIFACTS
    MAIN --> APPROVALS
```

订阅拦截页属于最小登录外壳，不属于客户端工作区。历史数据可以继续保留在本地，
但订阅无效时，用户不能进入用于浏览或运行这些数据的客户端界面。

## 2. 核心功能流程图

```mermaid
flowchart TD
    START["启动客户端"] --> TOKEN{"是否已登录？"}
    TOKEN -->|"否"| SIGNIN["登录 AgentMesh360"]
    SIGNIN --> BOOTSTRAP["获取由服务端统一计算的客户端 bootstrap"]
    TOKEN -->|"是"| BOOTSTRAP

    BOOTSTRAP --> VALID{"订阅是否有效？"}
    VALID -->|"否"| BLOCKED["显示订阅拦截页"]
    BLOCKED --> WEB["打开 AgentMesh360 订阅页面"]
    WEB --> BOOTSTRAP

    VALID -->|"是"| PROVIDER{"是否已配置可用的 BYOK Provider？"}
    PROVIDER -->|"否"| SETUP["选择 Provider、填写 API Key、选择模型"]
    SETUP --> VERIFY["校验 API Key 与模型能力"]
    VERIFY --> HOME["进入 Agent 首页"]
    PROVIDER -->|"是"| HOME

    HOME --> SELECT["选择已安装的 Agent"]
    SELECT --> ACTIVATED{"是否已经激活？"}
    ACTIVATED -->|"否"| ACTIVATE["激活 Agent 单例并创建固定 Main Session"]
    ACTIVATED -->|"是"| LOAD["打开已有 Main Session"]
    ACTIVATE --> CHAT["持续对话与结构化工作"]
    LOAD --> CHAT

    CHAT --> ACTION{"动作类型"}
    ACTION -->|"BYOK 模型或本地工具"| LOCAL["在本地执行，并直连用户选择的 Provider"]
    ACTION -->|"AgentMesh360 云端动作"| CREDIT{"Credits 是否充足？"}
    CREDIT -->|"是"| CLOUD["执行计费云端动作"]
    CREDIT -->|"否"| TOPUP["说明费用并引导购买 credits"]
    LOCAL --> RESULT["保存对话、状态、产物与审计事件"]
    CLOUD --> RESULT
    RESULT --> CHAT
```

客户端 bootstrap 必须是服务端给出的单一准入结论。客户端不能自行组合订阅日期、
credits 余额和产品标记来推断用户是否有权进入。

当前已经落地 Core `GET /v1/account/client-bootstrap` 与 Host
`x.agentmesh360/account/bootstrap`。Host 在准入成功前不会恢复持久 Agent，并在产品
Main Session 的创建、加载、Prompt 和携带 Session ID 的扩展调用入口重复校验。
JWT 仅用于内存中的 HTTPS 请求，不写入 Registry 或对话。桌面登录、Refresh Token、
Keychain、定时 / 唤醒重验和订阅拦截页面仍由后续桌面外壳切片实现。

## 3. 技术架构图

```mermaid
flowchart LR
    subgraph OS["用户电脑"]
        direction TB
        subgraph UI["桌面 UI 进程（目标态）"]
            direction TB
            SHELL["登录与订阅门禁"]
            AGENT_UI["Agent 首页与垂直工作区"]
            SETTINGS_UI["Provider、账号、Package 与安全设置"]
        end

        subgraph HOST["AgentMesh Host（目标后台服务）"]
            direction TB
            SUPERVISOR["生命周期监管与健康检查"]
            AUTHZ["订阅准入与策略执行"]
            PACKAGE["已签名 Agent Package 管理器"]
            REGISTRY["Agent Registry 与 Main Session 映射"]
            ROUTER["Provider 与动作路由器"]
            EVENTS["事件、审批、通知与审计"]
        end

        subgraph HARNESS["Grok Build Harness"]
            direction TB
            ACP["ACP 与 Session 桥接层"]
            LOOP["Agent Loop、工具、权限、压缩与记忆"]
            JOB["Job Agent Main Session"]
            LECTURE["LectureCast Agent Main Session"]
            DEPLOY["Deploy Agent Main Session"]
            FUTURE["未来 Agent 的持久 Main Session"]
            WORKERS["有边界的临时子 Agent"]
        end

        subgraph LOCAL["本地状态"]
            direction TB
            KEYCHAIN["操作系统安全凭据存储"]
            STATE["AgentMesh state.db"]
            SESSIONS["Grok Session Store"]
            WORKSPACES["Agent Workspace 与产物"]
            PACKAGES["版本化 Agent Package"]
        end
    end

    subgraph PROVIDERS["用户选择的模型 Provider"]
        direction TB
        OPENAI["OpenAI API"]
        XAI["xAI API"]
        ANTHROPIC["Anthropic Messages API"]
        COMPATIBLE["未来的兼容 Provider 或本地模型"]
    end

    subgraph CLOUD["AgentMesh360 云端服务"]
        direction TB
        CORE["身份、订阅、准入与 credits"]
        PACKAGE_REGISTRY["Agent Package 目录与分发"]
        CLOUD_ACTIONS["按量计费的云端能力"]
    end

    SHELL --> AUTHZ
    AGENT_UI --> ACP
    SETTINGS_UI --> ROUTER
    SETTINGS_UI --> PACKAGE
    SUPERVISOR --> ACP
    SUPERVISOR --> REGISTRY
    AUTHZ --> ACP
    REGISTRY --> ACP
    ACP <--> EVENTS
    ACP --> LOOP
    LOOP --> JOB
    LOOP --> LECTURE
    LOOP --> DEPLOY
    LOOP --> FUTURE
    JOB --> WORKERS
    LECTURE --> WORKERS
    DEPLOY --> WORKERS
    FUTURE --> WORKERS

    AUTHZ <--> CORE
    PACKAGE <--> PACKAGE_REGISTRY
    ROUTER --> OPENAI
    ROUTER --> XAI
    ROUTER --> ANTHROPIC
    ROUTER --> COMPATIBLE
    ROUTER --> CLOUD_ACTIONS

    REGISTRY --> STATE
    PACKAGE --> PACKAGES
    LOOP --> SESSIONS
    LOOP --> WORKSPACES
    ROUTER --> KEYCHAIN
```

### 职责边界

| 层级 | 负责 | 不应负责 |
| --- | --- | --- |
| 桌面 UI | 导航、对话、垂直业务界面、设置、审批 | 密钥、权威准入结论或 Agent 生命周期真相 |
| AgentMesh Host | 订阅执行、生命周期、Registry、Package、路由与安全策略 | 写死在 Host 二进制中的模型专属产品行为 |
| Grok Harness | Agent Loop、Session、工具、记忆、压缩与临时 Worker | AgentMesh 订阅和 Package 商业策略 |
| 产品 Agent Package | 身份、Prompt/Profile、Skills、UI 扩展、能力声明与迁移 | Provider 密钥或权威定价 |
| AgentMesh360 Core | 身份、订阅、准入、credits 与云端动作账本 | BYOK 推理流量或 Provider 原始密钥 |
| 模型 Provider | BYOK 推理与 Provider 侧计费 | AgentMesh 订阅准入决策 |

## 4. 运行时与内存拓扑图

```mermaid
flowchart LR
    LAUNCHD["操作系统登录自启动服务"] --> HOST["一个 AgentMesh Host"]
    HOST --> RUNTIME["一套共享的 Grok Harness 运行时"]
    RUNTIME --> J["Job Agent 单例\n固定 Main Session"]
    RUNTIME --> L["LectureCast Agent 单例\n固定 Main Session"]
    RUNTIME --> D["Deploy Agent 单例\n固定 Main Session"]
    RUNTIME --> F["未来 Agent 单例\n固定 Main Session"]

    J -. "有边界的任务" .-> W1["临时 Worker"]
    L -. "有边界的任务" .-> W2["临时 Worker"]
    D -. "有边界的任务" .-> W3["临时 Worker"]

    UI["桌面窗口"] -->|"连接或重连"| HOST
    UI -->|"可以关闭"| CLOSED["UI 进程退出"]
    CLOSED -. "Host 与已激活 Agent 继续常驻" .-> HOST
```

这一拓扑避免了“每个 Agent 运行一套完整 Grok 进程”造成的内存开销，同时保证
每个已激活产品 Agent 都具有持续在线的身份和固定对话。

## 5. 持久化 Agent 生命周期时序图

```mermaid
sequenceDiagram
    participant OS as 操作系统
    participant Host as AgentMesh Host
    participant Registry as Agent Registry
    participant Grok as Grok Harness
    participant UI as 桌面 UI
    participant Agent as 产品 Agent Main Session

    OS->>Host: 用户登录系统时启动
    Host->>Registry: 查询 desired_state = running
    loop 对每个已激活产品 Agent
        Registry-->>Host: 返回 agent_id 与固定 main_session_id
        Host->>Grok: session/load 固定 Main Session
        alt 已存在持久 Session
            Grok-->>Host: Session 恢复成功
        else 首次激活或 Session 缺失
            Host->>Grok: 使用确定性 Session ID 执行 session/new
            Grok-->>Host: Session 创建成功
        end
        Host->>Grok: 固定 Session，避免空闲淘汰
        Grok-->>Agent: 进入常驻就绪状态
        Host->>Registry: 记录实际运行时状态
    end
    UI->>Host: 连接并获取 Agent 列表
    Host-->>UI: 返回稳定 Agent ID 与 Main Session ID
    UI->>Agent: 打开唯一主对话
    UI--xHost: 窗口关闭或连接中断
    Note over Host,Agent: Host 保持运行，已激活 Agent 继续常驻
    UI->>Host: 稍后重新连接
    Host-->>UI: 返回同一 Agent 与同一 Main Session
```

## 6. 动态 Agent Package 分发图

同一个 Agent Package 同时支持两种产品入口，不需要维护两套 Agent 实现。

```mermaid
flowchart TB
    SOURCE["Agent 源代码仓库"] --> BUILD["构建并签名 Agent Package"]

    subgraph PACKAGE["agentmesh-agent package"]
        MANIFEST["agentmesh-agent.toml"]
        PROFILE["持久化 Agent Profile"]
        SKILLS["Skills、工具与工作流"]
        UI_CONTRIB["可选的客户端 UI 扩展"]
        ADAPTERS["宿主 Agent 安装适配器"]
        MIGRATIONS["版本化状态迁移"]
        ASSETS["资源与元数据"]
        BUNDLE["已签名的版本化 Package 产物"]
    end

    BUILD --> BUNDLE
    MANIFEST -.-> BUNDLE
    PROFILE -.-> BUNDLE
    SKILLS -.-> BUNDLE
    UI_CONTRIB -.-> BUNDLE
    ADAPTERS -.-> BUNDLE
    MIGRATIONS -.-> BUNDLE
    ASSETS -.-> BUNDLE
    BUNDLE --> REGISTRY["AgentMesh360 Package Registry"]

    REGISTRY --> DESKTOP["AgentMesh360 客户端安装器"]
    DESKTOP --> VERIFY["校验签名、兼容性与权限变更"]
    VERIFY --> ATOMIC["原子安装或更新，支持回滚"]
    ATOMIC --> PERSISTENT["注册并激活持久化 Agent"]

    REGISTRY --> GUIDE["生成宿主 Agent 安装指南"]
    GUIDE --> CODEX["Codex Skill 安装"]
    GUIDE --> CLAUDE["Claude Skill 安装"]
    GUIDE --> OPENCLAW["OpenClaw Skill 安装"]
    CODEX --> HOST_SKILL["在用户选择的宿主 Agent 中按需运行 Skill"]
    CLAUDE --> HOST_SKILL
    OPENCLAW --> HOST_SKILL
```

推荐的 Package 目录结构：

```text
agentmesh-agent.toml
profile.md
skills/
tools/
ui/
adapters/
  codex/INSTALL.md
  claude/INSTALL.md
  openclaw/INSTALL.md
migrations/
assets/
```

稳定的 `agent_id` 在 Package 升级后保持不变，因此更新 Agent 行为不会重置其固定
Main Session。Package 可以声明云端动作标识与能力要求，但访问权限和 credits 成本
仍由 AgentMesh360 Core 决定。

## 7. BYOK Provider 与动作路由图

```mermaid
flowchart TD
    REQUEST["产品 Agent 请求推理或执行动作"] --> DECLARED["读取 Package 声明的能力要求"]
    DECLARED --> KIND{"请求类型"}

    KIND -->|"模型推理"| MODEL["解析会话级、Agent 级或全局模型选择"]
    MODEL --> CAPABLE{"所选模型是否满足工具、上下文、视觉和输出要求？"}
    CAPABLE -->|"否"| EXPLAIN["说明不兼容原因，并要求用户选择其他模型"]
    CAPABLE -->|"是"| SECRET["从操作系统安全存储中读取 Provider Key"]
    SECRET --> DIRECT["直连用户选择的 Provider"]
    DIRECT --> USAGE["记录本地用量元数据，不扣除 AgentMesh360 credits"]

    KIND -->|"本地工具"| POLICY["应用本地权限与 Sandbox 策略"]
    POLICY --> LOCAL_RESULT["在本地 Workspace 中执行"]

    KIND -->|"AgentMesh360 云端动作"| ENTITLEMENT["服务端校验订阅、动作权限与 credits 余额"]
    ENTITLEMENT -->|"允许"| CLOUD["通过幂等 credits 账本执行"]
    ENTITLEMENT -->|"拒绝"| DENIED["返回原因以及购买或恢复路径"]

    USAGE --> RESULT["返回统一的流式响应、Tool Call、用量或错误"]
    LOCAL_RESULT --> RESULT
    CLOUD --> RESULT
```

客户端不做静默 Provider 降级。切换 Provider 可能改变用户数据的发送位置，因此必须
由用户明确选择。Provider Adapter 负责统一流式输出、Tool Call、结构化输出、用量、
能力和错误，同时保留必要的 Provider 专属行为。

## 8. 信任与数据边界图

```mermaid
flowchart LR
    subgraph DEVICE["可信本地设备边界"]
        UI["桌面 UI"]
        HOST["AgentMesh Host 策略层"]
        HARNESS["Grok Harness 与工具"]
        KEYCHAIN["Provider Key 与刷新令牌"]
        LOCAL_DATA["Session、Agent 状态、Workspace 与产物"]
        SANDBOX["操作系统 Sandbox 与明确审批"]
    end

    subgraph AGENTMESH["AgentMesh360 服务边界"]
        IDENTITY["登录与 Token 刷新"]
        SUBSCRIPTION["订阅与准入"]
        CREDITS["云端动作 credits 与账本"]
        PACKAGES["已签名 Package 分发"]
    end

    subgraph THIRD_PARTY["第三方 Provider 边界"]
        MODEL["用户选择的 BYOK 模型 API"]
    end

    UI --> HOST
    HOST --> HARNESS
    HARNESS --> SANDBOX
    KEYCHAIN -->|"仅在需要时提供凭据"| HOST
    HARNESS <--> LOCAL_DATA
    HOST <--> IDENTITY
    HOST <--> SUBSCRIPTION
    HOST <--> CREDITS
    HOST <--> PACKAGES
    HOST -->|"直连 BYOK Prompt 与工具上下文"| MODEL

    PACKAGES -. "永远不能读取" .-> KEYCHAIN
```

订阅、Package 签名、权限与 Sandbox 等关键策略，必须由 AgentMesh Host 和操作系统
执行。Harness Hook 可以提供可观测性与便利功能，但不能作为失败时默认放行的关键
安全边界。

## 9. 实施路线图

| 能力切片 | 状态 | 具体范围 |
| --- | --- | --- |
| 持久化产品身份 | **已实现：基础能力** | SQLite Agent Registry、确定性 Main Session、激活 ACP 方法、Session 固定、启动恢复 |
| 订阅硬门禁 | **Core + Host 基础已实现** | 已完成服务端 bootstrap、恢复门禁、产品 Session 强制校验与周期截止；待登录、Token 刷新、Keychain、定时重验、订阅界面和官网跳转 |
| BYOK Provider 层 | **下一阶段目标** | 安全凭据、OpenAI/xAI/Anthropic Adapter、能力校验、模型选择、统一流式响应与错误 |
| 动态 Agent Package | **目标** | Manifest、签名、目录、安装器、迁移、权限变更、回滚、宿主 Skill Adapter |
| 桌面产品外壳 | **目标** | Agent 首页、固定对话、垂直工作区、活动、产物、审批与设置 |
| 后台 Host | **目标** | 登录自启动、IPC/ACP 桥接、崩溃恢复、健康检查、通知、审计与离线行为 |

当前硬编码的 Job Agent、LectureCast Agent 和 Deploy Agent 目录，只是验证持久化
契约的脚手架。在迁移具体 Agent 成为常规集成路径之前，必须用动态 Agent Package
Registry 替换它。
