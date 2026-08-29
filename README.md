# TaskDock

Durable handoff for MCP Tasks.

## What it does

TaskDock records where a long-running MCP task lives, so a different client
can pick it up later.

When a tool call returns `resultType: "task"`, the server hands back an opaque
`taskId`. That handle is the only way back to the work. TaskDock writes the
handle and the server profile to a local SQLite file. Any later process reads
the row, opens its own MCP connection, and calls `tasks/get`.

```
   Client A  ──── tools/call ────▶  MCP server
      │                                 ▲
      │  taskId                         │  the task keeps
      ▼                                 │  running here
   TaskDock                             │
   (SQLite: server profile + handle)    │
      │                                 │
      ▼                                 │
   Client B  ──────── tasks/get ────────┘
```

TaskDock does not keep the task alive. The MCP server does. TaskDock is a
lookup table with a poller attached. It never proxies traffic, never re-runs
work, and holds nothing in memory between commands.

## Why

MCP 2026-07-28 dropped sessions. The Tasks extension
(`io.modelcontextprotocol/tasks`, SEP-2663) dropped `tasks/list`, deliberately,
so one caller's tasks cannot leak to another. Together those two decisions mean
the `taskId` a server minted is the entire durable pointer to hours of work.

Hosts keep that handle in memory. Close the client and the handle is gone, even
though the server is still working. Nothing in the surveyed ecosystem is a
vendor-neutral inventory of live task handles, so the job falls to a file you
own. See [docs/CLIENT_COMPATIBILITY.md](docs/CLIENT_COMPATIBILITY.md).

## Status

v0.1 release candidate. Local-first, single machine, one SQLite file.

Resume works against the official Rust SDK (`rmcp` 3.1.4) and against this
repo's fixture server. The constraint is upstream: modern Tasks is still rare
on coding agents, so most Client A roles today are custom code, MCP Inspector,
or the bundled demo clients rather than your usual agent.

MIT License. See [LICENSE](LICENSE).

## Install

```bash
npm pack
npm install -g ./taskdock-0.1.0.tgz
taskdock --help
```

Not published to npm yet. `npx taskdock` will not work until then.

Needs Node 22 or newer for `node:sqlite`.

To install from a checkout:

```bash
npm install
npm pack
npm install -g ./taskdock-0.1.0.tgz
```

The registry defaults to `~/.local/share/taskdock/taskdock.sqlite` on Linux.
Set `TASKDOCK_DB` to point somewhere else.

| Variable | Purpose |
| -------- | ------- |
| `TASKDOCK_DB` | SQLite path. Overrides the default. |
| `TASKDOCK_AUTH_TOKEN` | Bearer token, read at call time when a server profile sets `--auth env:TASKDOCK_AUTH_TOKEN`. |

## Quick start

Register a server, then register a handle you already have:

```bash
taskdock server add demo --http http://127.0.0.1:8000/mcp
taskdock register --server demo --task 59b6f0e2-24c4-414d-a437-ed77ad80ae5f
taskdock list
taskdock resume td_01
```

`td_01` is the first id on a fresh registry. `resume` opens a new connection,
polls `tasks/get` until the task reaches a terminal state, and prints the
result.

To watch the whole handoff end to end, run the three-terminal demo:

```bash
# terminal 1
npm run fixture-server

# terminal 2
npm run client-a       # creates a task, registers it, exits

# terminal 3, after client-a has exited
npm run client-b -- td_01
```

`client-b` is a separate process with no shared state. It reads SQLite, dials
the server itself, and gets the answer.

## Commands

### `server add <id> --http <url> [--auth env:VAR]`

Store a server profile. `--auth` names an environment variable, not a secret.
TaskDock reads that variable when it connects and never writes the value to
disk. Anything other than `env:VAR` is rejected.

### `server list`

Table of stored profiles: id, transport, auth variable.

### `server show <id>`

Full profile as JSON.

### `server remove <id>`

Delete a profile. Fails if tasks still reference it, so registered handles
never end up orphaned.

### `register --server <id> --task <handle> [--source-client <name>] [--status <status>]`

Record a task handle against a server profile and print the assigned TaskDock
id. Handles are stored byte for byte. TaskDock never parses them, so `:`, `/`,
`+`, `=`, and non-ASCII all round-trip. The same handle on the same server is
the same task; the same handle on two servers is two rows.

### `list [--json] [--active]`

Registered tasks. `--active` hides terminal states. Human output abbreviates
long handles so they do not end up in a screen share by accident. `--json`
prints the full handle.

### `show <id> [--json]`

One task with its server profile, protocol version, timestamps, and metadata.

### `poll <id>`

One `tasks/get` on a fresh connection. Prints the current status and updates
`last_seen_at`.

### `resume <id> [--until-done]`

Same as `poll`, but keeps polling until the task completes, fails, or is
cancelled. `--until-done` is the default for `resume`.

## How resume works

1. Read the row. TaskDock loads the TaskDock id, the opaque handle, and the
   server profile from SQLite. Nothing else is needed.
2. Open a new connection. Every request carries
   `_meta.io.modelcontextprotocol/protocolVersion`, `clientInfo`, and
   `clientCapabilities`. Over Streamable HTTP, `Mcp-Name` repeats
   `params.taskId`; non-ASCII handles go over as `=?base64?...?=`, and the
   JSON-RPC body stays authoritative.
3. Compare identity. If the server reports a different `name` or `version` than
   the one recorded at registration, TaskDock warns and keeps going. Only you
   know whether that redeploy invalidated the handle.
4. Poll `tasks/get` and write each status back to the row.

Step 2 is the whole claim. A connection that shares no state with Client A
still finds the task, because on this protocol version there is no session
state to share.

The official TypeScript and Python SDKs reject `resultType: "task"` today, so
TaskDock speaks raw JSON-RPC instead of using them.
See [docs/PROTOCOL_NOTES.md](docs/PROTOCOL_NOTES.md).

## Security

Treat the registry file like a list of bearer tokens.

The spec tells servers to mint task IDs with enough entropy to act as bearer
credentials, and some do exactly that. TaskDock stores those handles in
plaintext SQLite. It chmods the file to `0600` where the platform allows it,
which is the only protection there is. Anyone who reads the file can poll or
cancel your tasks.

`taskdock list` abbreviates handles in human output for this reason.
`taskdock show` and `--json` print the full handle. Pipe JSON carefully. Keep
it out of logs, pastebins, and terminal recordings.

Credentials are the one thing TaskDock will not store. A server profile holds
`env:TASKDOCK_AUTH_TOKEN`, the variable name, and resolves it from the
environment at call time. Losing the SQLite file leaks your task handles. It
does not leak your tokens.

## Interop proof

The resume path ran against an official third-party SDK, not only against a
fixture written to pass.

`rmcp` 3.1.4, the official Rust SDK, served its own `TaskDemo` over Streamable
HTTP. Client A called `slow_sum {a: 2, b: 40}`, got a UUID handle, wrote it to
SQLite, and exited. Client B started as a new process, opened a new connection,
polled `tasks/get`, and got `42`. The task state machine lives in
`rmcp::task_manager::TaskManager` throughout. TaskDock supplied the handle and
the URL, nothing more.

```bash
docker compose -f examples/rmcp-task-server/docker-compose.yml up --build
npm run interop
```

Docker is required. Rust on the host is not.

- [docs/SPIKE_RESULTS.md](docs/SPIKE_RESULTS.md) is the verdict and the
  experiment matrix, including restart, Client-A-gone, cross-machine, and
  bad-handle cases.
- [docs/INTEROP_RESULTS.md](docs/INTEROP_RESULTS.md) is the `rmcp` run with
  transcripts.
- [docs/PROTOCOL_NOTES.md](docs/PROTOCOL_NOTES.md) covers what 2026-07-28
  changed and how handles travel on the wire.
- [docs/CLIENT_COMPATIBILITY.md](docs/CLIENT_COMPATIBILITY.md) is the host and
  gateway survey.

## Limitations

**Session-bound servers cannot be resumed.** If a server keys tasks to the
connection that created them, a new connection gets "task not found" and
TaskDock can do nothing about it. The 2026-07-28 spec says servers should not
work that way. Some gateways still do. This is the one failure mode that breaks
the whole premise, so check it early against your server.

**HTTP only.** `server add --stdio` stores a profile, but the transport layer
implements Streamable HTTP. Resume over stdio is not wired up.

**No `tasks/update`.** If a task is `input_required`, `resume` stops and tells
you to fulfill it with a compatible MCP client. TaskDock does not collect that
input itself.

**No daemon, no sync, no notifications.** Polling happens when you run a
command. One SQLite file on one machine, single user. Copying the file (plus
its WAL) to another machine works and is tested, but nothing reconciles two
copies.

**Client A is the bottleneck.** No major coding agent emitted a modern Tasks
handle as of 2026-08-29. Until that changes, you are registering handles from
your own code, from MCP Inspector, or from these demo clients.

**License.** MIT. See [LICENSE](LICENSE).

## Development

```bash
npm install
npm test          # registry, MCP resume, and header encoding tests
npm run typecheck
npm run demo      # scripted end-to-end handoff
npm run experiments
npm run interop   # needs the rmcp container running
```

Layout:

- `src/registry/` SQLite schema and repository
- `src/mcp/` JSON-RPC transport, Tasks calls, `_meta` and header encoding
- `src/server-profiles/` profile parsing
- `src/clients/` the Client A and Client B demo processes
- `src/cli.ts` command surface, `src/taskdock.ts` library API
- `fixtures/test-task-server/` controlled Tasks server, including the
  session-bound Mode B contrast
- `examples/rmcp-task-server/` Docker wrapper around the official `rmcp`
  TaskDemo

Run `npx tsx src/cli.ts ...` to use the CLI from a checkout without installing.
