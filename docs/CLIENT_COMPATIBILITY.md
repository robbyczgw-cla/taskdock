# Client compatibility

Survey date: 2026-08-29. Public docs and source only. Closed-source hosts that do not document Tasks are scored `no` on native support, `UNKNOWN` on hidden internals.

Modern Tasks means `io.modelcontextprotocol/tasks`, `resultType: "task"`, `tasks/get`. Legacy 2025-11-25 Tasks (`params.task`, `tasks/result`, `tasks/list`) does not count.

| Client / Gateway | Modern Tasks | Handle visible | Restart resume | Cross-client resume | Notes |
| ---------------- | ------------ | -------------- | -------------- | ------------------- | ----- |
| Claude Code | no | UNKNOWN | UNKNOWN | no | Docs and official extension matrix do not list Tasks. Closed source. |
| Codex CLI | no | no | no | no | Client capability allow-list omits `io.modelcontextprotocol/tasks`. |
| Cursor | no | UNKNOWN | UNKNOWN | no | Listed for MCP Apps, not Tasks. |
| VS Code / Copilot | no | legacy only | no | no | 2025-11-25 `McpTaskManager` is in-memory. Protocol still pinned to 2025-11-25. |
| Hermes | no | no | no | no | Python SDK v2, which does not implement SEP-2663. |
| OpenCode | no | no | no | no | TypeScript SDK v1. Own `task` tool is a subagent, not MCP Tasks. |
| Pi | no | no | no | no | Coding agent has no built-in MCP. |
| mcpc | no | legacy only | no | no | Explicit: 2026-07-28 Tasks extension not supported. |
| ToolHive | no | no | no | no | Parses legacy `tasks/*` and default-denies them. |
| IBM ContextForge | no | no | no | no | Issue #5683 not shipped. `tasks/get` is `-32601`. Planned opaque backend-scoped handles, no session affinity. |
| MCP Inspector | yes | yes | no | no | Only interactive client found. Works around SDK v2 rejecting `resultType: "task"`. Handles live in that Inspector session. |
| TS SDK v2 | no | no | no | no | [#2189](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189) open. Codec rejects the wire. |
| Python SDK v2 | no | no | no | no | Docs: extension not implemented. |
| C# SDK | library | library | n/a | n/a | `ModelContextProtocol.Extensions.Tasks`. |
| Rust SDK `rmcp` | library | library | n/a | n/a | `enable_tasks()`, `get_task`. |

## Failure D

Do major hosts already ship durable task discovery? **No.**

SEP-2663 removed `tasks/list`. VS Code and mcpc still have *legacy* list APIs. VS Code's is in-memory and tied to the `McpServer` instance. Inspector "Refresh" re-polls handles it already knows. Nothing surveyed is a vendor-neutral durable inventory.

## ContextForge

Not testable today. [#5683](https://github.com/IBM/mcp-context-forge/issues/5683) tracks the migration. Planned design matches TaskDock's hypothesis (opaque backend-scoped handles, no session affinity). Current gateway default-denies unknown extension methods, so a modern server behind ContextForge cannot be polled through it. Do not patch ContextForge to make this spike look viable.

## What this means

The protocol is ready. Production coding agents are not. The only ready interactive client for a modern Tasks server is MCP Inspector. TaskDock's first real users are custom clients, Inspector-adjacent workflows, and C#/Rust servers, until hosts ship the extension.

That is a go-to-market constraint, not a protocol blocker. It also means no incumbent already occupies the "durable handoff" slot.
