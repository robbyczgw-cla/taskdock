#!/bin/sh
# One-shot post-tool hook. Never fail the originating client.
# Set TASKDOCK_SERVER to an existing TaskDock server profile id.
#
# Example (Claude Code PostToolUse command hook, if the tool_response is a
# CreateTaskResult):
#   "command": "examples/ingest-hook.sh"
#
# Exit 0 even when TaskDock is missing or ingest rejects the payload.

set -eu
if ! command -v taskdock >/dev/null 2>&1 && [ -z "${TASKDOCK_BIN:-}" ]; then
  exit 0
fi
BIN="${TASKDOCK_BIN:-taskdock}"
SERVER="${TASKDOCK_SERVER:-}"
SOURCE="${TASKDOCK_SOURCE_CLIENT:-hook}"
if [ -z "$SERVER" ]; then
  exit 0
fi
"$BIN" ingest --server "$SERVER" --source-client "$SOURCE" --stdin --json >/dev/null 2>&1 || true
exit 0
