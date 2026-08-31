/** Wire and registry types for the TaskDock spike. */

export type HttpTransport = {
  type: "http";
  url: string;
};

export type StdioTransport = {
  type: "stdio";
  command: string;
  args?: string[];
};

export type Transport = HttpTransport | StdioTransport;

export type ServerProfile = {
  id: string;
  name: string;
  transport: Transport;
  /**
   * Reference to an external auth mechanism, not a secret.
   * Only `env:VAR` is stored. Literal credentials are rejected.
   */
  authProfile?: string;
  /** SHA-256 of canonical non-secret transport + auth reference. */
  fingerprint?: string;
};

export type TaskRecord = {
  id: string;
  /** Opaque MCP taskId. Never parsed. */
  taskHandle: string;
  serverProfileId: string;
  protocolVersion?: string;
  taskExtensionVersion?: string;
  createdAt: string;
  lastSeenAt: string;
  status?: string;
  sourceClient?: string;
  label?: string;
  ttlMs?: number | null;
  lastError?: string;
  metadata?: Record<string, unknown>;
};

export type RegisterTaskInput = {
  serverProfileId: string;
  taskHandle: string;
  sourceClient?: string;
  label?: string;
  status?: string;
  protocolVersion?: string;
  taskExtensionVersion?: string;
  ttlMs?: number | null;
  metadata?: Record<string, unknown>;
};

export type TaskRef = {
  id: string;
  taskHandle: string;
  serverProfile: ServerProfile;
  record: TaskRecord;
};

export type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export type McpTask = {
  resultType?: string;
  taskId: string;
  status: TaskStatus | string;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  inputRequests?: Record<string, unknown>;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: JsonRpcError;
};
