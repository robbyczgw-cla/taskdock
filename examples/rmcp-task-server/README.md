# rmcp TaskDemo (third-party)

Thin HTTP wrapper around the official Rust MCP SDK (`rmcp` 3.1) Tasks example.

Task lifecycle is implemented by `rmcp::task_manager::TaskManager`, not TaskDock.

```bash
docker compose -f examples/rmcp-task-server/docker-compose.yml up --build
```

Tool: `slow_sum` with `{ "a": 2, "b": 40 }` returns `resultType: "task"`.
