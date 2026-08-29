import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  tasksCapabilityHeaders,
} from "../src/mcp/meta.ts";

test("Mcp header encoding follows 2026-07-28 sentinel rules", () => {
  assert.equal(encodeMcpHeaderValue("us-west1"), "us-west1");
  assert.equal(
    encodeMcpHeaderValue("Hello, 世界"),
    "=?base64?SGVsbG8sIOS4lueVjA==?=",
  );
  assert.equal(encodeMcpHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
  assert.equal(encodeMcpHeaderValue("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
  assert.equal(
    encodeMcpHeaderValue("=?base64?literal?="),
    "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=",
  );
  assert.equal(decodeMcpHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?="), "Hello, 世界");
  assert.equal(decodeMcpHeaderValue("slow_echo"), "slow_echo");
});

test("tasks/get always sets encoded Mcp-Name", () => {
  const ascii = tasksCapabilityHeaders("tasks/get", { taskId: "task_abc" });
  assert.equal(ascii["Mcp-Name"], "task_abc");
  const unicode = tasksCapabilityHeaders("tasks/get", { taskId: "任务-äöü" });
  assert.ok(unicode["Mcp-Name"]?.startsWith("=?base64?"));
  assert.equal(decodeMcpHeaderValue(unicode["Mcp-Name"]!), "任务-äöü");
});
