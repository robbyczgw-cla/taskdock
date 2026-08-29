#!/usr/bin/env node
import { TaskDock } from "./taskdock.js";
import { profileFromFlags } from "./server-profiles/profiles.js";
import {
  connect,
  getTask,
  identityWarning,
  pollUntilTerminal,
} from "./mcp/client.js";
import { McpRpcError } from "./mcp/transport.js";
import { PROTOCOL_VERSION, TASKS_EXTENSION_VERSION } from "./mcp/meta.js";
import { abbreviateHandle, formatAge, isActiveStatus } from "./format.js";
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
  console.log(`taskdock — durable registry for MCP Tasks

Usage:
  taskdock server add <name> --http <url> [--auth env:VAR]
  taskdock server list [--json]
  taskdock server show <name> [--json]
  taskdock server remove <name>
  taskdock register --server <id> --task <handle> [--source-client <name>] [--label <label>]
  taskdock list [--json] [--active]
  taskdock show <id> [--json]
  taskdock poll <id>
  taskdock resume <id> [--until-done]

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
      dock.addServer(profile);
      console.log(`added server ${profile.id}`);
      if (jsonOut) printJson(profile);
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
      const task = flag(rest, "--task");
      if (!server || !task) usage();
      const record = dock.register({
        serverProfileId: server,
        taskHandle: task,
        sourceClient: flag(rest, "--source-client"),
        label: flag(rest, "--label"),
        status: flag(rest, "--status"),
        protocolVersion: PROTOCOL_VERSION,
        taskExtensionVersion: TASKS_EXTENSION_VERSION,
      });
      console.log(`registered ${record.id}`);
      if (jsonOut) printJson(record);
      return;
    }

    if (cmd === "list") {
      let tasks = dock.list();
      if (has(rest, "--active") || has(argv, "--active")) {
        tasks = tasks.filter((t) => isActiveStatus(t.status));
      }
      if (jsonOut) {
        printJson(tasks);
        return;
      }
      printTable([
        ["ID", "STATUS", "SERVER", "TASK", "AGE"],
        ...tasks.map((t) => [
          t.id,
          t.status ?? "-",
          t.serverProfileId,
          abbreviateHandle(t.taskHandle),
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
          taskHandle: ref.taskHandle,
          sourceClient: ref.record.sourceClient,
          label: ref.record.label,
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

    if (cmd === "poll" || cmd === "resume") {
      const id = rest[0];
      if (!id || id.startsWith("--")) usage();
      const untilDone = cmd === "resume";
      await runPoll(dock, id, untilDone);
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
  console.log(`handle:    ${t.taskHandle}`);
  console.log(`source:    ${t.sourceClient ?? "-"}`);
  console.log(`created:   ${t.createdAt}`);
  console.log(`last seen: ${t.lastSeenAt}`);
}

async function runPoll(
  dock: TaskDock,
  id: string,
  untilDone: boolean,
): Promise<void> {
  let ref: TaskRef;
  try {
    ref = dock.resolve(id);
  } catch (err) {
    throw err;
  }
  console.log(`Loaded ${ref.id} from the local TaskDock registry`);
  console.log(`server: ${ref.serverProfile.id}`);
  const connected = await connect(ref.serverProfile, {
    name: "taskdock-cli",
    version: "0.1.0",
  });
  const warn = identityWarning(
    ref.record.metadata?.serverInfo as Record<string, unknown> | undefined,
    connected.serverInfo ?? {},
  );
  if (warn) console.warn(warn);
  try {
    const onTick = (task: { status: string; statusMessage?: string }) => {
      dock.registry.touch(ref.id, task.status);
      console.log(
        `status: ${task.status}${task.statusMessage ? ` (${task.statusMessage})` : ""}`,
      );
    };
    const task = untilDone
      ? await pollUntilTerminal(
          ref.serverProfile,
          ref.taskHandle,
          { client: { name: "taskdock-cli" } },
          { onTick, timeoutMs: 120_000 },
        )
      : await getTask(ref.serverProfile, ref.taskHandle, {
          client: { name: "taskdock-cli" },
        });
    if (!untilDone) onTick(task);
    if (task.status === "input_required") {
      console.log(`Task ${ref.id} requires input.`);
      console.log("TaskDock currently supports discovery and resume polling.");
      console.log(
        "Use a compatible MCP client to fulfill the input request.",
      );
      process.exitCode = 2;
      return;
    }
    if (task.result) printJson(task.result);
    else if (task.error) printJson(task.error);
  } catch (err) {
    if (err instanceof McpRpcError) {
      console.error(`Could not resume ${id}.`);
      console.error();
      console.error(`Server: ${ref.serverProfile.id}`);
      console.error(`Reason: MCP server returned ${err.message}`);
      console.error();
      console.error("The server may have expired or lost the task.");
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
