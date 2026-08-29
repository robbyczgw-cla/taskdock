/**
 * Client A: start a long-running MCP task, register it with TaskDock, exit.
 * Shares no runtime with Client B. Persistence is SQLite only.
 */
import { TaskDock } from "../taskdock.js";
import { connect, callToolTask } from "../mcp/client.js";
import { PROTOCOL_VERSION, TASKS_EXTENSION_VERSION } from "../mcp/meta.js";
import type { ServerProfile } from "../types.js";

const url = process.env.TASKDOCK_SERVER_URL ?? "http://127.0.0.1:3333/mcp";
const delayMs = Number(process.env.TASKDOCK_DELAY_MS ?? 4000);
const message = process.env.TASKDOCK_MESSAGE ?? "hello from client-a";
const handle = process.env.TASKDOCK_HANDLE;
const serverId = process.env.TASKDOCK_SERVER_ID ?? "demo";
const tool = process.env.TASKDOCK_TOOL ?? "slow_echo";
const toolArgs = process.env.TASKDOCK_TOOL_ARGS
  ? (JSON.parse(process.env.TASKDOCK_TOOL_ARGS) as Record<string, unknown>)
  : {
      message,
      delayMs,
      ...(handle ? { handle } : {}),
    };

async function main(): Promise<void> {
  console.log("[client-a]");
  console.log();
  console.log("Starting long-running MCP task...");
  console.log();

  const profile: ServerProfile = {
    id: serverId,
    name: serverId,
    transport: { type: "http", url },
    authProfile: process.env.TASKDOCK_AUTH_TOKEN ? "env:TASKDOCK_AUTH_TOKEN" : undefined,
  };

  const dock = new TaskDock();
  dock.addServer(profile);

  const connected = await connect(profile, { name: "client-a", version: "0.1.0" });
  console.log(`Connected. server=${JSON.stringify(connected.serverInfo)}`);
  console.log("This process will exit after register. No polling loop is kept.");
  console.log();

  const task = await callToolTask(profile, tool, toolArgs, {
    client: { name: "client-a" },
  });

  console.log("taskId:");
  console.log(task.taskId);
  console.log();
  console.log("Registering with TaskDock...");
  console.log();

  const record = dock.register({
    serverProfileId: serverId,
    taskHandle: task.taskId,
    sourceClient: "client-a",
    status: task.status,
    protocolVersion: PROTOCOL_VERSION,
    taskExtensionVersion: TASKS_EXTENSION_VERSION,
    metadata: {
      createdAt: task.createdAt,
      ttlMs: task.ttlMs,
      pollIntervalMs: task.pollIntervalMs,
      serverInfo: connected.serverInfo,
    },
  });

  console.log("TaskDock ID:");
  console.log(record.id);
  console.log();
  console.log("Created MCP task", task.taskId);
  console.log("Registered as TaskDock", record.id);
  console.log("Client A terminating.");
  console.log("Exiting Client A.");

  dock.close();
}

main().catch((err) => {
  console.error("[client-a] failed:", err);
  process.exit(1);
});
