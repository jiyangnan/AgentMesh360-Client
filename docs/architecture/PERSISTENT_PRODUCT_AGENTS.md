# Persistent Product Agents

Status: first implementation slice
Established: 2026-07-21

## Decision

AgentMesh360 treats Job Agent, LectureCast Agent, Deploy Agent, and future
first-party agents as persistent product identities hosted by the Grok Build
Harness. They are not aliases for disposable chat sessions and they are not
independent copies of the full runtime.

Each activated product agent owns:

- a stable product `agent_id`;
- a deterministic main-session UUID;
- a durable main conversation in Grok's existing session store;
- a product-specific Grok `AgentDefinition`;
- a dedicated local workspace;
- desired and observed lifecycle state in a small local registry.

The top-level product agent may use Grok subagents for bounded work. Those
subagents remain ordinary task workers and do not replace the product agent's
identity or long-running conversation.

## Runtime boundary

Grok Build remains responsible for the agent loop, model access, tools,
permissions, session transcripts, compaction, memory, background work, and
subagent execution. AgentMesh360 adds only the product-facing identity,
catalog, activation, restoration, and residency policy.

The local registry lives at `~/.agentmesh360/state.db`. Tests and managed
installations may override the root with `AGENTMESH360_HOME`. Grok session data
continues to use the upstream session store; the registry references it by
stable UUID and does not duplicate transcripts.

## Lifecycle

1. Before activation an Agent is `inactive / available`.
2. Activation records `desired_state = running`, creates its workspace, and
   creates or loads its deterministic main session.
3. An activated main session is pinned across client disconnects, including
   while idle. Ordinary chats and task subagents retain Grok's bounded
   idle-unload behavior.
4. On Harness initialization, all agents whose desired state is `running` are
   restored from the existing Grok session store and pinned again.
5. A failed restoration is recorded as `error` without deleting the durable
   session or changing the desired state, so a later startup can retry.

## ACP surface

The first client-facing contract is deliberately small:

- `x.agentmesh360/agents/list`
- `x.agentmesh360/agents/activate` with `{ "agentId": "job-agent" }`

Both use the standard extension result envelope. The list reports the durable
identity and a live runtime view, including the fixed `mainSessionId` needed to
open the agent's one canonical conversation window.

## Upstream sync rule

AgentMesh360 code is isolated under `xai-grok-shell::agentmesh360`. Integration
with upstream currently touches only module export, ACP extension dispatch,
MvpAgent state construction, initialization restoration, activity visibility,
and idle eviction. This narrow seam is intentional: upstream Grok Build
updates should be merged or rebased explicitly, while product state and
contracts remain owned by the fork.
