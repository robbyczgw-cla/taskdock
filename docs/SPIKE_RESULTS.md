# TaskDock Spike Results

## Verdict

```text
BUILD
```

A Tasks server that keeps handles outside the MCP connection lets Client B resume Client A's work from a SQLite row: server profile, opaque handle, and Client B's own credentials. TaskDock never ran the task. The protocol removed `tasks/list` on purpose, so durable discovery is not something hosts already provide. The fixture covers the exercised `tools/call` → `tasks/get` path, not the full 2026-07-28 surface.

## Executive Summary

- MCP 2026-07-28 has no sessions. `taskId` is the durable handle.
- The Tasks extension has no `tasks/list`. Discovery has to live somewhere else.
- Experiments A–H on a controlled fixture: all PASS for connection-independent (Mode A) servers.
- Mode B (session-bound server) fails resume on a new connection. That is a server bug relative to the spec, and a real deployment risk.
- Client A ≠ Client B works when they are independent processes that share only the registry file and server URL.
- TaskDock stores no authentication credentials. `authProfile` is `env:TASKDOCK_AUTH_TOKEN`. Task handles may themselves be bearer secrets, so the SQLite file and CLI output need the same protection as a session token.
- Official TS/Python SDKs reject this extension today. The spike speaks raw JSON-RPC.
- No major coding-agent host ships modern Tasks as of 2026-08-29. MCP Inspector does. ContextForge does not (`tasks/get` is `-32601`).
- Failure D is false: nothing surveyed is a vendor-neutral durable task inventory.
- Do not BUILD a gateway. The registry thesis held.

## What worked

**Canonical demo** (`npm run demo`, 2026-08-29). Client A created `task_9935b3228997e8a3`, registered `td_01`, exited. Client B loaded `td_01` from SQLite, opened a new HTTP connection, polled `tasks/get`, got `hello`.

**Experiment matrix** (`npm run experiments`):

| Exp | Result | Evidence |
| --- | ------ | -------- |
| A same process | PASS | handle polled in the creating process |
| B TaskDock restart | PASS | SQLite reopen, then `tasks/get` |
| C Client A gone | PASS | `client-a` exit 0, then independent poll `working` |
| D new MCP session | PASS | new client name on a new POST. Weak alone (no session state exists). E/F/G are the real cross-process evidence. |
| E different clients | PASS | `client-a.ts` then `client-b.ts`, completed `hello` |
| F no runtime state | PASS | `taskdock resume` in a new process, completed `F` |
| G other machine (dir copy) | PASS | copied sqlite (plus WAL if present) host→guest, completed `G` |
| H bad handles | PASS | not found / expired / wrong server; rows kept; cancel → `cancelled` |
| Mode B contrast | PASS | new connection → `Task not found in this session` |

**Tests:** 6 registry + 10 MCP resume + header encoding tests. Opaque handles (`cfth1:....`, `backend/task/123`, unicode) are stored verbatim. Non-ASCII `taskId` values go on `Mcp-Name` as `=?base64?...?=`, per Streamable HTTP 2026-07-28. The fixture rejects missing or mismatched `Mcp-Name`.

**Auth:** fixture with `TASKDOCK_FIXTURE_TOKEN` rejected unauthenticated calls. A stored `authProfile` of `env:TASKDOCK_AUTH_TOKEN` resolved `process.env.TASKDOCK_AUTH_TOKEN` at call time. The token itself is not in SQLite.

## What failed

**Mode B servers.** If the server keys tasks by a connection or a minted session header, TaskDock cannot resume without storing that secret session. The 2026-07-28 spec does not work that way. Some real gateways still might.

**Production hosts.** Claude Code, Codex, Cursor, VS Code, Hermes, OpenCode, Pi, mcpc, ToolHive, ContextForge do not speak modern Tasks. Two existing product clients could not participate. MCP Inspector can, but it does not persist handles.

**SDKs.** `@modelcontextprotocol/client` 2.0.0 throws on `resultType: "task"` and `tasks/get`. A host built on that SDK cannot be Client B without a bypass (Inspector already does this).

**Stdio not exercised.** HTTP only. Stdio resume would spawn a new server process and needs an out-of-process task store.

**Different-machine** was a directory copy on one host, not a container. The guest still reached the same `127.0.0.1` fixture. Cross-network identity (DNS, TLS, auth realm) is untested.

**Different credentials.** Untested. Spec requires the server to authz each `tasks/get`. Client B used the same env token as Client A when auth was on.

**No third-party Tasks server.** Every PASS used this repo's fixture. "Spec-compliant" here means the 2026-07-28 schema as implemented in `fixtures/test-task-server`.

**`input_required` / `tasks/update`.** Not implemented on the fixture. `pollUntilTerminal` would wait until timeout if a task entered that state.

## Required state for task resume

| State           | Required? | Why |
| --------------- | --------- | --- |
| task handle     | yes       | Only identifier `tasks/get` accepts. Opaque. |
| server identity | yes       | Must hit the process that owns the task store. Spike uses `serverProfileId` + HTTP URL. URL alone is not a universal identity. |
| MCP session ID  | no        | Removed in 2026-07-28. Mode B fixtures that reintroduce one break resume. |
| original client | no        | Experiment E used `client-a` then `client-b`. |
| credentials     | yes*      | Server MUST authz. TaskDock does not store them. *Same identity may be required; task IDs MAY also be bearer tokens. |
| request ID      | no        | JSON-RPC ids are per-request. |
| connection      | no        | 2026-07-28 has no connection affinity. Proven by separate-process E/F/G. In-process POSTs may still share TCP keep-alive. |

## Cross-client test

```text
Client A: src/clients/client-a.ts (own process, then exit)
Client B: src/clients/client-b.ts (own process, no A imports)
Server:   fixtures/test-task-server, TASK_BINDING=independent
Transport: Streamable HTTP JSON POST, 2026-07-28
Auth:     none on the demo path
```

Result:

```text
PASS
```

Transcript (`npm run demo`):

```text
[client-a]

Starting long-running MCP task...

taskId:
task_9935b3228997e8a3

Registering with TaskDock...

TaskDock ID:
td_01

Client A terminating.
Exiting Client A.

[client-b]

No state from Client A loaded.

Querying TaskDock...

Found:
td_01
server: demo
task: task_9935b3228997e8a3

Opening fresh MCP connection
Using task handle task_9935b3228997e8a3

Task status: working
...
Task status: completed

status: completed
Result: hello
```

Client B called `tasks/get` on the fixture. It did not read a cached tool result from TaskDock.

## Cross-process test

PASS. Experiment F: after `client-a` exited, `taskdock resume td_01 --until-done` in a new Node process completed with result `F`. Registry path was the only shared state.

## Cross-machine test

PASS as an isolated-directory simulation (experiment G). Guest received a copy of `taskdock.sqlite` only. No Client A files. Same fixture URL on loopback.

Not attempted: Docker, another host, or a server that is not already reachable.

## Existing ecosystem overlap

See [CLIENT_COMPATIBILITY.md](CLIENT_COMPATIBILITY.md).

No coding-agent host ships a durable MCP task inventory. VS Code's task manager is in-memory and legacy. mcpc's `tasks-list` is 2025-11-25 only. Inspector tracks handles for one session. ContextForge's Tasks work is issue #5683.

The category is empty. The clients that would fill TaskDock's registry are late.

## Architectural blockers

None for a 2026-07-28 Tasks server that stores handles independently of the MCP connection. The fixture covers the exercised `tools/call` → `tasks/get` path, not the full spec.

Real constraints, not blockers:

1. Hosts must emit and accept modern handles. Most do not.
2. Servers that bind tasks to sessions make the registry useless (Mode B).
3. Strong server identity is still a product problem. `serverProfileId` is a spike stand-in.
4. Authz is the server's. Cross-user resume is out of scope and likely forbidden.
5. Building a proxy/gateway would abandon the thesis. The spike did not need one.

## Product implications

What does TaskDock uniquely provide?

A vendor-neutral durable index of MCP task handles, with enough server profile data for a *different* client to call `tasks/get` itself.

Git stores commit ids. Docker stores container ids. MCP does not store task ids once `tasks/list` was removed. Clients are told to persist handles; none of the major hosts do.

The UX sketch (`taskdock list` / `taskdock resume td_12` / "resume task td_12 from TaskDock") is compatible with this model. Plumbing is the registry plus a fresh MCP call. Not a scheduler.

Do not ship a SaaS, a credential vault, or an MCP gateway on the back of this spike.

## Recommended next step

```text
BUILD a minimal TaskDock CLI
```

Keep it a local SQLite registry plus `register` / `list` / `show` / `resume`. Add an optional MCP tool surface so Inspector (and later hosts) can ask "what unfinished tasks do we know about?" without TaskDock owning the connection.

Park the product if you need two *shipping* coding agents as Client A and Client B before writing more code. The protocol question is already answered.
