# AgentMesh360 Client Product Blueprint

Status: target architecture with an implemented persistence foundation
Established: 2026-07-22

This document is the shared product and engineering map for the AgentMesh360
desktop client. It describes the target product, not just the first Rust
implementation slice. Boxes marked **implemented** exist in the current fork;
boxes marked **target** are design commitments that still need implementation.

## Fixed product decisions

- The AgentMesh360 subscription is a hard client-entry gate. A signed-in user
  with an invalid, expired, or suspended subscription can only see the account
  and subscription gate; they cannot enter the Agent workspace.
- BYOK is the default inference mode. Users explicitly select and pay their
  model provider. Initial targets are OpenAI, xAI, and Anthropic; Claude Opus is
  selected with an Anthropic API key.
- BYOK model calls do not consume AgentMesh360 credits. Credits apply only to
  clearly identified AgentMesh360 cloud actions.
- Job Agent, LectureCast Agent, Deploy Agent, and future product agents are
  singleton persistent product identities. Each activated Agent has one fixed
  Main Session that remains resident and is restored after restart.
- Product Agents share one supervised Grok Build Harness. They are not separate
  copies of the complete runtime. Bounded Grok subagents remain temporary task
  workers.
- A future Agent Package is the single source for both desktop installation and
  host-Agent skill installation. Adding a product Agent must not require a new
  client release.

## 1. Product structure

```mermaid
flowchart TB
    CLIENT["AgentMesh360 Client"]

    subgraph ENTRY["Entry gate"]
        LOGIN["AgentMesh360 account login"]
        ENTITLEMENT["Subscription validation"]
        PAYWALL["Subscribe or renew"]
    end

    subgraph HOME["Agent home"]
        HOME_NAV["Agent Home"]
        CATALOG["Agent catalog"]
        ACTIVE["Activated Agents"]
        UPDATES["Package updates"]
    end

    subgraph WORKSPACE["Persistent Agent workspace"]
        MAIN["Fixed Main Conversation"]
        PROJECTS["Projects and structured state"]
        TASKS["Tasks and background activity"]
        ARTIFACTS["Artifacts and evidence"]
        APPROVALS["Permissions and approvals"]
    end

    subgraph SETTINGS["Settings"]
        PROVIDERS["BYOK providers and models"]
        ACCOUNT["Account, subscription, credits"]
        DATA["Local data and export"]
        SECURITY["Permissions and security"]
    end

    subgraph AGENTS["Installable product Agents"]
        TYPES["Agent types"]
        JOB["Job Agent"]
        LECTURE["LectureCast Agent"]
        DEPLOY["Deploy Agent"]
        FUTURE["Future Agent Packages"]
    end

    CLIENT --> LOGIN
    LOGIN --> ENTITLEMENT
    ENTITLEMENT -->|"invalid"| PAYWALL
    ENTITLEMENT -->|"active"| HOME_NAV
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
    CATALOG -->|"install or activate"| ACTIVE
    ACTIVE --> MAIN
    MAIN --> PROJECTS
    MAIN --> TASKS
    MAIN --> ARTIFACTS
    MAIN --> APPROVALS
```

The paywall is part of the minimum authentication shell, not the client
workspace. Local history may remain on disk, but an invalid subscription does
not unlock the UI used to browse or run it.

## 2. Core functional flow

```mermaid
flowchart TD
    START["Launch client"] --> TOKEN{"Signed in?"}
    TOKEN -->|"no"| SIGNIN["Sign in with AgentMesh360"]
    SIGNIN --> BOOTSTRAP["Fetch server-computed client bootstrap"]
    TOKEN -->|"yes"| BOOTSTRAP

    BOOTSTRAP --> VALID{"Subscription active?"}
    VALID -->|"no"| BLOCKED["Show subscription gate"]
    BLOCKED --> WEB["Open AgentMesh360 subscription page"]
    WEB --> BOOTSTRAP

    VALID -->|"yes"| PROVIDER{"Usable BYOK provider configured?"}
    PROVIDER -->|"no"| SETUP["Choose provider, add key, select model"]
    SETUP --> VERIFY["Validate key and model capabilities"]
    VERIFY --> HOME["Enter Agent home"]
    PROVIDER -->|"yes"| HOME

    HOME --> SELECT["Select installed Agent"]
    SELECT --> ACTIVATED{"Already activated?"}
    ACTIVATED -->|"no"| ACTIVATE["Activate singleton Agent and create fixed Main Session"]
    ACTIVATED -->|"yes"| LOAD["Open existing Main Session"]
    ACTIVATE --> CHAT["Conversation and structured work"]
    LOAD --> CHAT

    CHAT --> ACTION{"Action type"}
    ACTION -->|"BYOK model or local tool"| LOCAL["Run locally and call selected provider directly"]
    ACTION -->|"AgentMesh360 cloud action"| CREDIT{"Enough credits?"}
    CREDIT -->|"yes"| CLOUD["Run metered cloud action"]
    CREDIT -->|"no"| TOPUP["Explain cost and offer credit purchase"]
    LOCAL --> RESULT["Persist transcript, state, artifacts, and audit event"]
    CLOUD --> RESULT
    RESULT --> CHAT
```

The bootstrap response must be a single server decision. The client must not
infer access by independently combining subscription dates, balances, and
product flags.

## 3. Technical architecture

```mermaid
flowchart LR
    subgraph OS["User computer"]
        direction TB
        subgraph UI["Desktop UI process - target"]
            direction TB
            SHELL["Authentication and subscription gate"]
            AGENT_UI["Agent home and vertical workspaces"]
            SETTINGS_UI["Provider, account, package, and security settings"]
        end

        subgraph HOST["AgentMesh Host - target background service"]
            direction TB
            SUPERVISOR["Lifecycle supervisor and health"]
            AUTHZ["Entitlement and policy enforcement"]
            PACKAGE["Signed Agent Package manager"]
            REGISTRY["Agent registry and Main Session mapping"]
            ROUTER["Provider and action router"]
            EVENTS["Events, approvals, notifications, audit"]
        end

        subgraph HARNESS["Grok Build Harness"]
            direction TB
            ACP["ACP and session bridge"]
            LOOP["Agent loop, tools, permissions, compaction, memory"]
            JOB["Job Agent Main Session"]
            LECTURE["LectureCast Agent Main Session"]
            DEPLOY["Deploy Agent Main Session"]
            FUTURE["Future persistent Main Sessions"]
            WORKERS["Temporary bounded subagents"]
        end

        subgraph LOCAL["Local state"]
            direction TB
            KEYCHAIN["OS secure credential store"]
            STATE["AgentMesh state.db"]
            SESSIONS["Grok session store"]
            WORKSPACES["Agent workspaces and artifacts"]
            PACKAGES["Versioned Agent Packages"]
        end
    end

    subgraph PROVIDERS["User-selected model providers"]
        direction TB
        OPENAI["OpenAI API"]
        XAI["xAI API"]
        ANTHROPIC["Anthropic Messages API"]
        COMPATIBLE["Future compatible or local providers"]
    end

    subgraph CLOUD["AgentMesh360 services"]
        direction TB
        CORE["Identity, subscription, entitlement, credits"]
        PACKAGE_REGISTRY["Agent Package catalog and distribution"]
        CLOUD_ACTIONS["Metered cloud capabilities"]
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

### Ownership boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Desktop UI | Navigation, conversations, vertical views, setup, approvals | Secrets, authoritative entitlement, or Agent lifecycle truth |
| AgentMesh Host | Subscription enforcement, lifecycle, registry, packages, routing, security policy | Model-specific product behavior embedded in the host binary |
| Grok Harness | Agent loop, sessions, tools, memory, compaction, workers | AgentMesh subscription and package-commerce policy |
| Product Agent Package | Identity, prompt/profile, skills, UI contributions, capabilities, migrations | Provider secrets or authoritative pricing |
| AgentMesh360 Core | Identity, subscription, entitlement, credits, cloud-action ledger | BYOK inference traffic or raw provider keys |
| Model provider | BYOK inference and provider billing | AgentMesh subscription decisions |

## 4. Runtime and memory topology

```mermaid
flowchart LR
    LAUNCHD["OS launch-on-login service"] --> HOST["One AgentMesh Host"]
    HOST --> RUNTIME["One shared Grok Harness runtime"]
    RUNTIME --> J["Job Agent singleton\nfixed Main Session"]
    RUNTIME --> L["LectureCast Agent singleton\nfixed Main Session"]
    RUNTIME --> D["Deploy Agent singleton\nfixed Main Session"]
    RUNTIME --> F["Future Agent singleton\nfixed Main Session"]

    J -. "bounded task" .-> W1["Temporary worker"]
    L -. "bounded task" .-> W2["Temporary worker"]
    D -. "bounded task" .-> W3["Temporary worker"]

    UI["Desktop window"] -->|"connect or reconnect"| HOST
    UI -->|"may close"| CLOSED["UI process exits"]
    CLOSED -. "Host and activated Agents stay resident" .-> HOST
```

This topology prevents the memory cost of running one complete Grok process per
Agent while preserving a continuously available identity and conversation for
each activated product Agent.

## 5. Persistent Agent lifecycle

```mermaid
sequenceDiagram
    participant OS as Operating system
    participant Host as AgentMesh Host
    participant Registry as Agent Registry
    participant Grok as Grok Harness
    participant UI as Desktop UI
    participant Agent as Product Agent Main Session

    OS->>Host: Launch on login
    Host->>Registry: List desired_state = running
    loop Each activated product Agent
        Registry-->>Host: agent_id and fixed main_session_id
        Host->>Grok: session/load fixed Main Session
        alt Existing durable session
            Grok-->>Host: Session restored
        else First activation or missing session
            Host->>Grok: session/new with deterministic session ID
            Grok-->>Host: Session created
        end
        Host->>Grok: Pin session against idle eviction
        Grok-->>Agent: Resident and ready
        Host->>Registry: Record observed runtime state
    end
    UI->>Host: Connect and list Agents
    Host-->>UI: Stable Agent IDs and Main Session IDs
    UI->>Agent: Open canonical conversation
    UI--xHost: Window closes or disconnects
    Note over Host,Agent: Host remains alive, activated Agent remains resident
    UI->>Host: Reconnect later
    Host-->>UI: Same Agent and same Main Session
```

## 6. Dynamic Agent Package distribution

One package supports two product entry points without maintaining two Agent
implementations.

```mermaid
flowchart TB
    SOURCE["Agent source repository"] --> BUILD["Build and sign Agent Package"]

    subgraph PACKAGE["agentmesh-agent package"]
        MANIFEST["agentmesh-agent.toml"]
        PROFILE["Persistent Agent profile"]
        SKILLS["Skills, tools, and workflows"]
        UI_CONTRIB["Optional client UI contributions"]
        ADAPTERS["Host-Agent install adapters"]
        MIGRATIONS["Versioned state migrations"]
        ASSETS["Assets and metadata"]
        BUNDLE["Signed versioned package artifact"]
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

    REGISTRY --> DESKTOP["AgentMesh360 Client installer"]
    DESKTOP --> VERIFY["Verify signature, compatibility, and permission diff"]
    VERIFY --> ATOMIC["Atomic install or update with rollback"]
    ATOMIC --> PERSISTENT["Register and activate persistent Agent"]

    REGISTRY --> GUIDE["Generated host-Agent installation guide"]
    GUIDE --> CODEX["Codex skill installation"]
    GUIDE --> CLAUDE["Claude skill installation"]
    GUIDE --> OPENCLAW["OpenClaw skill installation"]
    CODEX --> HOST_SKILL["On-demand skill in the user's chosen host Agent"]
    CLAUDE --> HOST_SKILL
    OPENCLAW --> HOST_SKILL
```

Recommended package layout:

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

The stable `agent_id` survives package upgrades, so an update changes behavior
without resetting the Agent's fixed Main Session. The package may declare cloud
action identifiers and required capabilities, but AgentMesh360 Core remains the
authority for access and credit cost.

## 7. BYOK provider and action routing

```mermaid
flowchart TD
    REQUEST["Product Agent requests inference or an action"] --> DECLARED["Read package capability requirements"]
    DECLARED --> KIND{"Request kind"}

    KIND -->|"inference"| MODEL["Resolve explicit session, Agent, or global model selection"]
    MODEL --> CAPABLE{"Selected model meets tool, context, vision, and output needs?"}
    CAPABLE -->|"no"| EXPLAIN["Explain incompatibility and ask user to select another model"]
    CAPABLE -->|"yes"| SECRET["Read provider key from OS secure storage"]
    SECRET --> DIRECT["Call selected provider directly"]
    DIRECT --> USAGE["Record local usage metadata; deduct no AgentMesh credits"]

    KIND -->|"local tool"| POLICY["Apply local permission and sandbox policy"]
    POLICY --> LOCAL_RESULT["Execute in local workspace"]

    KIND -->|"AgentMesh cloud action"| ENTITLEMENT["Server verifies subscription, action access, and credit balance"]
    ENTITLEMENT -->|"allowed"| CLOUD["Execute with idempotent credit ledger"]
    ENTITLEMENT -->|"denied"| DENIED["Return reason and purchase or recovery path"]

    USAGE --> RESULT["Return normalized stream, tool calls, usage, or errors"]
    LOCAL_RESULT --> RESULT
    CLOUD --> RESULT
```

There is no silent provider fallback. Changing provider can change where user
data is sent, so fallback requires an explicit user choice. Provider adapters
normalize streaming, tool calls, structured output, usage, capabilities, and
errors while preserving provider-specific behavior where needed.

## 8. Trust and data boundaries

```mermaid
flowchart LR
    subgraph DEVICE["Trusted local device boundary"]
        UI["Desktop UI"]
        HOST["AgentMesh Host policy"]
        HARNESS["Grok Harness and tools"]
        KEYCHAIN["Provider keys and refresh tokens"]
        LOCAL_DATA["Sessions, Agent state, workspaces, artifacts"]
        SANDBOX["OS sandbox and explicit approvals"]
    end

    subgraph AGENTMESH["AgentMesh360 service boundary"]
        IDENTITY["Login and refresh"]
        SUBSCRIPTION["Subscription and entitlement"]
        CREDITS["Cloud-action credits and ledger"]
        PACKAGES["Signed package distribution"]
    end

    subgraph THIRD_PARTY["Third-party provider boundary"]
        MODEL["Selected BYOK model API"]
    end

    UI --> HOST
    HOST --> HARNESS
    HARNESS --> SANDBOX
    KEYCHAIN -->|"credentials only when needed"| HOST
    HARNESS <--> LOCAL_DATA
    HOST <--> IDENTITY
    HOST <--> SUBSCRIPTION
    HOST <--> CREDITS
    HOST <--> PACKAGES
    HOST -->|"direct BYOK prompt and tool context"| MODEL

    PACKAGES -. "never receives" .-> KEYCHAIN
```

Critical subscription, package-signature, permission, and sandbox policy must
be enforced by AgentMesh Host and the operating system. Harness hooks may add
observability and convenience, but they are not the fail-closed security
boundary.

## 9. Implementation map

| Slice | Status | Concrete scope |
| --- | --- | --- |
| Persistent product identity | **Implemented foundation** | SQLite Agent registry, deterministic Main Session, activation ACP methods, pinning, startup restoration |
| Subscription hard gate | **Target next** | Login, refresh, server bootstrap, Host enforcement, subscription UI, website handoff |
| BYOK provider layer | **Target next** | Secure credentials, OpenAI/xAI/Anthropic adapters, capability checks, model selection, normalized streams and errors |
| Dynamic Agent Packages | **Target** | Manifest, signing, catalog, installer, migrations, permission diff, rollback, host-skill adapters |
| Desktop product shell | **Target** | Agent home, fixed conversations, vertical workspaces, activity, artifacts, approvals, settings |
| Background Host | **Target** | Launch-on-login, IPC/ACP bridge, crash recovery, health, notifications, audit, offline behavior |

The current hardcoded Job, LectureCast, and Deploy catalog is scaffolding for
the persistence contract. It must be replaced by the dynamic Agent Package
registry before concrete Agent migration becomes the normal integration path.
