# TaskDock

TaskDock is an experimental durable registry for MCP Tasks.

This repository currently exists to test whether tasks from
`io.modelcontextprotocol/tasks` can be discovered and resumed across
MCP clients and process restarts.

It is a spike, not a product.

## Question

Can an MCP task created or observed by Client A be durably registered
outside that client, then discovered and resumed by Client B after
Client A has exited, without relying on `tasks/list`, in-memory state,
or a proprietary Client-A session store?

## Verdict

**BUILD.** Keep the local CLI. Do not grow it into a product. Evidence: [docs/SPIKE_RESULTS.md](docs/SPIKE_RESULTS.md).

On a Tasks server that keeps handles outside the MCP connection,
Client B resumes Client A's task from SQLite alone. TaskDock does not
run the work. Production coding agents do not speak this extension yet.

## Quick start

```bash
npm install
npm test
npm run demo
npm run experiments
```

Manual three-terminal demo:

```bash
# terminal 1
npm run fixture-server

# terminal 2
npm run client-a

# terminal 3 (after client-a exits)
npm run client-b -- td_01
```

`client-b` opens a **new** MCP connection and calls `tasks/get` with
the stored handle. TaskDock does not proxy the task.

```bash
npm run taskdock -- server add demo --http http://127.0.0.1:3333/mcp
npm run taskdock -- register --server demo --task <handle> --source-client client-a
npm run taskdock -- list
npm run taskdock -- resume td_01
```

There is no installed `taskdock` binary. Use `npm run taskdock -- ...` or `npx tsx src/cli.ts ...`. `td_01` is the first id on a fresh registry file.

## Layout

- `src/` — registry, MCP JSON-RPC client, CLI, library API
- `fixtures/test-task-server/` — controlled Tasks-extension server
- `docs/SPIKE_RESULTS.md` — verdict and experiment evidence

## Docs

- [Spike results](docs/SPIKE_RESULTS.md)
- [Protocol notes](docs/PROTOCOL_NOTES.md)
- [Client compatibility](docs/CLIENT_COMPATIBILITY.md)
