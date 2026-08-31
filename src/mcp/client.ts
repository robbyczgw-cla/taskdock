import type { ServerProfile } from "../types.js";
import { discover } from "./transport.js";
import { TASKS_EXTENSION, type ClientIdentity } from "./meta.js";
import { TasksNotSupportedError } from "./errors.js";
import {
  callToolTask,
  cancelTask,
  getTask,
  pollUntilTerminal,
  updateTask,
} from "./tasks.js";

export type ConnectedClient = {
  profile: ServerProfile;
  client: ClientIdentity;
  serverInfo?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
};

/**
 * Fresh MCP connection: HTTP POST per call, no session handshake.
 * 2026-07-28 has no initialize / Mcp-Session-Id.
 */
export function extractServerInfo(payload: object): Record<string, unknown> {
  const discovered = payload as Record<string, unknown>;
  const meta = discovered._meta as Record<string, unknown> | undefined;
  const fromMeta = meta?.["io.modelcontextprotocol/serverInfo"];
  if (fromMeta && typeof fromMeta === "object") {
    return fromMeta as Record<string, unknown>;
  }
  if (discovered.serverInfo && typeof discovered.serverInfo === "object") {
    return discovered.serverInfo as Record<string, unknown>;
  }
  return {};
}

export function identityWarning(
  recorded: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
): string | undefined {
  if (!recorded) return undefined;
  const recName = recorded.name;
  const curName = current.name;
  const recVer = recorded.version;
  const curVer = current.version;
  if (
    (typeof recName === "string" && typeof curName === "string" && recName !== curName) ||
    (typeof recVer === "string" && typeof curVer === "string" && recVer !== curVer)
  ) {
    return [
      "warning: server identity differs from the server observed when this task was registered",
      `recorded: ${recName ?? "?"} ${recVer ?? ""}`.trimEnd(),
      `current:  ${curName ?? "?"} ${curVer ?? ""}`.trimEnd(),
    ].join("\n");
  }
  return undefined;
}

export function tasksExtensionAdvertised(
  capabilities: Record<string, unknown> | undefined,
): boolean {
  const extensions = capabilities?.extensions;
  if (!extensions || typeof extensions !== "object") return false;
  return TASKS_EXTENSION in (extensions as Record<string, unknown>);
}

export async function connect(
  profile: ServerProfile,
  client: ClientIdentity,
  extras?: { authToken?: string },
): Promise<ConnectedClient> {
  const discovered = await discover(profile, { client, ...extras });
  const capabilities = discovered.capabilities as Record<string, unknown> | undefined;
  if (!tasksExtensionAdvertised(capabilities)) {
    throw new TasksNotSupportedError(profile.id);
  }
  return {
    profile,
    client,
    serverInfo: extractServerInfo(discovered),
    capabilities,
  };
}

export {
  callToolTask,
  cancelTask,
  getTask,
  pollUntilTerminal,
  updateTask,
  discover,
};
