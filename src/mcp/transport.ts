import type { JsonRpcResponse, ServerProfile } from "../types.ts";
import { requestMeta, tasksCapabilityHeaders, type ClientIdentity } from "./meta.ts";

export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

let nextId = 1;

export type McpCallOptions = {
  client: ClientIdentity;
  authToken?: string;
  extraHeaders?: Record<string, string>;
};

function resolveAuthToken(profile: ServerProfile): string | undefined {
  const ref = profile.authProfile;
  if (!ref || ref === "none") return undefined;
  if (ref.startsWith("env:")) {
    const name = ref.slice(4);
    return process.env[name];
  }
  return undefined;
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text) return undefined;

  if (contentType.includes("text/event-stream")) {
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    const last = dataLines.at(-1);
    if (!last) throw new Error("empty SSE response from MCP server");
    return JSON.parse(last);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON MCP response (${res.status}): ${text.slice(0, 400)}`);
  }
}

export async function mcpCall<T = unknown>(
  profile: ServerProfile,
  method: string,
  params: Record<string, unknown> = {},
  options: McpCallOptions,
): Promise<{ result: T; raw: JsonRpcResponse<T>; httpStatus: number }> {
  if (profile.transport.type !== "http") {
    throw new Error(
      `Spike MCP client only implements HTTP transport (got ${profile.transport.type})`,
    );
  }

  const body = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: requestMeta(options.client),
    },
  };

  const headers: Record<string, string> = {
    ...tasksCapabilityHeaders(method, params),
    ...options.extraHeaders,
  };

  const token = options.authToken ?? resolveAuthToken(profile);
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(profile.transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const parsed = (await parseBody(res)) as JsonRpcResponse<T> | undefined;
  if (!parsed) {
    throw new Error(`empty response from ${profile.transport.url} (${res.status})`);
  }
  if (parsed.error) {
    throw new McpRpcError(
      parsed.error.code,
      parsed.error.message,
      parsed.error.data,
      parsed,
    );
  }
  if (parsed.result === undefined) {
    throw new Error(`MCP response missing result for ${method}`);
  }
  return { result: parsed.result, raw: parsed, httpStatus: res.status };
}

export async function discover(
  profile: ServerProfile,
  options: McpCallOptions,
): Promise<Record<string, unknown>> {
  const { result } = await mcpCall<Record<string, unknown>>(
    profile,
    "server/discover",
    {},
    options,
  );
  return result;
}
