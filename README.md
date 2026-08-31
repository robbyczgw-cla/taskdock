# TaskDock

Capture native MCP task handles once, resume/control them from any later
session.

Durable task index for MCP Tasks (`io.modelcontextprotocol/tasks`).

## What it does

TaskDock records where a long-running MCP task lives, so a different client
can find it again later and drive it.

When a tool call returns `resultType: "task"`, the server hands back an opaque
`taskId`. That handle is the only way back to the work. TaskDock writes the
handle and the server profile to a local SQLite file. Any later process reads
the row, opens its own MCP connection, and calls `tasks/get`, `tasks/cancel`,
or `tasks/update`.

```
   Client A  ──── tools/call ────▶  MCP server
      │                                 ▲
      │  taskId                         │  the task keeps
      ▼                                 │  running here
   TaskDock                             │
   (SQLite: server profile + handle)    │
      │                                 │
      ▼      tasks/get, tasks/cancel,   │
   Client B  ──────── tasks/update ─────┘
```

TaskDock does not keep the task alive. The MCP server does. TaskDock is a
lookup table with a poller attached. It never proxies traffic, never re-runs
work, and holds nothing in memory between commands.

It is also not a gateway. A gateway sits in the path. Every task call goes
through it, so it has to be running, has to be trusted, and it gets to rewrite
what it forwards. TaskDock does none of that. Each command opens its own
connection to the server with the handle it read from disk, and the native
`taskId` goes out byte for byte. Delete the registry and your tasks keep
running. You just lose the handles.

### What it cannot do

SEP-2663 has no `tasks/list`. There is no request that asks a server which
tasks you own. TaskDock knows the handles it was given or ingested and
nothing else, so a task that was never observed is unrecoverable. Ingest and
register are the whole game.

## Why

MCP 2026-07-28 dropped sessions. The Tasks extension
(`io.modelcontextprotocol/tasks`, SEP-2663) dropped `tasks/list`, deliberately,
so one caller's tasks cannot leak to another. Together those two decisions mean
the `taskId` a server minted is the entire durable pointer to hours of work.

Hosts keep that handle in memory. Close the client and the handle is gone, even
though the server is still working. Nothing in the surveyed ecosystem is a
vendor-neutral inventory of live task handles, so the job falls to a file you
own. See [docs/CLIENT_COMPATIBILITY.md](docs/CLIENT_COMPATIBILITY.md).

## Two kinds of id

`td_01` is a TaskDock id. It is assigned at register time, it counts up, and it
means nothing outside your SQLite file. The native MCP `taskId` is minted by the
server and is the thing the server will actually answer to.

Every command takes the TaskDock id. The native handle stays visible: `list`
shows it abbreviated in the `NATIVE` column, `show` and `get` print it as
`native:`, and `--json` carries it in full as `nativeTaskId`.

## Status

v0.2.0. Local-first, one SQLite file. Native `get` / `cancel` / `update`, plus
`ingest` for one-shot hooks. See [CHANGELOG.md](CHANGELOG.md).

Resume works against the official Rust SDK (`rmcp` 3.1.4) and against this
repo's fixture server. Coding agents still rarely emit modern Tasks, so Client
A today is a hook, MCP Inspector, or the bundled demo. See
[docs/INGESTION.md](docs/INGESTION.md).

MIT License. See [LICENSE](LICENSE).

## Install

```bash
npm install -g taskdock
taskdock --help
```

Needs Node 22 or newer for `node:sqlite`.

From a checkout: `npx tsx src/cli.ts --help`.

The registry defaults to `~/.local/share/taskdock/taskdock.sqlite` on Linux.
Set `TASKDOCK_DB` to point somewhere else.

| Variable | Purpose |
| -------- | ------- |
| `TASKDOCK_DB` | SQLite path. Overrides the default. |
| `TASKDOCK_AUTH_TOKEN` | Bearer token, read at call time when a server profile sets `--auth env:TASKDOCK_AUTH_TOKEN`. |

## Quick start

End to end, two processes. The task keeps running on the MCP server.

```bash
# terminal 1: native Tasks server
npm run fixture-server

# process A: a hook saw CreateTaskResult
taskdock server add demo --http http://127.0.0.1:3333/mcp
echo '{"resultType":"task","taskId":"<native-id>","status":"working"}' \
  | taskdock ingest --server demo --source-client hook --stdin
# process A exits

# process B: new shell, no state from A
taskdock list
taskdock get td_01
taskdock cancel td_01
```

`td_01` is the first id on a fresh registry. `get` opens a new connection and
asks the server once. `cancel` / `update` route the native methods, then read
status back. `resume` polls until terminal.

If you already have a handle, `taskdock register --server demo --task-id <id>`
is the fallback.

To watch Client A / Client B without a hook:

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

Writing a profile also computes a fingerprint, a SHA-256 over the canonical
endpoint and the auth reference, never over a credential. Two aliases for the
same endpoint hash the same, which is how you tell that a re-added profile
points where the old one did. See
[docs/SERVER_IDENTITY.md](docs/SERVER_IDENTITY.md).

### `server list`

Table of stored profiles: id, transport, auth variable.

### `server show <id>`

Full profile as JSON, including the fingerprint.

### `server remove <id>`

Delete a profile. Fails if tasks still reference it, so registered handles
never end up orphaned.

### `register --server <id> --task-id <native-id> [--source-client <name>] [--label <label>]`

Record a native task handle against a server profile and print the assigned
TaskDock id. `--task` still works as an alias for `--task-id`.

Handles are stored byte for byte. TaskDock never parses them, so `:`, `/`, `+`,
`=`, and non-ASCII all round-trip. The same handle on the same server is the
same task; the same handle on two servers is two rows.

### `ingest --server <id> [--source-client <name>] [--stdin | --payload <json>] [--strict]`

One-shot hook sink. Reads a CreateTaskResult (or a JSON-RPC envelope whose
`result` is one) and registers it. Ordinary tool results print `ignored` and
exit 0, so a client hook can forward every tool response. `--strict` turns
that into an error. Human output is `registered td_07` or `known td_07`.
`--json` does not include the native taskId. Fail the originating tool call
only if you want that; the sample wrapper in `examples/ingest-hook.sh` always
exits 0. See [docs/INGESTION.md](docs/INGESTION.md).

Manual `register` remains the fallback when no hook is installed.

### `list [--json] [--active] [--server <id>] [--status <status>]`

Registered tasks: id, cached status, server, native handle, origin, age.
`--active` hides terminal states, `--server` and `--status` filter. Human output
abbreviates long handles so they do not end up in a screen share by accident.
`--json` prints them in full.

### `show <id> [--json]`

The cached registry row. Server profile, protocol version, timestamps,
metadata, and the status as of the last time something looked. It talks to
nobody, which is why it labels the status stale.

### `get <id> [--json]`

A live `tasks/get` on a fresh connection. Prints the current status, any status
message, the result or error, and writes the status back to the row. `poll` is
an alias for the same thing.

### `cancel <id> [--json]`

Routes `tasks/cancel` to the server, then reads the status back with one
`tasks/get`. The server decides what cancellation means. TaskDock reports the
acknowledgement and whatever status followed it.

### `update <id> --input-responses <json> [--json]`

Routes `tasks/update` with a JSON object of responses, for a task sitting in
`input_required`, then reads the status back the same way. This is the one
command that sends the server something other than a handle.

### `resume <id>`

Polls `tasks/get` on a fresh connection until the task completes, fails, or is
cancelled, printing each status change on the way. If the task stops at
`input_required`, `resume` says so and points you at `update`.

## How resume works

1. Read the row. TaskDock loads the TaskDock id, the native handle, and the
   server profile from SQLite. Nothing else is needed.
2. Open a new connection. Every request carries
   `_meta.io.modelcontextprotocol/protocolVersion`, `clientInfo`, and
   `clientCapabilities`. Over Streamable HTTP, `Mcp-Name` repeats
   `params.taskId`; non-ASCII handles go over as `=?base64?...?=`, and the
   JSON-RPC body stays authoritative.
3. Compare identity when we already have it. `register` may call
   `server/discover` once if the server is up. `get`, `cancel`, and `update`
   do not. They send the native Tasks method with `Mcp-Name` set to the
   native `taskId`. If a later `tasks/get` response carries `serverInfo` in
   `_meta`, TaskDock stores or compares it. A mismatch is a warning. The
   request still goes out. See
   [docs/SERVER_IDENTITY.md](docs/SERVER_IDENTITY.md).
4. Poll `tasks/get` and write each status back to the row.

Step 2 is the whole claim. A connection that shares no state with Client A
still finds the task, because on this protocol version there is no session
state to share. `get`, `cancel`, and `update` take the same four steps and
send one request instead of looping.

The official TypeScript and Python SDKs reject `resultType: "task"` today, so
TaskDock speaks raw JSON-RPC instead of using them.
See [docs/PROTOCOL_NOTES.md](docs/PROTOCOL_NOTES.md).

## Security

Treat the registry file like a list of bearer tokens.

The spec tells servers to mint task IDs with enough entropy to act as bearer
credentials, and some do exactly that. TaskDock stores those handles in
plaintext SQLite. It chmods the file to `0600` where the platform allows it,
which is the only protection there is. Anyone who reads the file can poll,
cancel, or update your tasks.

`taskdock list` abbreviates handles in human output for this reason.
`taskdock show`, `taskdock get`, and `--json` print the full handle. Pipe JSON
carefully. Keep it out of logs, pastebins, and terminal recordings.

Credentials are the one thing TaskDock will not store. A server profile holds
`env:TASKDOCK_AUTH_TOKEN`, the variable name, and resolves it from the
environment at call time. Fingerprints and stored transport details are
stripped of URL userinfo before they are written. Losing the SQLite file leaks
your task handles. It does not leak your tokens.

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
- [docs/SERVER_IDENTITY.md](docs/SERVER_IDENTITY.md) is the fingerprint
  decision and what it does not prove.
- [docs/CLIENT_COMPATIBILITY.md](docs/CLIENT_COMPATIBILITY.md) is the host and
  gateway survey.

## Limitations

**Nothing you did not register.** There is no `tasks/list` to fall back on. If
a handle never reached the registry, TaskDock cannot go looking for it.

**Session-bound servers cannot be resumed.** If a server keys tasks to the
connection that created them, a new connection gets "task not found" and
TaskDock can do nothing about it. The 2026-07-28 spec says servers should not
work that way. Some gateways still do. This is the one failure mode that breaks
the whole premise, so check it early against your server.

**HTTP only.** `server add --stdio` stores a profile, but the transport layer
implements Streamable HTTP. Resume over stdio is not wired up.

**No daemon, no sync, no notifications.** Polling happens when you run a
command. One SQLite file on one machine, single user. Copying the file (plus
its WAL) to another machine works and is tested, but nothing reconciles two
copies.

**Client A is the bottleneck.** No major coding agent emits a modern Tasks
handle as of 2026-08-31. `taskdock ingest` is the hook sink for when they
do. Until then, `register` and the fixture are Client A. See
[docs/INGESTION.md](docs/INGESTION.md).

**License.** MIT. See [LICENSE](LICENSE).

## Development

```bash
npm install
npm test          # registry, MCP resume, control commands, header encoding
npm run typecheck
npm run demo      # scripted end-to-end handoff
npm run experiments
npm run interop   # needs the rmcp container running
```

Layout:

- `src/registry/` SQLite schema and repository
- `src/mcp/` JSON-RPC transport, Tasks calls, `_meta` and header encoding
- `src/server-profiles/` profile parsing and fingerprints
- `src/ingest/` CreateTaskResult parser and hook sink
- `src/clients/` the Client A and Client B demo processes
- `src/cli.ts` command surface, `src/taskdock.ts` library API
- `fixtures/test-task-server/` controlled Tasks server, including the
  session-bound Mode B contrast
- `examples/rmcp-task-server/` Docker wrapper around the official `rmcp`
  TaskDemo

Run `npx tsx src/cli.ts ...` to use the CLI from a checkout without installing.
