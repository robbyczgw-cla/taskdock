#!/usr/bin/env node
import { TaskDock } from "./taskdock.ts";
import { profileFromFlags } from "./server-profiles/profiles.ts";
import { connect, getTask, pollUntilTerminal } from "./mcp/client.ts";
import { McpRpcError } from "./mcp/transport.ts";
import { PROTOCOL_VERSION, TASKS_EXTENSION_VERSION } from "./mcp/meta.ts";

function usage(): never {
  console.log(`taskdock — experimental MCP task registry

Usage:
  taskdock server add <id> --http <url> [--auth env:VAR]
  taskdock server list
  taskdock register --server <id> --task <handle> [--source-client <name>] [--status <status>]
  taskdock list
  taskdock show <id>
  taskdock poll <id>
  taskdock resume <id>

Env:
  TASKDOCK_DB                 SQLite path (default ./data/taskdock.sqlite)
  TASKDOCK_AUTH_TOKEN         used when server authProfile is env:TASKDOCK_AUTH_TOKEN
`);
  process.exit(2);
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
  if (rows.length === 0) {
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || has(argv, "-h") || has(argv, "--help")) usage();

  const dock = new TaskDock();
  const cmd = argv[0];
  const rest = argv.slice(1);

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
      console.log(JSON.stringify(profile, null, 2));
      return;
    }

    if (cmd === "server" && rest[0] === "list") {
      const servers = dock.listServers();
      printTable([
        ["ID", "TRANSPORT", "AUTH"],
        ...servers.map((s) => [
          s.id,
          s.transport.type === "http"
            ? s.transport.url
            : `${s.transport.command} ${(s.transport.args ?? []).join(" ")}`.trim(),
          s.authProfile ?? "none",
        ]),
      ]);
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
        status: flag(rest, "--status"),
        protocolVersion: PROTOCOL_VERSION,
        taskExtensionVersion: TASKS_EXTENSION_VERSION,
      });
      console.log(`registered ${record.id}`);
      console.log(JSON.stringify(record, null, 2));
      return;
    }

    if (cmd === "list") {
      const tasks = dock.list();
      printTable([
        ["ID", "SERVER", "TASK", "STATUS", "SOURCE"],
        ...tasks.map((t) => [
          t.id,
          t.serverProfileId,
          t.taskHandle,
          t.status ?? "-",
          t.sourceClient ?? "-",
        ]),
      ]);
      return;
    }

    if (cmd === "show") {
      const id = rest[0];
      if (!id) usage();
      const ref = dock.resolve(id);
      console.log(JSON.stringify(ref, null, 2));
      return;
    }

    if (cmd === "poll" || cmd === "resume") {
      const id = rest[0];
      if (!id) usage();
      const untilDone = cmd === "resume" || has(rest, "--until-done");
      const ref = dock.resolve(id);
      console.log(`Loaded ${ref.id} from persistent TaskDock registry`);
      console.log(`server: ${ref.serverProfile.id}`);
      console.log(`task handle: ${ref.taskHandle}`);
      console.log("Opening fresh MCP connection...");
      const connected = await connect(ref.serverProfile, {
        name: "taskdock-cli",
        version: "0.1.0",
      });
      console.log(
        `serverInfo: ${JSON.stringify(connected.serverInfo?.name ?? connected.serverInfo)}`,
      );
      const onTick = (task: { status: string; statusMessage?: string }) => {
        dock.registry.touch(ref.id, task.status);
        console.log(
          `status: ${task.status}${task.statusMessage ? ` (${task.statusMessage})` : ""}`,
        );
      };
      try {
        if (untilDone) {
          const task = await pollUntilTerminal(
            ref.serverProfile,
            ref.taskHandle,
            { client: { name: "taskdock-cli" } },
            { onTick, timeoutMs: 120_000 },
          );
          console.log(JSON.stringify(task, null, 2));
        } else {
          const task = await getTask(ref.serverProfile, ref.taskHandle, {
            client: { name: "taskdock-cli" },
          });
          onTick(task);
          console.log(JSON.stringify(task, null, 2));
        }
      } catch (err) {
        if (err instanceof McpRpcError) {
          console.error(`server error ${err.code}: ${err.message}`);
          if (err.data) console.error(JSON.stringify(err.data, null, 2));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      return;
    }

    usage();
  } finally {
    dock.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
