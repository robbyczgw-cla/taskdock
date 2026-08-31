export { TaskDock } from "./taskdock.js";
export { defaultDbPath } from "./registry/db.js";
export {
  connect,
  callToolTask,
  cancelTask,
  getTask,
  pollUntilTerminal,
  updateTask,
  discover,
  identityWarning,
} from "./mcp/client.js";
export { McpRpcError } from "./mcp/transport.js";
export {
  TaskDockError,
  AuthEnvMissingError,
  ServerUnavailableError,
  TaskNotFoundError,
  TaskExpiredError,
  TasksNotSupportedError,
  ServerConfigRemovedError,
} from "./mcp/errors.js";
export { serverFingerprint } from "./server-profiles/fingerprint.js";
export type { ObservedNativeTask, TaskIngestor } from "./ingest/types.js";
export { toRegisterInput } from "./ingest/types.js";
export type {
  TaskRecord,
  ServerProfile,
  TaskRef,
  RegisterTaskInput,
  McpTask,
  Transport,
} from "./types.js";
