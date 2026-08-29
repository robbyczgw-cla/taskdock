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
export async function connect(
  profile: ServerProfile,
  client: ClientIdentity,
  extras?: { authToken?: string },
): Promise<ConnectedClient> {
  const discovered = await discover(profile, { client, ...extras });
  return {
    profile,
    client,
    serverInfo: (discovered.serverInfo as Record<string, unknown> | undefined) ??
      discovered,
    capabilities: discovered.capabilities as Record<string, unknown> | undefined,
  };
}

export { callToolTask, getTask, pollUntilTerminal, discover };
