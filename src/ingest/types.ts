import type { RegisterTaskInput } from "../types.js";

/**
 * A native MCP task observed by some source (CLI, later a client hook).
 * TaskDock ID is assigned at register time; nativeTaskId stays server-owned.
 */
export type ObservedNativeTask = {
  serverProfileId: string;
  nativeTaskId: string;
  sourceClient?: string;
  label?: string;
  status?: string;
  ttlMs?: number | null;
  protocolVersion?: string;
  taskExtensionVersion?: string;
  metadata?: Record<string, unknown>;
};

/**
 * How TaskDock learns native task handles.
 * This slice ships explicit CLI registration. Client-specific observers
 * (Claude Code, Codex, Cursor, …) should implement this later instead of
 * special-casing those hosts in the registry.
 */
export interface TaskIngestor {
  readonly id: string;
  observe(): Promise<ObservedNativeTask[]>;
}

export function toRegisterInput(observed: ObservedNativeTask): RegisterTaskInput {
  return {
    serverProfileId: observed.serverProfileId,
    taskHandle: observed.nativeTaskId,
    sourceClient: observed.sourceClient,
    label: observed.label,
    status: observed.status,
    protocolVersion: observed.protocolVersion,
    taskExtensionVersion: observed.taskExtensionVersion,
    ttlMs: observed.ttlMs ?? undefined,
    metadata: observed.metadata,
  };
}
