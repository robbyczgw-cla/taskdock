export class TaskDockError extends Error {
  readonly retained = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TaskDockError";
  }
}

export class AuthEnvMissingError extends TaskDockError {
  constructor(public readonly envVar: string) {
    super(
      `Auth environment variable ${envVar} is not set. TaskDock does not store credential values.`,
    );
    this.name = "AuthEnvMissingError";
  }
}

export class ServerUnavailableError extends TaskDockError {
  constructor(public readonly endpoint: string, cause?: unknown) {
    super(`MCP server unavailable at ${endpoint}`, { cause });
    this.name = "ServerUnavailableError";
  }
}

export class TaskNotFoundError extends TaskDockError {
  constructor(public readonly nativeTaskId: string) {
    super(`Native task not found: ${nativeTaskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskExpiredError extends TaskDockError {
  constructor(public readonly nativeTaskId: string) {
    super(`Native task expired: ${nativeTaskId}`);
    this.name = "TaskExpiredError";
  }
}

export class TasksNotSupportedError extends TaskDockError {
  constructor(public readonly serverId: string) {
    super(
      `Server ${serverId} does not advertise io.modelcontextprotocol/tasks`,
    );
    this.name = "TasksNotSupportedError";
  }
}

export class ServerConfigRemovedError extends TaskDockError {
  constructor(
    public readonly taskDockId: string,
    public readonly serverId: string,
  ) {
    super(
      `Task ${taskDockId} references missing server profile ${serverId}`,
    );
    this.name = "ServerConfigRemovedError";
  }
}

function rpcCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

export function classifyControlError(
  err: unknown,
  nativeTaskId: string,
  serverId: string,
): TaskDockError {
  if (err instanceof TaskDockError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const msg = message.toLowerCase();
  const code = rpcCode(err);
  const isRpc = err instanceof Error && err.name === "McpRpcError";
  if (isRpc || code !== undefined) {
    if (code === -32601 || msg.includes("method not found")) {
      return new TasksNotSupportedError(serverId);
    }
    if (code === -32021 || msg.includes("missing required client capability")) {
      return new TasksNotSupportedError(serverId);
    }
    if (msg.includes("expired")) {
      return new TaskExpiredError(nativeTaskId);
    }
    if (code === -32602 || msg.includes("not found")) {
      return new TaskNotFoundError(nativeTaskId);
    }
    return new TaskDockError(message, { cause: err });
  }
  return new TaskDockError(message, { cause: err });
}
