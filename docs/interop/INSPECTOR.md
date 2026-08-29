# Experiment J — MCP Inspector as Client A

Manual. Do not automate the Inspector UI.

## Server

```bash
npm run interop:server
```

Wait until `http://127.0.0.1:8000/health` returns ok.

## Inspector

Use MCP Inspector against `http://127.0.0.1:8000/mcp` (Streamable HTTP, protocol 2026-07-28).

1. Confirm the server advertises `io.modelcontextprotocol/tasks`.
2. Call tool `slow_sum` with `{ "a": 2, "b": 40 }`.
3. If Inspector surfaces a `taskId` / `resultType: "task"`, copy it.

```bash
npx tsx src/cli.ts server add rmcp --http http://127.0.0.1:8000/mcp
npx tsx src/cli.ts register --server rmcp --task '<taskId>' --source-client inspector
# close Inspector
npx tsx src/cli.ts resume <td_id>
```

If Inspector swallows the handle and only shows a final `42`, it cannot act as Client A for TaskDock. Record that as NOT POSSIBLE, not as a TaskDock failure.
