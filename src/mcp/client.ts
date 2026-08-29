import type { ServerProfile } from "../types.ts";
import { discover } from "./transport.ts";
import type { ClientIdentity } from "./meta.ts";
import { callToolTask, getTask, pollUntilTerminal } from "./tasks.ts";

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
export function extractServerInfo(
  discovered: Record<string, unknown>,
): Record<string, unknown> {
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
    return `WARNING: server identity differs from the server that created this task (recorded ${JSON.stringify(recorded)} vs current ${JSON.stringify(current)})`;
  }
  return undefined;
}

export async function connect(
  profile: ServerProfile,
  client: ClientIdentity,
  extras?: { authToken?: string },
): Promise<ConnectedClient> {
  const discovered = await discover(profile, { client, ...extras });
  return {
    profile,
    client,
    serverInfo: extractServerInfo(discovered),
    capabilities: discovered.capabilities as Record<string, unknown> | undefined,
  };
}

export {
  callToolTask,
  getTask,
  pollUntilTerminal,
  discover,
};
