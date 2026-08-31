# Ingestion

Once a TaskDock integration observes a native MCP Task handle, that task
becomes durably discoverable and controllable across later client sessions.

TaskDock cannot magically discover a native MCP task that no integration ever
observed. SEP-2663 has no `tasks/list`.

## Capture models

```text
client hook/plugin     (when the host exposes a CreateTaskResult)
opt-in observer/wrapper
explicit/manual registration   (always available)
```

```text
Client creates native MCP Task
        ↓
taskdock ingest --server <id> --stdin
        ↓
row in the local SQLite index
        ↓
later process: taskdock get / cancel / update / resume
```

TaskDock is not in the MCP path. The hook runs after the tool result exists,
then exits. Control still talks to the native server.

## Server mapping

`--server` must be an existing TaskDock profile id. Display names are not
looked up. Client MCP configs are not imported (they often contain secrets).
If a later adapter can derive a fingerprint from non-secret transport, it may
resolve an existing profile by fingerprint. This slice does not create
profiles automatically.

## What is stored

From a CreateTaskResult: native `taskId`, status, `ttlMs`, optional
`serverInfo.name` / `version` from `_meta`. Source client and label if the
hook supplied them.

Not stored: raw JSON-RPC, tool arguments, tool `result` content, headers,
credentials.

## Hook failure

`taskdock ingest` exits non-zero on unknown server, invalid CreateTaskResult,
or I/O errors. A post-tool hook should not fail the client's tool call for
that. `examples/ingest-hook.sh` swallows ingest errors and exits 0.

Non-task payloads: exit 0, print `ignored`, unless `--strict`.

## Client surfaces (2026-08-31)

Verified against current public docs and GitHub, not assumed from the 2026-08-29
compatibility survey. No first-party adapter ships in this branch because none
of the hosts both speak SEP-2663 and expose a CreateTaskResult to a hook.

| Client | Native SEP-2663 | Observe CreateTaskResult without a proxy | Testable as Client A | Verdict |
| ------ | --------------- | ---------------------------------------- | -------------------- | ------- |
| Claude Code | no (not on the extension matrix) | PostToolUse `tool_response` exists; would work if the host ever returned `resultType: "task"` | no | NO_TASKS |
| Codex CLI | no. Allow-list omits the extension. `rmcp` `call_tool` maps `CallToolResponse::Task` to `UnexpectedResponse` before hooks | `PostToolUse` / `tool_response` is real, but only after a successful `CallToolResult` | no | NO_TASKS |
| Cursor | no | no documented MCP result hook | no | NO_TASKS |
| VS Code / Copilot | legacy 2025-11-25 tasks only | in-memory `McpTaskManager`, not a CreateTaskResult hook | no | NO_TASKS |
| OpenCode | no. Pins TS SDK 1.29; `callTool` uses `CallToolResultSchema` | `tool.execute.after` runs only after that schema succeeds | no | NO_TASKS |
| Pi | no MCP client in core | `pi.on("tool_result")` sees Pi's normalized result, not an MCP wire body | no | NO_TASKS |
| Hermes | Python SDK 2.0, SEP-2663 not implemented | `post_tool_call` gets a JSON string of adapted `CallToolResult`, not `CreateTaskResult` | no | NO_TASKS |
| MCP Inspector | yes | interactive UI; no machine hook that emits CreateTaskResult to stdin | manual copy | INSPECTOR_ONLY |

Reference integration: this repo's fixture + `taskdock ingest` (see tests).
That is the reproducible Client A until a host emits `resultType: "task"`
into a hook.

When a host starts returning CreateTaskResult, wire:

```text
post-tool hook
  → examples/ingest-hook.sh
  → taskdock ingest --server <profile> --source-client <host> --stdin
```

No TaskDock-specific adapter is required for that shape.

## API

```ts
import { parseObservedTask, TaskDock } from "taskdock";

const parsed = parseObservedTask(payload, { serverProfileId: "demo", sourceClient: "hook" });
if (parsed.kind === "task") {
  const { record, created } = dock.ingest(parsed.observed);
}
```

`TaskIngestor` remains the interface for future observers. Do not add
host-specific types until a host actually emits the wire shape.
