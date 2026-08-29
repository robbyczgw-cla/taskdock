export const PROTOCOL_VERSION = "2026-07-28";
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const TASKS_EXTENSION_VERSION = "2026-07-28";

export type ClientIdentity = {
  name: string;
  version?: string;
};

export function requestMeta(client: ClientIdentity): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: client.name,
      version: client.version ?? "0.1.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: {
        [TASKS_EXTENSION]: {},
      },
    },
  };
}

export function tasksCapabilityHeaders(
  method: string,
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Mcp-Method": method,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (method === "tools/call" && typeof params?.name === "string") {
    headers["Mcp-Name"] = params.name;
  }
  if (method.startsWith("tasks/") && typeof params?.taskId === "string") {
    headers["Mcp-Name"] = params.taskId;
  }
  return headers;
}
