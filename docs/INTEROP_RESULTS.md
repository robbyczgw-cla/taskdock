# TaskDock Third-Party Interop Results

## Verdict

```text
BUILD
```

Official `rmcp` 3.1.4 (Rust MCP SDK) created a modern Tasks handle. Client A registered it in SQLite and exited. Client B opened a new process and a new HTTP connection, called `tasks/get`, and received `42`. TaskDock did not run the work.

## External implementation

```text
Project: rmcp TaskDemo over Streamable HTTP
Repository: https://github.com/modelcontextprotocol/rust-sdk
Version/commit: crates.io rmcp 3.1.4 (2026-08-20)
Language: Rust
SDK: rmcp 3.1 (official)
Transport: Streamable HTTP, json_response=true, 0.0.0.0:8000/mcp
Tasks extension version: io.modelcontextprotocol/tasks (SEP-2663, 2026-07-28)
```

The example in `examples/rmcp-task-server` is a thin HTTP wrapper. `TaskManager`, `CreateTaskResult`, `tasks/get`, `tasks/update`, and `tasks/cancel` come from the `rmcp` crate.

## Why this implementation counts

`rmcp` is the official Model Context Protocol Rust SDK. TaskDock does not implement the task state machine for this server. Sharing one `TaskDemo` clone across HTTP requests uses `TaskManager`'s documented `Arc` store so handles survive a new connection. That is SDK configuration, not a TaskDock reimplementation.

## Experiment I

Flow:

```text
docker compose up rmcp-tasks
client-a: tools/call slow_sum {a:2,b:40} → resultType task
register SQLite, exit
client-b: new process, tasks/get, poll until completed
```

Result:

```text
PASS
```

Transcript (2026-08-29):

```text
=== Experiment I: third-party rmcp TaskDemo ===
server: http://127.0.0.1:8000/mcp

[client-a]
Connected. server={"name":"rmcp","version":"3.1.4"}
taskId:
59b6f0e2-24c4-414d-a437-ed77ad80ae5f
TaskDock ID:
td_01
Exiting Client A.

[client-b]
No state from Client A loaded.
Loaded td_01 from persistent TaskDock registry
Opening fresh MCP connection
Using task handle 59b6f0e2-24c4-414d-a437-ed77ad80ae5f
serverInfo: {"name":"rmcp","version":"3.1.4"}
Task status: working
Task status: completed
Result: 42

Experiment I: PASS
```

Reproduce:

```bash
docker compose -f examples/rmcp-task-server/docker-compose.yml up --build
npm run interop
```

Requires Docker. Rust is not needed on the host.

## Experiment J

Inspector/existing-client test.

Result:

```text
NOT POSSIBLE (automated)
```

This environment has no Inspector UI session. Manual steps: [docs/interop/INSPECTOR.md](interop/INSPECTOR.md). If Inspector hides `resultType: "task"` and only shows the final 42, it cannot act as Client A.

## Optional Experiment K/L

Not attempted. Official TaskDemo has no `input_required` tool. Reverse Inspector resume was not run.

## What TaskDock needed

| State                 | Needed |
| --------------------- | ------ |
| taskId                | yes (UUID from rmcp) |
| server URL            | yes (`http://127.0.0.1:8000/mcp`) |
| serverInfo            | useful (`name: rmcp`, `version: 3.1.4`). Resume warned only on mismatch. |
| session id            | no |
| credentials           | no (local no-auth) |
| original client state | no |
| connection            | no |

## Differences from TaskDock fixture

- Tool is `slow_sum` `{a,b}`, not `slow_echo`.
- Handle is a UUID, not `task_<hex>`.
- Server identity is `rmcp` / `3.1.4` from the SDK, not `taskdock-fixture`.
- Tasks live in `rmcp::task_manager::TaskManager` (in-process Arc), not TaskDock SQLite.
- Default TTL is 5 minutes (rmcp), not 1 hour (fixture).
- HTTP server is official `StreamableHttpService` + Axum.
- Process runs in Docker; host clients use published port 8000.

## Problems discovered

None that blocked resume. Sharing one `TaskDemo` clone is required. `StreamableHttpService::new(|| Ok(TaskDemo::new()))` would mint a new `TaskManager` per session and would fail Experiment I. That is an rmcp HTTP default, not a Tasks protocol rule.

## Security observations

rmcp task IDs are UUID v4 (unguessable). TaskDock still stores them in plaintext SQLite (mode 0600 where chmod works) and prints them on register/resume. Treat the registry file like a bearer-token list.

## Ecosystem implications

Independent official SDK servers can emit handles that another client resumes without the origin process. The Phase 1 fixture result is not an artifact of our server. Hosts still generally do not speak modern Tasks, so TaskDock's first users remain custom clients and SDK servers.

## Final recommendation

```text
BUILD a minimal TaskDock CLI
```

Keep using it against real `rmcp` (and later C#) servers. Do not wait for every coding agent. Optional next: Inspector as Client A, or a TaskDock MCP list surface. Do not build a gateway.
