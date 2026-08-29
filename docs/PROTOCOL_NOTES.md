# Protocol notes

Target: `io.modelcontextprotocol/tasks`, schema `2026-07-28`.

Source of truth: [ext-tasks](https://github.com/modelcontextprotocol/ext-tasks) `schema/2026-07-28/schema.ts`.

## What changed in MCP 2026-07-28

The core protocol dropped `initialize` / `notifications/initialized` and `Mcp-Session-Id`. Every request carries:

```text
_meta.io.modelcontextprotocol/protocolVersion
_meta.io.modelcontextprotocol/clientInfo
_meta.io.modelcontextprotocol/clientCapabilities
```

Discovery is `server/discover`. Streamable HTTP adds `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` on each POST.

Tasks left the experimental core and became this extension. `tasks/list` and `tasks/result` are gone.

## Methods

| Method | Role |
| ------ | ---- |
| `tools/call` | May return `CreateTaskResult` (`resultType: "task"`) instead of a normal tool result |
| `tasks/get` | Poll. Terminal states inline `result` or `error`. `resultType: "complete"` |
| `tasks/update` | Fulfill `inputRequests` |
| `tasks/cancel` | Cooperative cancel ack |

There is no `tasks/list`. The spec says that on purpose: one caller's tasks must not leak to another.

## Task identity on the wire

`taskId` is an opaque server-minted string. The spec tells servers to generate enough entropy that IDs can act as bearer tokens.

TaskDock stores the string verbatim. It never parses `:`, `/`, `+`, `=`, unicode, or length.

For Streamable HTTP, `Mcp-Name` on `tasks/get`, `tasks/update`, and `tasks/cancel` MUST be `params.taskId`. Values that are not plain ASCII (or that have leading/trailing whitespace, or that match the sentinel pattern) MUST use `=?base64?{utf8-base64}?=`. The JSON-RPC body remains the source of truth. Servers decode the header before comparing it to the body.

`tasks/update` and `input_required` are specified but not implemented in this spike. The fixture returns `-32601` for `tasks/update`.

## Session coupling

2026-07-28 has no protocol session. A new HTTP POST with the same `taskId` is a valid resume, provided the server kept the task.

The spec also says the task store must be reachable after the worker or connection dies. A `CreateTaskResult` must not be returned until `tasks/get` would succeed.

Servers that still bind tasks to a connection, a minted session header, or an in-memory map are not following this extension. The fixture's Mode B exists only to measure that failure.

## Auth coupling

From the extension security section:

- Servers MUST authz-check each `tasks/get` / `update` / `cancel`.
- Task IDs MAY be bearer tokens.
- There is no list, so existence of other callers' tasks does not leak through the protocol.

TaskDock therefore stores a server profile reference (`authProfile: "env:TASKDOCK_AUTH_TOKEN"`), not a secret. Client B presents its own credentials. Whether a *different* identity can resume the same task is the server's policy, not TaskDock's.

## SDK status (2026-08-29)

Official TypeScript SDK v2 (`@modelcontextprotocol/client` / `server` 2.0.0) implements 2026-07-28 core and **rejects** this extension:

- inbound `tasks/*` → `-32601`
- outbound `tasks/*` → `MethodNotSupportedByProtocolVersion`
- `resultType: "task"` → `UnsupportedResultType`

[#2189](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189) (SEP-2663) is still open. Python `mcp` 2.1.1 says the same. v1 `experimental.tasks` is the 2025-11-25 core design (`tasks/result`, `tasks/list`). C# and Rust SDKs have library support.

This spike speaks raw JSON-RPC over HTTP. That was required, not a style choice.

## Minimum resume identity

Required:

```text
opaque taskId
+
how to reach the server (HTTP URL for this spike)
+
protocol dialect (2026-07-28 + tasks extension in _meta)
+
credentials the server will accept
```

Useful, not required:

```text
manual serverProfileId
serverInfo.name / version
ttlMs, pollIntervalMs
sourceClient
status cache
```

Debug-only:

```text
fixture instanceId
lastSeenAt
raw CreateTaskResult
```

Not required on a compliant 2026-07-28 server:

```text
MCP session ID (removed)
original connection
original process
original JSON-RPC request id
original client name
```

URL alone is not a universal server identity. Two processes can share a URL over time, a gateway can multiplex many backends on one URL, and stdio has no URL. The spike uses a manually configured `serverProfileId`. Production still needs a stronger binding (canonical endpoint + server name + deployment/instance + auth realm). Replay of a handle against the wrong profile is a real footgun. Experiment H showed the server then returns "Task not found"; TaskDock keeps the row.

## Stdio vs HTTP

HTTP resume in this spike is a new POST. Stdio resume would spawn a **new server process**. That only works if the server's task store is outside that process (the fixture's SQLite). An in-memory stdio server is Mode B by accident.

## Field classification (registry)

| Field | Class |
| ----- | ----- |
| `taskHandle` | required for resume |
| `serverProfile.transport` | required for resume |
| `serverProfile.authProfile` | reference only; client supplies the secret |
| `protocolVersion` / `taskExtensionVersion` | required to speak the right dialect |
| `status` | useful metadata (cached, may be stale) |
| `sourceClient` | useful metadata, client-specific |
| `createdAt` / `lastSeenAt` | useful metadata |
| `metadata.ttlMs` / `pollIntervalMs` | useful metadata |
| `metadata.serverInfo` | debug-only unless used as a mismatch check |
| uniqueness `(server_profile_id, task_handle)` | safe on this fixture; do not assume globally unique handles |
