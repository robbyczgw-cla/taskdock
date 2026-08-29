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
    statusMessage: `echoing after ${task.delayMs}ms`,
    _meta: serverMeta(),
  };
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

  if (method === "server/discover") {
    send(
      res,
      200,
      jsonrpcResult(id, {
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
    if (name !== "slow_echo") {
      send(res, 200, jsonrpcError(id, -32601, `Unknown tool: ${name}`));
      return;
    }
    const message = String(args.message ?? "");
    const delayMs = Number(args.delayMs ?? 1500);
    const ttlMs =
      args.ttlMs === undefined ? 3_600_000 : (args.ttlMs as number | null);
    const handle = typeof args.handle === "string" ? args.handle : undefined;
    const sessionId = sessionFor(req, true);
    const task = store.create({
      taskId: handle,
      sessionId,
      message,
      delayMs,
      ttlMs,
      pollIntervalMs: Math.min(500, Math.max(50, Math.floor(delayMs / 5))),
    });
    const extra: Record<string, string> = {};
    if (sessionId) extra["X-Fixture-Session"] = sessionId;
    send(res, 200, jsonrpcResult(id, createView(task)), extra);
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
      store.cancel(taskId);
      send(res, 200, jsonrpcResult(id, { resultType: "complete" }));
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

process.on("SIGINT", () => {
  store.close();
  server.close();
  process.exit(0);
});
