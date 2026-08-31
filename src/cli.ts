#!/usr/bin/env node
import { TaskDock } from "./taskdock.js";
import { profileFromFlags } from "./server-profiles/profiles.js";
import { connect, identityWarning, pollUntilTerminal } from "./mcp/client.js";
import { McpRpcError } from "./mcp/transport.js";
import { PROTOCOL_VERSION, TASKS_EXTENSION_VERSION } from "./mcp/meta.js";
import { TaskDockError } from "./mcp/errors.js";
import { toRegisterInput } from "./ingest/types.js";
import { abbreviateHandle, formatAge } from "./format.js";
import type { NativeControlResult } from "./taskdock.js";
import type { ServerProfile, TaskRecord, TaskRef } from "./types.js";

class UsageError extends Error {
  constructor() {
    super("usage");
    this.name = "UsageError";
  }
}

function usage(): never {
  throw new UsageError();
}

function printUsage(): void {
  console.log(`taskdock — durable task index for MCP Tasks

Usage:
  taskdock server add <name> --http <url> [--auth env:VAR]
  taskdock server list [--json]
  taskdock server show <name> [--json]
  taskdock server remove <name>
  taskdock register --server <id> --task-id <native-id> [--source-client <name>] [--label <label>]
  taskdock list [--json] [--active] [--server <id>] [--status <status>]
  taskdock show <id> [--json]
  taskdock get <id> [--json]
  taskdock cancel <id> [--json]
  taskdock update <id> --input-responses <json> [--json]
  taskdock poll <id> [--json]
  taskdock resume <id>

Env:
  TASKDOCK_DB     SQLite path (default ~/.local/share/taskdock/taskdock.sqlite)
`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printTable(rows: string[][]): void {
  if (rows.length <= 1) {
    console.log("(none)");
    return;
  }
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  for (const [idx, row] of rows.entries()) {
    console.log(row.map((cell, i) => pad(cell ?? "", widths[i]!)).join("  "));
    if (idx === 0) {
      console.log(widths.map((w) => "-".repeat(w)).join("  "));
    }
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function transportLabel(profile: ServerProfile): string {
  if (profile.transport.type === "http") return profile.transport.url;
  return `${profile.transport.command} ${(profile.transport.args ?? []).join(" ")}`.trim();
}

function parseInputResponses(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid --input-responses JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--input-responses must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function nativePayload(result: NativeControlResult): Record<string, unknown> {
  return {
    id: result.ref.id,
    nativeTaskId: result.ref.taskHandle,
    taskHandle: result.ref.taskHandle,
    serverProfileId: result.ref.serverProfile.id,
    status: result.task?.status,
    cachedStatus: result.ref.record.status,
    origin: result.ref.record.sourceClient,
    label: result.ref.record.label,
    warning: result.warning,
    ack: result.ack,
    task: result.task,
    record: result.ref.record,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (has(argv, "-h") || has(argv, "--help")) {
    printUsage();
    process.exitCode = 0;
    return;
  }
  if (argv.length === 0) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const dock = new TaskDock();
  const cmd = argv[0];
  const rest = argv.slice(1);
  const jsonOut = has(argv, "--json");

  try {
    if (cmd === "server" && rest[0] === "add") {
      const id = rest[1];
      if (!id) usage();
      const profile = profileFromFlags({
        id,
        http: flag(rest, "--http"),
        stdio: flag(rest, "--stdio"),
        auth: flag(rest, "--auth"),
      });
      const stored = dock.addServer(profile);
      console.log(`added server ${stored.id}`);
      if (jsonOut) printJson(stored);
      return;
    }

    if (cmd === "server" && rest[0] === "list") {
      const servers = dock.listServers();
      if (jsonOut) {
        printJson(servers);
        return;
      }
      printTable([
        ["ID", "TRANSPORT", "AUTH"],
        ...servers.map((s) => [
          s.id,
          transportLabel(s),
          s.authProfile ?? "none",
        ]),
      ]);
      return;
    }

    if (cmd === "server" && rest[0] === "show") {
      const id = rest[1];
      if (!id) usage();
      const profile = dock.getServer(id);
      if (!profile) {
        throw new Error(`Unknown server profile: ${id}`);
      }
      printJson(profile);
      return;
    }

    if (cmd === "server" && rest[0] === "remove") {
      const id = rest[1];
      if (!id) usage();
      dock.removeServer(id);
      console.log(`removed server ${id}`);
      return;
    }

    if (cmd === "register") {
      const server = flag(rest, "--server");
      const task = flag(rest, "--task-id") ?? flag(rest, "--task");
      if (!server || !task) usage();
      const record = dock.register(
        toRegisterInput({
          serverProfileId: server,
          nativeTaskId: task,
          sourceClient: flag(rest, "--source-client"),
          label: flag(rest, "--label"),
          status: flag(rest, "--status"),
          protocolVersion: PROTOCOL_VERSION,
          taskExtensionVersion: TASKS_EXTENSION_VERSION,
        }),
      );
      await dock.captureIdentity(record.id);
      const stored = dock.show(record.id);
      console.log(`registered ${stored.id}`);
      if (jsonOut) printJson({ ...stored, nativeTaskId: stored.taskHandle });
      return;
    }

    if (cmd === "list") {
      const tasks = dock.list({
        server: flag(rest, "--server") ?? flag(argv, "--server"),
        status: flag(rest, "--status") ?? flag(argv, "--status"),
        active: has(rest, "--active") || has(argv, "--active"),
      });
      if (jsonOut) {
        printJson(tasks.map((t) => ({ ...t, nativeTaskId: t.taskHandle })));
        return;
      }
      printTable([
        ["ID", "STATUS", "SERVER", "NATIVE", "ORIGIN", "AGE"],
        ...tasks.map((t) => [
          t.id,
          t.status ?? "-",
          t.serverProfileId,
          abbreviateHandle(t.taskHandle),
          t.sourceClient ?? "-",
          formatAge(t.createdAt),
        ]),
      ]);
      return;
    }

    if (cmd === "show") {
      const id = rest[0];
      if (!id || id.startsWith("--")) usage();
      const ref = dock.resolve(id);
      if (jsonOut) {
        printJson({
          id: ref.id,
          status: ref.record.status,
          serverProfileId: ref.serverProfile.id,
          nativeTaskId: ref.taskHandle,
          taskHandle: ref.taskHandle,
          sourceClient: ref.record.sourceClient,
          label: ref.record.label,
          ttlMs: ref.record.ttlMs,
          lastError: ref.record.lastError,
          protocolVersion: ref.record.protocolVersion,
          taskExtensionVersion: ref.record.taskExtensionVersion,
          createdAt: ref.record.createdAt,
          lastSeenAt: ref.record.lastSeenAt,
          metadata: ref.record.metadata,
          serverProfile: ref.serverProfile,
        });
        return;
      }
      printShow(ref);
      return;
    }

    if (cmd === "get" || cmd === "poll") {
      const id = rest[0];
      if (!id || id.startsWith("--")) usage();
      const result = await dock.getNative(id);
      printNative(result, jsonOut, false);
      return;
    }

    if (cmd === "cancel") {
      const id = rest[0];
      if (!id || id.startsWith("--")) usage();
      const result = await dock.cancelNative(id);
      printNative(result, jsonOut, true);
      return;
    }

    if (cmd === "update") {
      const id = rest[0];
      if (!id || id.startsWith("--")) usage();
      const raw = flag(rest, "--input-responses");
      if (!raw) usage();
      const result = await dock.updateNative(id, parseInputResponses(raw));
      printNative(result, jsonOut, true);
      return;
    }

    if (cmd === "resume") {
      const id = rest[0];
      if (!id || id.startsWith("--")) usage();
      await runResume(dock, id);
      return;
    }

    console.error(`unknown command: ${cmd}`);
    printUsage();
    process.exitCode = 2;
  } catch (err) {
    if (err instanceof UsageError) {
      printUsage();
      process.exitCode = 2;
      return;
    }
    if (err instanceof TaskDockError) {
      printControlFailure(err);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    dock.close();
  }
}

function printShow(ref: TaskRef): void {
  const t: TaskRecord = ref.record;
  console.log(`id:        ${ref.id}`);
  console.log(`status:    ${t.status ?? "-"} (cached, may be stale)`);
  console.log(`server:    ${ref.serverProfile.id}`);
  console.log(`native:    ${t.taskHandle}`);
  console.log(`origin:    ${t.sourceClient ?? "-"}`);
  console.log(`created:   ${t.createdAt}`);
  console.log(`last seen: ${t.lastSeenAt}`);
  if (t.ttlMs !== undefined && t.ttlMs !== null) console.log(`ttlMs:     ${t.ttlMs}`);
  if (t.lastError) console.log(`last error: ${t.lastError}`);
}

function printNative(
  result: NativeControlResult,
  jsonOut: boolean,
  showAck: boolean,
): void {
  if (jsonOut) {
    printJson(nativePayload(result));
    return;
  }
  if (result.warning) console.warn(result.warning);
  console.log(`id:        ${result.ref.id}`);
  console.log(`server:    ${result.ref.serverProfile.id}`);
  console.log(`native:    ${result.ref.taskHandle}`);
  if (result.task) {
    console.log(`status:    ${result.task.status}`);
    if (result.task.statusMessage) {
      console.log(`message:   ${result.task.statusMessage}`);
    }
    if (result.task.status === "input_required" && result.task.inputRequests) {
      console.log("inputRequests:");
      printJson(result.task.inputRequests);
    }
    if (result.task.result) printJson(result.task.result);
    else if (result.task.error) printJson(result.task.error);
  } else if (showAck) {
    console.log("ack:       received");
    if (!result.task && result.warning) {
      console.log("observe:   failed (record retained)");
    }
  }
}

function printControlFailure(err: TaskDockError): void {
  console.error(err.message);
  console.error();
  console.error("The TaskDock record has been retained.");
}

async function runResume(dock: TaskDock, id: string): Promise<void> {
  const ref = dock.resolve(id);
  console.log(`Loaded ${ref.id} from the local TaskDock registry`);
  console.log(`server: ${ref.serverProfile.id}`);
  try {
    const connected = await connect(ref.serverProfile, {
      name: "taskdock-cli",
      version: "0.1.0",
    });
    const warn = identityWarning(
      ref.record.metadata?.serverInfo as Record<string, unknown> | undefined,
      connected.serverInfo ?? {},
    );
    if (warn) console.warn(warn);
    const onTick = (task: { status: string; statusMessage?: string }) => {
      dock.registry.touch(ref.id, task.status, { clearError: true });
      console.log(
        `status: ${task.status}${task.statusMessage ? ` (${task.statusMessage})` : ""}`,
      );
    };
    const task = await pollUntilTerminal(
      ref.serverProfile,
      ref.taskHandle,
      { client: { name: "taskdock-cli" } },
      { onTick, timeoutMs: 120_000 },
    );
    if (task.status === "input_required") {
      console.log(`Task ${ref.id} requires input.`);
      console.log("Fulfill it with: taskdock update <id> --input-responses <json>");
      process.exitCode = 2;
      return;
    }
    if (task.result) printJson(task.result);
    else if (task.error) printJson(task.error);
  } catch (err) {
    if (err instanceof TaskDockError) {
      dock.registry.recordError(ref.id, err.message);
      printControlFailure(err);
      process.exitCode = 1;
      return;
    }
    if (err instanceof McpRpcError) {
      dock.registry.recordError(ref.id, err.message);
      console.error(`Could not resume ${id}.`);
      console.error();
      console.error(`Server: ${ref.serverProfile.id}`);
      console.error(`Reason: MCP server returned ${err.message}`);
      console.error();
      console.error("The TaskDock record has been retained.");
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
