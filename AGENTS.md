# AgentMesh360 Client Repository Rules

## Repository role

This is the only active repository for the AgentMesh360 desktop client. It is
a Grok-first fork of `xai-org/grok-build` and owns all new client, harness,
persistent-agent, session, memory, package, lifecycle, and desktop UX work.

The former repository at `/Users/ferdinandji/AgentMesh` is a legacy prototype
and migration source. Do not implement new client features there. Copy or
rewrite only still-valid contracts and assets into this repository, with an
explicit source note when provenance matters.

## Development status

Development is paused by owner decision on 2026-11-11. The last development
cycle closed on 2026-08-05. Do not start new client features, upstream
synchronization, packaging or release work here until the owner explicitly
reopens the repository. Reading the repository and answering questions about it
remain fine.

The owner adopted the restart-review criteria on 2026-11-14, recorded in
[README](README.md#开发暂停与重启评审条件). Meeting either condition only permits
a restart review; it does not reopen development or authorize a release.
Preserve the freeze until the owner explicitly reopens it.

## Product direction

- Grok Build is the primary harness, not an optional execution adapter.
- Job Agent, LectureCast Agent, and Deploy Agent are persistent top-level
  product agents with stable main conversations.
- Activated agents remain available across window closes, app restarts, and
  operating-system restarts.
- Harness subagents are task workers; they are not the user-visible product
  agents.
- The AgentMesh360 supervisor is internal infrastructure, not a user-facing
  chat persona.

## Upstream discipline

- Preserve the Apache-2.0 license, `SOURCE_REV`, upstream attribution, and all
  third-party notices.
- Keep `upstream` pointed at `https://github.com/xai-org/grok-build.git` with
  push disabled. The AgentMesh360 remote is `origin`.
- Treat the generated root `Cargo.toml` as read-only, following the upstream
  repository guidance.
- Keep AgentMesh360-owned changes isolated in clearly named modules where
  practical so upstream synchronization remains reviewable.
- Never replace a reviewed AgentMesh360 change by blindly reapplying an
  upstream snapshot.

## Change routing

Before editing, classify the change:

- AgentMesh360 product or client work: implement here.
- Grok Build upstream synchronization: fetch from `upstream`, review the diff,
  and preserve AgentMesh360 behavior and notices.
- Legacy prototype archaeology: read `/Users/ferdinandji/AgentMesh`, then port
  the minimum useful behavior here. Do not continue development in the legacy
  repository.
