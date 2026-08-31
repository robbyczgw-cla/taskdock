# Changelog

## Unreleased

## 0.2.0 — 2026-08-31

Durable native MCP task continuity plus automatic capture plumbing.

Capture a native task handle once. Resume and control it from any later
session. TaskDock still does not keep the task alive. The MCP server does.

### Added

- `taskdock get <id>`: live native `tasks/get` on a fresh connection. `poll`
  is an alias.
- `taskdock cancel <id>`: native `tasks/cancel`, then a follow-up `tasks/get`.
- `taskdock update <id> --input-responses <json>`: native `tasks/update`, then
  a follow-up `tasks/get`.
- `taskdock ingest`: one-shot hook sink (`--stdin` or `--payload`). Ordinary
  tool results are ignored (exit 0). `--strict` turns that into an error.
  See [docs/INGESTION.md](docs/INGESTION.md).
- `TaskDock.ingest()` and `parseObservedTask()` for plugins. Ingest stores
  only safe identity fields. `register()` still persists caller-supplied
  `metadata`.
- `list --server` and `--status`.
- `register --task-id` (`--task` still works).
- Server fingerprint of canonical endpoint plus `env:VAR`. See
  [docs/SERVER_IDENTITY.md](docs/SERVER_IDENTITY.md).
- Fail-open hook wrapper: `examples/ingest-hook.sh`.

### Changed

- `show` is the cached registry row. `get` talks to the server.
- `resume` on `input_required` points at `update`.
- `get` / `cancel` / `update` send only the native Tasks method
  (`Mcp-Name` = native `taskId`). They do not call `server/discover` first.
- Missing `env:VAR` fails before the request. URL userinfo is stripped.

### Fixed

- Re-adding a server with a different endpoint is rejected while tasks still
  reference it.
- After a successful cancel/update ack, a failed follow-up `tasks/get` is
  kept in `last_error`. The row is not treated as freshly observed.
- `-32602` is Invalid Params. `TaskNotFoundError` only when the server says
  the task does not exist.
- Opening a v0.1.0 database strips stored URL userinfo and drops auth values
  that are not `env:VAR`.
- `Registry.addServer` rejects literal auth.

## 0.1.0 — 2026-08-30

First release. Local SQLite index for MCP Tasks (`io.modelcontextprotocol/tasks`,
2026-07-28).

- Commands: `server add|list|show|remove`, `register`, `list`, `show`, `poll`,
  `resume`.
- `--auth` stores `env:VAR` only.
- Resume proven against `rmcp` 3.1.4 (`slow_sum` 2+40 → 42).
- MIT License. npm package `taskdock`.
