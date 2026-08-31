import type { RegisterTaskInput, TaskRecord } from "../types.js";

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
 * CLI `ingest` and `register` are the shipped sources. Client observers
 * should implement this rather than special-casing hosts in the registry.
 */
export interface TaskIngestor {
  readonly id: string;
  observe(): Promise<ObservedNativeTask[]>;
}

export type IngestResult = {
  record: TaskRecord;
  created: boolean;
};

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
