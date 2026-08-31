/**
 * Controlled MCP Tasks fixture (io.modelcontextprotocol/tasks).
 *
 * Mode A (default): TASK_BINDING=independent
 *   Task state lives in SQLite keyed only by taskId.
 *   A new HTTP connection can tasks/get the same handle.
 *
 * Mode B: TASK_BINDING=session
 *   Task state is keyed by (session, taskId).
 *   The session is the X-Fixture-Session header minted at create time.
 *   A new client without that header cannot resume.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { TaskStore, type FixtureMode, type StoredTask } from "./store.ts";

const PORT = Number(process.env.TASKDOCK_FIXTURE_PORT ?? 3333);
const BINDING = (process.env.TASK_BINDING ?? "independent") as FixtureMode;
const DB_PATH =
  process.env.TASKDOCK_FIXTURE_DB ??
  join(process.cwd(), "data", `fixture-${BINDING}.sqlite`);
const AUTH_TOKEN = process.env.TASKDOCK_FIXTURE_TOKEN;
const SERVER_NAME = process.env.TASKDOCK_FIXTURE_NAME ?? "taskdock-fixture";
const INSTANCE_ID =
  process.env.TASKDOCK_FIXTURE_INSTANCE ?? `inst_${randomBytes(4).toString("hex")}`;

const store = new TaskStore(DB_PATH, BINDING, AUTH_TOKEN);
const vanishOnAck = new Set<string>();
const expireOnAck = new Set<string>();

const TOOLS = [
  {
    name: "slow_echo",
    description: "Echo a message after delayMs, returning a Tasks handle.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        delayMs: { type: "number" },
        handle: { type: "string", description: "Optional explicit opaque taskId" },
        ttlMs: { type: "number" },
      },
      required: ["message"],
    },
  },
  {
    name: "needs_input",
    description: "Create a task that waits for tasks/update input.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        handle: { type: "string" },
      },
    },
  },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    ...extraHeaders,
  });
  res.end(body);
}

function jsonrpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function jsonrpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function clientHasTasks(params: Record<string, unknown> | undefined): boolean {
  const meta = params?._meta as Record<string, unknown> | undefined;
  const caps = meta?.["io.modelcontextprotocol/clientCapabilities"] as
    | Record<string, unknown>
    | undefined;
  const extensions = caps?.extensions as Record<string, unknown> | undefined;
  return Boolean(extensions?.["io.modelcontextprotocol/tasks"]);
}

function serverMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/serverInfo": {
      name: SERVER_NAME,
      version: "0.1.0",
      instanceId: INSTANCE_ID,
    },
  };
}

function taskView(task: StoredTask) {
  const base = {
    resultType: "complete" as const,
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    _meta: serverMeta(),
  };
  if (task.status === "input_required" && task.inputRequestsJson) {
    return {
      ...base,
      inputRequests: JSON.parse(task.inputRequestsJson) as Record<string, unknown>,
    };
  }
  if (task.status === "completed" && task.resultJson) {
    return { ...base, result: JSON.parse(task.resultJson) };
  }
  if (task.status === "failed" && task.errorJson) {
    return { ...base, error: JSON.parse(task.errorJson) };
  }
  return base;
}

function createView(task: StoredTask) {
  return {
    resultType: "task" as const,
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    statusMessage:
      task.status === "input_required"
        ? "waiting for input"
        : `echoing after ${task.delayMs}ms`,
    _meta: serverMeta(),
    ...(task.inputRequestsJson
      ? { inputRequests: JSON.parse(task.inputRequestsJson) as Record<string, unknown> }
      : {}),
  };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

function decodeMcpHeader(value: string): string {
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    return Buffer.from(value.slice("=?base64?".length, -2), "base64").toString(
      "utf8",
    );
  }
  return value;
}

function headerMismatch(
  res: ServerResponse,
  id: unknown,
  message: string,
): void {
  send(res, 400, jsonrpcError(id, -32020, message));
}

function checkMirroredHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  id: unknown,
  method: string,
  params: Record<string, unknown>,
): boolean {
  const protocol = headerValue(req, "mcp-protocol-version");
  if (protocol !== "2026-07-28") {
    headerMismatch(
      res,
      id,
      `Header mismatch: MCP-Protocol-Version ${JSON.stringify(protocol)}`,
    );
    return false;
  }
  const mcpMethod = headerValue(req, "mcp-method");
  if (mcpMethod !== method) {
    headerMismatch(
      res,
      id,
      `Header mismatch: Mcp-Method ${JSON.stringify(mcpMethod)} !== ${JSON.stringify(method)}`,
    );
    return false;
  }
  if (method === "tools/call" || method.startsWith("tasks/")) {
    const rawName = headerValue(req, "mcp-name");
    if (rawName === undefined) {
      headerMismatch(res, id, "Header mismatch: Mcp-Name is required");
      return false;
    }
    const decoded = decodeMcpHeader(rawName);
    const expected =
      method === "tools/call"
        ? String(params.name ?? "")
        : String(params.taskId ?? "");
    if (decoded !== expected) {
      headerMismatch(
        res,
        id,
        `Header mismatch: Mcp-Name ${JSON.stringify(decoded)} !== ${JSON.stringify(expected)}`,
      );
      return false;
    }
  }
  return true;
}

function checkAuth(req: IncomingMessage): string | undefined {
  if (!AUTH_TOKEN) return undefined;
  const header = req.headers.authorization;
  if (header !== `Bearer ${AUTH_TOKEN}`) {
    return "unauthorized";
  }
  return undefined;
}

function sessionFor(req: IncomingMessage, creating: boolean): string | null {
  if (BINDING !== "session") return null;
  const existing = req.headers["x-fixture-session"];
  if (typeof existing === "string" && existing.length > 0) return existing;
  if (creating) return `sess_${randomBytes(8).toString("hex")}`;
  return null;
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  msg: {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  },
): Promise<void> {
  const id = msg.id ?? null;
  const method = msg.method ?? "";
  const params = msg.params ?? {};

  const authErr = checkAuth(req);
  if (authErr) {
    send(res, 401, jsonrpcError(id, -32001, "unauthorized"));
    return;
  }

  if (!checkMirroredHeaders(req, res, id, method, params)) {
    return;
  }

  if (method === "server/discover") {
    send(
      res,
      200,
      jsonrpcResult(id, {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: {
          tools: {},
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: "0.1.0",
          instanceId: INSTANCE_ID,
        },
        ttlMs: 0,
        cacheScope: "public",
        binding: BINDING,
        _meta: serverMeta(),
      }),
    );
    return;
  }

  if (method === "tools/list") {
    send(
      res,
      200,
      jsonrpcResult(id, {
        resultType: "complete",
        tools: TOOLS,
        ttlMs: 0,
        cacheScope: "public",
        _meta: serverMeta(),
      }),
    );
    return;
  }

  if (method === "tools/call") {
    if (!clientHasTasks(params)) {
      send(
        res,
        200,
        jsonrpcError(id, -32021, "Missing required client capability", {
          requiredCapabilities: {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        }),
      );
      return;
    }
    const name = params.name as string;
    const args = (params.arguments as Record<string, unknown>) ?? {};
    const sessionId = sessionFor(req, true);
    const handle = typeof args.handle === "string" ? args.handle : undefined;
    let task: StoredTask;
    if (name === "needs_input") {
      const prompt = String(args.prompt ?? "Provide a message.");
      task = store.create({
        taskId: handle,
        sessionId,
        message: prompt,
        delayMs: 0,
        ttlMs: 3_600_000,
        pollIntervalMs: 50,
        status: "input_required",
        inputRequests: {
          prompt: {
            method: "elicitation/create",
            params: { message: prompt },
          },
        },
      });
    } else if (name === "slow_echo") {
      const message = String(args.message ?? "");
      const delayMs = Number(args.delayMs ?? 1500);
      const ttlMs =
        args.ttlMs === undefined ? 3_600_000 : (args.ttlMs as number | null);
      task = store.create({
        taskId: handle,
        sessionId,
        message,
        delayMs,
        ttlMs,
        pollIntervalMs: Math.min(500, Math.max(50, Math.floor(delayMs / 5))),
      });
      if (args.vanishOnAck === true) vanishOnAck.add(task.taskId);
      if (args.expireOnAck === true) expireOnAck.add(task.taskId);
    } else {
      send(res, 200, jsonrpcError(id, -32601, `Unknown tool: ${name}`));
      return;
    }
    const extra: Record<string, string> = {};
    if (sessionId) extra["X-Fixture-Session"] = sessionId;
    send(res, 200, jsonrpcResult(id, createView(task)), extra);
    return;
  }

  if (method === "tasks/update") {
    if (!clientHasTasks(params)) {
      send(
        res,
        200,
        jsonrpcError(id, -32021, "Missing required client capability", {
          requiredCapabilities: {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        }),
      );
      return;
    }
    const taskId = params.taskId as string;
    if (!taskId) {
      send(res, 200, jsonrpcError(id, -32602, "taskId is required"));
      return;
    }
    const existing = store.getRaw(taskId);
    if (!existing) {
      send(
        res,
        200,
        jsonrpcError(id, -32602, "Failed to retrieve task: Task not found"),
      );
      return;
    }
    if (BINDING === "session") {
      const sess = sessionFor(req, false);
      if (!sess || sess !== existing.sessionId) {
        send(
          res,
          200,
          jsonrpcError(
            id,
            -32602,
            "Failed to retrieve task: Task not found in this session",
          ),
        );
        return;
      }
    }
    const materialized = store.materialize(taskId);
    if (materialized?.status === "expired") {
      send(
        res,
        200,
        jsonrpcError(id, -32602, "Failed to retrieve task: Task has expired"),
      );
      return;
    }
    const inputResponses =
      (params.inputResponses as Record<string, unknown> | undefined) ?? {};
    store.applyInput(taskId, inputResponses);
    send(res, 200, jsonrpcResult(id, { resultType: "complete" }));
    if (vanishOnAck.has(taskId)) store.delete(taskId);
    if (expireOnAck.has(taskId)) store.forceExpire(taskId);
    return;
  }

  if (method === "tasks/get" || method === "tasks/cancel") {
    if (!clientHasTasks(params)) {
      send(
        res,
        200,
        jsonrpcError(id, -32021, "Missing required client capability", {
          requiredCapabilities: {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        }),
      );
      return;
    }
    const taskId = params.taskId as string;
    if (!taskId) {
      send(res, 200, jsonrpcError(id, -32602, "taskId is required"));
      return;
    }

    if (method === "tasks/cancel") {
      const existing = store.getRaw(taskId);
      if (!existing) {
        send(
          res,
          200,
          jsonrpcError(id, -32602, "Failed to retrieve task: Task not found"),
        );
        return;
      }
      if (BINDING === "session") {
        const sess = sessionFor(req, false);
        if (!sess || sess !== existing.sessionId) {
          send(
            res,
            200,
            jsonrpcError(
              id,
              -32602,
              "Failed to retrieve task: Task not found in this session",
            ),
          );
          return;
        }
      }
      const materialized = store.materialize(taskId);
      if (materialized?.status === "expired") {
        send(
          res,
          200,
          jsonrpcError(id, -32602, "Failed to retrieve task: Task has expired"),
        );
        return;
      }
      store.cancel(taskId);
      send(res, 200, jsonrpcResult(id, { resultType: "complete" }));
      if (vanishOnAck.has(taskId)) store.delete(taskId);
      if (expireOnAck.has(taskId)) store.forceExpire(taskId);
      return;
    }

    const existing = store.getRaw(taskId);
    if (!existing) {
      send(
        res,
        200,
        jsonrpcError(id, -32602, "Failed to retrieve task: Task not found"),
      );
      return;
    }
    if (BINDING === "session") {
      const sess = sessionFor(req, false);
      if (!sess || sess !== existing.sessionId) {
        send(
          res,
          200,
          jsonrpcError(
            id,
            -32602,
            "Failed to retrieve task: Task not found in this session",
          ),
        );
        return;
      }
    }
    const task = store.materialize(taskId)!;
    if (task.status === "expired") {
      send(
        res,
        200,
        jsonrpcError(id, -32602, "Failed to retrieve task: Task has expired"),
      );
      return;
    }
    send(res, 200, jsonrpcResult(id, taskView(task)));
    return;
  }

  send(res, 200, jsonrpcError(id, -32601, `Method not found: ${method}`));
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, binding: BINDING, name: SERVER_NAME, instanceId: INSTANCE_ID });
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "POST only" });
    return;
  }

  try {
    const raw = await readBody(req);
    const msg = JSON.parse(raw) as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    await handleRpc(req, res, msg);
  } catch (err) {
    send(
      res,
      400,
      jsonrpcError(null, -32700, err instanceof Error ? err.message : "parse error"),
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `[fixture] ${SERVER_NAME} ${INSTANCE_ID} mode=${BINDING} http://127.0.0.1:${PORT}/mcp db=${DB_PATH}\n`,
  );
});

function shutdown(): void {
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
