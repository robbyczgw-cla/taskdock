import { test } from "node:test";
import assert from "node:assert/strict";
import { McpRpcError } from "../src/mcp/transport.ts";
import {
  classifyControlError,
  TaskDockError,
  TaskExpiredError,
  TaskNotFoundError,
  TasksNotSupportedError,
} from "../src/mcp/errors.ts";

test("-32602 is not TaskNotFoundError without task-not-found evidence", () => {
  const err = new McpRpcError(-32602, "Invalid params: inputResponses");
  const classified = classifyControlError(err, "abc", "demo");
  assert.equal(classified.name, "TaskDockError");
  assert.equal(classified instanceof TaskNotFoundError, false);
  assert.equal(classified instanceof TaskDockError, true);
});

test("-32602 taskId is required is not TaskNotFoundError", () => {
  const err = new McpRpcError(-32602, "taskId is required");
  const classified = classifyControlError(err, "abc", "demo");
  assert.equal(classified instanceof TaskNotFoundError, false);
});

test("-32602 Task not found is TaskNotFoundError", () => {
  const err = new McpRpcError(
    -32602,
    "Failed to retrieve task: Task not found",
  );
  assert.ok(classifyControlError(err, "abc", "demo") instanceof TaskNotFoundError);
});

test("-32602 Task has expired is TaskExpiredError", () => {
  const err = new McpRpcError(
    -32602,
    "Failed to retrieve task: Task has expired",
  );
  assert.ok(classifyControlError(err, "abc", "demo") instanceof TaskExpiredError);
});

test("-32601 is TasksNotSupportedError", () => {
  const err = new McpRpcError(-32601, "Method not found: tasks/get");
  assert.ok(
    classifyControlError(err, "abc", "demo") instanceof TasksNotSupportedError,
  );
});
