/**
 * Experiment matrix A–H. Prints a transcript and writes docs/_experiment_log.md.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskDock } from "../src/taskdock.ts";
import { callToolTask, getTask } from "../src/mcp/client.ts";
import { McpRpcError } from "../src/mcp/transport.ts";
import { startFixture } from "../tests/helpers.ts";

const root = join(import.meta.dirname, "..");
const lines: string[] = [];

function log(s = ""): void {
  lines.push(s);
  console.log(s);
}

async function runNode(
  script: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", script, ...extraArgs],
      {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    );
  });
}

type Result = { name: string; pass: boolean; detail: string };

const results: Result[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  log(`## ${name}: ${pass ? "PASS" : "FAIL"}`);
  log(detail);
  log();
}

async function main(): Promise<void> {
  mkdirSync(join(root, "data"), { recursive: true });
  log("# TaskDock experiment transcript");
  log(new Date().toISOString());
  log();

  // A — same process
  {
    const fx = await startFixture({ binding: "independent" });
    const db = join(mkdtempSync(join(tmpdir(), "exp-a-")), "t.sqlite");
    try {
      const dock = new TaskDock(db);
      dock.addServer(fx.profile);
      const created = await callToolTask(
        fx.profile,
        "slow_echo",
        { message: "A", delayMs: 200 },
        { client: { name: "client-a" } },
      );
      dock.register({
        serverProfileId: fx.profile.id,
        taskHandle: created.taskId,
      });
      const polled = await getTask(fx.profile, created.taskId, {
        client: { name: "taskdock" },
      });
      dock.close();
      record(
        "A same process",
        polled.taskId === created.taskId,
        `created=${created.taskId} polled=${polled.status}`,
      );
    } finally {
      await fx.stop();
    }
  }

  // B — TaskDock restart
  {
    const fx = await startFixture({ binding: "independent" });
    const db = join(mkdtempSync(join(tmpdir(), "exp-b-")), "t.sqlite");
    try {
      const a = new TaskDock(db);
      a.addServer(fx.profile);
      const created = await callToolTask(
        fx.profile,
        "slow_echo",
        { message: "B", delayMs: 300 },
        { client: { name: "client-a" } },
      );
      a.register({
        serverProfileId: fx.profile.id,
        taskHandle: created.taskId,
      });
      a.close();
      const b = new TaskDock(db);
      const rec = b.list()[0]!;
      const polled = await getTask(fx.profile, rec.taskHandle, {
        client: { name: "taskdock" },
      });
      b.close();
      record(
        "B TaskDock restart",
        rec.taskHandle === created.taskId && Boolean(polled.status),
        `reopened ${rec.id} handle=${rec.taskHandle} status=${polled.status}`,
      );
    } finally {
      await fx.stop();
    }
  }

  // C — Client A disappears (client-a process exits, taskdock polls)
  {
    const fx = await startFixture({ binding: "independent", name: "demo" });
    const db = join(mkdtempSync(join(tmpdir(), "exp-c-")), "t.sqlite");
    try {
      const a = await runNode("src/clients/client-a.ts", [], {
        TASKDOCK_DB: db,
        TASKDOCK_SERVER_URL: fx.url,
        TASKDOCK_DELAY_MS: "1500",
        TASKDOCK_MESSAGE: "C",
        TASKDOCK_SERVER_ID: "demo",
      });
      const id = a.stdout.match(/TaskDock ID:\n(td_\d+)/)?.[1];
      const b = new TaskDock(db);
      const rec = b.show(id!);
      const polled = await getTask(fx.profile, rec.taskHandle, {
        client: { name: "taskdock-after-a-exit" },
      });
      b.close();
      record(
        "C Client A disappears",
        a.code === 0 && Boolean(id) && Boolean(polled.status),
        `client-a exit=${a.code} id=${id} status=${polled.status}`,
      );
    } finally {
      await fx.stop();
    }
  }

  // D — new MCP session (new HTTP connection, new client name)
  {
    const fx = await startFixture({ binding: "independent" });
    try {
      const created = await callToolTask(
        fx.profile,
        "slow_echo",
        { message: "D", delayMs: 200 },
        { client: { name: "client-a" } },
      );
      const polled = await getTask(fx.profile, created.taskId, {
        client: { name: "brand-new-session" },
      });
      record(
        "D new MCP session",
        polled.taskId === created.taskId,
        `no initialize/session id used; client name changed; status=${polled.status}`,
      );
    } finally {
      await fx.stop();
    }
  }

  // E — different client implementation (client-a.ts vs client-b.ts)
  {
    const fx = await startFixture({ binding: "independent", name: "demo" });
    const db = join(mkdtempSync(join(tmpdir(), "exp-e-")), "t.sqlite");
    try {
      const a = await runNode("src/clients/client-a.ts", [], {
        TASKDOCK_DB: db,
        TASKDOCK_SERVER_URL: fx.url,
        TASKDOCK_DELAY_MS: "1200",
        TASKDOCK_MESSAGE: "hello",
        TASKDOCK_SERVER_ID: "demo",
      });
      const id = a.stdout.match(/TaskDock ID:\n(td_\d+)/)?.[1];
      const b = await runNode("src/clients/client-b.ts", [id!], {
        TASKDOCK_DB: db,
      });
      record(
        "E different client implementation",
        a.code === 0 && b.code === 0 && /completed/.test(b.stdout),
        [
          "--- client-a ---",
          a.stdout.trim(),
          "--- client-b ---",
          b.stdout.trim(),
        ].join("\n"),
      );
    } finally {
      await fx.stop();
    }
  }

  // F — separate process, no TaskDock runtime state
  {
    const fx = await startFixture({ binding: "independent", name: "demo" });
    const db = join(mkdtempSync(join(tmpdir(), "exp-f-")), "t.sqlite");
    try {
      const a = await runNode("src/clients/client-a.ts", [], {
        TASKDOCK_DB: db,
        TASKDOCK_SERVER_URL: fx.url,
        TASKDOCK_DELAY_MS: "800",
        TASKDOCK_MESSAGE: "F",
        TASKDOCK_SERVER_ID: "demo",
      });
      const id = a.stdout.match(/TaskDock ID:\n(td_\d+)/)?.[1];
      const cli = await runNode("src/cli.ts", ["resume", id!, "--until-done"], {
        TASKDOCK_DB: db,
      });
      record(
        "F separate process no runtime state",
        a.code === 0 && cli.code === 0 && /completed/.test(cli.stdout),
        cli.stdout.trim(),
      );
    } finally {
      await fx.stop();
    }
  }

  // G — different machine simulation (isolated directory copy of sqlite only)
  {
    const fx = await startFixture({ binding: "independent", name: "demo" });
    const hostDir = mkdtempSync(join(tmpdir(), "exp-g-host-"));
    const guestDir = mkdtempSync(join(tmpdir(), "exp-g-guest-"));
    const hostDb = join(hostDir, "taskdock.sqlite");
    try {
      const a = await runNode("src/clients/client-a.ts", [], {
        TASKDOCK_DB: hostDb,
        TASKDOCK_SERVER_URL: fx.url,
        TASKDOCK_DELAY_MS: "800",
        TASKDOCK_MESSAGE: "G",
        TASKDOCK_SERVER_ID: "demo",
      });
      const id = a.stdout.match(/TaskDock ID:\n(td_\d+)/)?.[1];
      const guestDb = join(guestDir, "taskdock.sqlite");
      copyFileSync(hostDb, guestDb);
      if (existsSync(hostDb + "-wal")) copyFileSync(hostDb + "-wal", guestDb + "-wal");
      const b = await runNode("src/clients/client-b.ts", [id!], {
        TASKDOCK_DB: guestDb,
        HOME: guestDir,
      });
      record(
        "G different machine simulation",
        a.code === 0 && b.code === 0 && /completed/.test(b.stdout),
        `copied only sqlite from ${hostDir} to ${guestDir}\n${b.stdout.trim()}`,
      );
    } finally {
      await fx.stop();
    }
  }

  // H — expired / invalid / wrong server
  {
    const a = await startFixture({ name: "alpha" });
    const b = await startFixture({ name: "beta" });
    const db = join(mkdtempSync(join(tmpdir(), "exp-h-")), "t.sqlite");
    const dock = new TaskDock(db);
    try {
      dock.addServer(a.profile);
      dock.addServer({
        ...b.profile,
        id: "beta",
        name: "beta",
      });
      const missing = dock.register({
        serverProfileId: a.profile.id,
        taskHandle: "no-such-task",
      });
      let missingMsg = "";
      try {
        await getTask(a.profile, missing.taskHandle, { client: { name: "h" } });
      } catch (err) {
        missingMsg = err instanceof McpRpcError ? err.message : String(err);
      }

      const expired = await callToolTask(
        a.profile,
        "slow_echo",
        { message: "exp", delayMs: 99999, ttlMs: 1 },
        { client: { name: "h" } },
      );
      const expiredRec = dock.register({
        serverProfileId: a.profile.id,
        taskHandle: expired.taskId,
      });
      await new Promise((r) => setTimeout(r, 20));
      let expiredMsg = "";
      try {
        await getTask(a.profile, expired.taskId, { client: { name: "h" } });
      } catch (err) {
        expiredMsg = err instanceof McpRpcError ? err.message : String(err);
      }

      const real = await callToolTask(
        a.profile,
        "slow_echo",
        { message: "wrong-server", delayMs: 99999 },
        { client: { name: "h" } },
      );
      const wrong = dock.register({
        serverProfileId: "beta",
        taskHandle: real.taskId,
      });
      let wrongMsg = "";
      try {
        await getTask(b.profile, real.taskId, { client: { name: "h" } });
      } catch (err) {
        wrongMsg = err instanceof McpRpcError ? err.message : String(err);
      }

      const cancelled = await callToolTask(
        a.profile,
        "slow_echo",
        { message: "cancel-me", delayMs: 99999 },
        { client: { name: "h" } },
      );
      const { cancelTask } = await import("../src/mcp/tasks.ts");
      await cancelTask(a.profile, cancelled.taskId, { client: { name: "h" } });
      const afterCancel = await getTask(a.profile, cancelled.taskId, {
        client: { name: "h" },
      });

      const stillThere = dock.show(missing.id) && dock.show(expiredRec.id) && dock.show(wrong.id);
      record(
        "H expired/invalid/wrong-server",
        /not found/i.test(missingMsg) &&
          /expired/i.test(expiredMsg) &&
          /not found/i.test(wrongMsg) &&
          afterCancel.status === "cancelled" &&
          Boolean(stillThere),
        `missing=${missingMsg}\nexpired=${expiredMsg}\nwrong-server=${wrongMsg}\ncancelled=${afterCancel.status}\nrecords retained=${Boolean(stillThere)}`,
      );
    } finally {
      dock.close();
      await a.stop();
      await b.stop();
    }
  }

  // Mode B contrast (session coupling)
  {
    const fx = await startFixture({ binding: "session" });
    try {
      const created = await callToolTask(
        fx.profile,
        "slow_echo",
        { message: "mode-b", delayMs: 500 },
        { client: { name: "client-a" } },
      );
      let msg = "";
      try {
        await getTask(fx.profile, created.taskId, {
          client: { name: "client-b" },
        });
      } catch (err) {
        msg = err instanceof McpRpcError ? err.message : String(err);
      }
      record(
        "Mode B session-dependent server (contrast)",
        /session/i.test(msg),
        `expected failure on new connection: ${msg}`,
      );
    } finally {
      await fx.stop();
    }
  }

  log("## Summary");
  for (const r of results) {
    log(`- ${r.pass ? "PASS" : "FAIL"} ${r.name}`);
  }
  const all = results.every((r) => r.pass);
  log();
  log(all ? "ALL EXPERIMENTS PASSED" : "SOME EXPERIMENTS FAILED");

  writeFileSync(join(root, "docs", "_experiment_log.md"), lines.join("\n") + "\n");
  process.exit(all ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
