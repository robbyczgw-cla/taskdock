# Changelog

## Unreleased

Not on npm. v0.1.0 remains the published package.

### Added

- `taskdock get <id>` runs a live native `tasks/get` on a fresh connection.
  `poll` is an alias.
- `taskdock cancel <id>` routes native `tasks/cancel`.
- `taskdock update <id> --input-responses <json>` routes native `tasks/update`.
- `taskdock list --server <id>` and `--status <status>`.
- `register --task-id` ( `--task` still works).
- Server fingerprint: SHA-256 of the canonical HTTP/stdio endpoint plus
  `env:VAR`, never a secret or display name. See
  [docs/SERVER_IDENTITY.md](docs/SERVER_IDENTITY.md).
- Generic ingest interface in `src/ingest/` for later client observers.
  Registration is still an explicit CLI call.
- Schema migration for `fingerprint`, `ttl_ms`, and `last_error`. Existing
  databases open and backfill fingerprints.

### Changed

- `show` is the cached registry row. `get` talks to the server.
- `resume` on `input_required` points at `update`.
- CLI register may probe `server/discover` once. `get` / `cancel` / `update`
  send only the native Tasks method (`Mcp-Name` = native `taskId`). Identity
  is compared from a stored baseline or from `_meta` on `tasks/get`.
- Missing `env:VAR` fails before the request. URL userinfo is stripped before
  storage.

### Fixed

- Re-adding a server profile with a different endpoint is rejected while tasks
  still reference it. Old handles cannot be silently pointed at a new URL.
- After a successful `cancel` or `update` ack, a failed follow-up `tasks/get`
  is recorded in `last_error`. The ack is kept. The row is not treated as
  freshly observed.
- Re-registering a known handle no longer clears `last_error`.
- `docs/_*` scratch files are gitignored.
- Native `get` / `cancel` / `update` no longer call `server/discover` first.
- JSON-RPC `-32602` is Invalid Params. It is `TaskNotFoundError` only when
  the server says the task does not exist.
- Opening a v0.1.0 database strips URL userinfo from stored server
  transports and drops auth values that are not `env:VAR`.
- `Registry.addServer` rejects literal auth the same way the CLI does.

## 0.1.0 — 2026-08-30

First release. Local SQLite index for MCP Tasks (`io.modelcontextprotocol/tasks`,
2026-07-28).

- Commands: `server add|list|show|remove`, `register`, `list`, `show`, `poll`,
  `resume`.
- `--auth` stores `env:VAR` only.
- Resume proven against `rmcp` 3.1.4 (`slow_sum` 2+40 → 42).
- MIT License. npm package `taskdock`.
