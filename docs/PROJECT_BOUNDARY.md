# AgentMesh360 Client Repository Boundary

Status: active development
Established: 2026-07-21

## Purpose

`AgentMesh360-Client` is the canonical desktop-client repository for the
AgentMesh360 product. It forks Grok Build so that AgentMesh360 can build on its
agent loop, sessions, tools, permissions, memory, background tasks, subagents,
and ACP surfaces instead of recreating a harness around direct model calls.

The product target is a desktop client in which activated first-party agents
such as Job Agent, LectureCast Agent, and Deploy Agent remain available with a
stable identity and main conversation across application and operating-system
restarts.

## Repository roles

| Repository | Role | Development policy |
| --- | --- | --- |
| `jiyangnan/AgentMesh360-Client` | Canonical AgentMesh360 desktop client and Grok Build fork | All new client and harness work happens here |
| `xai-org/grok-build` | Upstream harness source | Fetch and review; never push |
| `jiyangnan/AgentMesh` | Legacy Electron/OpenClaw/direct-LLM prototype and migration source | No new client features |

## What may migrate from the legacy repository

- Validated product requirements and user flows
- AgentMesh360 branding and reusable visual assets
- Account, entitlement, subscription, and cloud-distribution contracts that
  still match the current product direction
- Tests or fixtures that express still-valid behavior

Old runtime assumptions, direct Chat Completions code, mock OpenClaw adapters,
and obsolete Bridge architecture must not be copied merely to preserve prior
implementation effort.

## Git remote policy

- `origin`: `https://github.com/jiyangnan/AgentMesh360-Client.git`
- `upstream`: `https://github.com/xai-org/grok-build.git`
- Pushes to `upstream` must remain disabled.
- Upstream imports must preserve `LICENSE`, `SOURCE_REV`,
  `THIRD-PARTY-NOTICES`, and relevant attribution.
