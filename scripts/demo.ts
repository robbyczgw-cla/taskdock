/**
 * Canonical cross-client demo.
 * Starts the fixture, runs client-a as a child, waits for it to exit,
 * then runs client-b as a separate child against the same SQLite file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";

const root = join(import.meta.dirname, "..");

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitHealth(port: number): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("fixture not healthy");
}

async function main(): Promise<void> {
  mkdirSync(join(root, "data"), { recursive: true });
  const port = await freePort();
  const db = join(root, "data", "demo-taskdock.sqlite");
  const fixtureDb = join(root, "data", "demo-fixture.sqlite");
  for (const f of [db, db + "-wal", db + "-shm", fixtureDb, fixtureDb + "-wal", fixtureDb + "-shm"]) {
    rmSync(f, { force: true });
  }
  const url = `http://127.0.0.1:${port}/mcp`;

  console.log("=== TaskDock cross-client demo ===");
  console.log(`fixture: ${url}`);
  console.log(`registry: ${db}`);
  console.log();

  const fixture: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "fixtures/test-task-server/server.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        TASKDOCK_FIXTURE_PORT: String(port),
        TASKDOCK_FIXTURE_DB: fixtureDb,
        TASK_BINDING: "independent",
        TASKDOCK_FIXTURE_NAME: "demo",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  try {
    await waitHealth(port);

    const a = await run(["src/clients/client-a.ts"], {
      TASKDOCK_DB: db,
      TASKDOCK_SERVER_URL: url,
      TASKDOCK_DELAY_MS: "2500",
      TASKDOCK_MESSAGE: "hello",
    });
    if (a.code !== 0) process.exit(a.code);

    const idMatch = a.stdout.match(/TaskDock ID:\n(td_\d+)/);
    const id = idMatch?.[1];
    if (!id) {
      console.error("could not parse TaskDock id from client-a");
      process.exit(1);
    }

    console.log();
    console.log("Client A process has exited. Starting Client B...");
    console.log();

    const b = await run(["src/clients/client-b.ts", id], {
      TASKDOCK_DB: db,
    });
    process.exit(b.code);
  } finally {
    fixture.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
