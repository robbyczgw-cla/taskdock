/**
 * Experiment I: resume against official rmcp TaskDemo over HTTP.
 * Requires the third-party server on TASKDOCK_SERVER_URL (default docker :8000).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const url = process.env.TASKDOCK_SERVER_URL ?? "http://127.0.0.1:8000/mcp";
const db = process.env.TASKDOCK_DB ?? join(root, "data", "interop-taskdock.sqlite");

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function waitHealth(): Promise<void> {
  const health = url.replace(/\/mcp$/, "/health");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(health);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`third-party server not healthy at ${health}`);
}

async function main(): Promise<void> {
  mkdirSync(join(root, "data"), { recursive: true });
  for (const f of [db, db + "-wal", db + "-shm"]) rmSync(f, { force: true });

  console.log("=== Experiment I: third-party rmcp TaskDemo ===");
  console.log(`server: ${url}`);
  console.log(`registry: ${db}`);
  console.log();

  await waitHealth();

  const a = await run(["src/clients/client-a.ts"], {
    TASKDOCK_DB: db,
    TASKDOCK_SERVER_URL: url,
    TASKDOCK_SERVER_ID: "rmcp",
    TASKDOCK_TOOL: "slow_sum",
    TASKDOCK_TOOL_ARGS: JSON.stringify({ a: 2, b: 40 }),
  });
  if (a.code !== 0) {
    process.exitCode = a.code;
    return;
  }
  const id = a.stdout.match(/TaskDock ID:\n(td_\d+)/)?.[1];
  if (!id) {
    console.error("could not parse TaskDock id from client-a");
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log("Client A process has exited. Starting Client B against rmcp...");
  console.log();

  const b = await run(["src/clients/client-b.ts", id], {
    TASKDOCK_DB: db,
  });
  if (b.code !== 0) {
    process.exitCode = b.code;
    return;
  }
  if (!/42/.test(b.stdout) || !/completed/.test(b.stdout)) {
    console.error("FAIL: expected completed result 42 from slow_sum");
    process.exitCode = 1;
    return;
  }
  console.log();
  console.log("Experiment I: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
