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
      version: client.version ?? "0.2.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: {
        [TASKS_EXTENSION]: {},
      },
    },
  };
}

/**
 * Streamable HTTP value encoding (2026-07-28).
 * Unsafe values use =?base64?{utf8-base64}?=
 */
const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";

export function isPlainMcpHeaderValue(value: string): boolean {
  if (
    value.startsWith(BASE64_SENTINEL_PREFIX) &&
    value.endsWith(BASE64_SENTINEL_SUFFIX)
  ) {
    return false;
  }
  if (value !== value.trim()) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x09 || c === 0x20 || (c >= 0x21 && c <= 0x7e)) continue;
    return false;
  }
  return true;
}

export function encodeMcpHeaderValue(value: string): string {
  if (isPlainMcpHeaderValue(value)) return value;
  return `${BASE64_SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SENTINEL_SUFFIX}`;
}

export function decodeMcpHeaderValue(value: string): string {
  if (
    value.startsWith(BASE64_SENTINEL_PREFIX) &&
    value.endsWith(BASE64_SENTINEL_SUFFIX)
  ) {
    const b64 = value.slice(
      BASE64_SENTINEL_PREFIX.length,
      value.length - BASE64_SENTINEL_SUFFIX.length,
    );
    return Buffer.from(b64, "base64").toString("utf8");
  }
  return value;
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
    headers["Mcp-Name"] = encodeMcpHeaderValue(params.name);
  }
  if (method.startsWith("tasks/") && typeof params?.taskId === "string") {
    headers["Mcp-Name"] = encodeMcpHeaderValue(params.taskId);
  }
  return headers;
}
