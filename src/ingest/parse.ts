import { PROTOCOL_VERSION, TASKS_EXTENSION_VERSION } from "../mcp/meta.js";
import { extractServerInfo } from "../mcp/client.js";
import { pickSafeMetadata } from "./metadata.js";
import type { ObservedNativeTask } from "./types.js";

export type IngestContext = {
  serverProfileId: string;
  sourceClient?: string;
  label?: string;
};

export type ParsedObservation =
  | { kind: "task"; observed: ObservedNativeTask }
  | { kind: "ignored" }
  | { kind: "invalid"; message: string };

function extractCreateTaskResult(
  obj: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (obj.resultType === "task") return obj;
  const result = obj.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const inner = result as Record<string, unknown>;
    if (inner.resultType === "task") return inner;
  }
  return undefined;
}

/**
 * Canonical MCP CreateTaskResult, or a JSON-RPC envelope whose result is one.
 * Ordinary tool results return `ignored`. resultType=task without a taskId is invalid.
 */
export function parseObservedTask(
  input: unknown,
  context: IngestContext,
): ParsedObservation {
  if (input === undefined || input === null) return { kind: "ignored" };
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return { kind: "ignored" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: "invalid", message: "ingest payload is not JSON" };
    }
    return parseObservedTask(parsed, context);
  }
  if (typeof input !== "object" || Array.isArray(input)) return { kind: "ignored" };

  const candidate = extractCreateTaskResult(input as Record<string, unknown>);
  if (!candidate) return { kind: "ignored" };

  const taskId = candidate.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return {
      kind: "invalid",
      message: "CreateTaskResult is missing a native taskId",
    };
  }
  if (!context.serverProfileId) {
    return { kind: "invalid", message: "server profile is required" };
  }

  const ttlMs =
    typeof candidate.ttlMs === "number" || candidate.ttlMs === null
      ? candidate.ttlMs
      : undefined;
  const status = typeof candidate.status === "string" ? candidate.status : undefined;
  const serverInfo = extractServerInfo(candidate);

  return {
    kind: "task",
    observed: {
      serverProfileId: context.serverProfileId,
      nativeTaskId: taskId,
      sourceClient: context.sourceClient,
      label: context.label,
      status,
      ttlMs,
      protocolVersion: PROTOCOL_VERSION,
      taskExtensionVersion: TASKS_EXTENSION_VERSION,
      metadata: pickSafeMetadata(
        Object.keys(serverInfo).length > 0 ? { serverInfo } : undefined,
      ),
    },
  };
}
