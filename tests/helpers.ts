import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { ServerProfile } from "../src/types.ts";

export function tempDir(prefix = "taskdock-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function tempDb(): string {
  return join(tempDir(), "taskdock.sqlite");
}

export async function freePort(): Promise<number> {
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

export async function waitForHealth(url: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const health = url.replace(/\/mcp$/, "/health");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(health);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`fixture did not become healthy: ${health}`);
}

export async function startFixture(opts: {
  port?: number;
  binding?: "independent" | "session";
  token?: string;
  name?: string;
  instance?: string;
  db?: string;
}): Promise<{
  proc: ChildProcess;
  url: string;
  port: number;
  db: string;
  stop: () => Promise<void>;
  profile: ServerProfile;
}> {
  const port = opts.port ?? (await freePort());
  const db = opts.db ?? join(tempDir(), "fixture.sqlite");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TASKDOCK_FIXTURE_PORT: String(port),
    TASKDOCK_FIXTURE_DB: db,
    TASK_BINDING: opts.binding ?? "independent",
  };
  if (opts.token) env.TASKDOCK_FIXTURE_TOKEN = opts.token;
  if (opts.name) env.TASKDOCK_FIXTURE_NAME = opts.name;
  if (opts.instance) env.TASKDOCK_FIXTURE_INSTANCE = opts.instance;

  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "fixtures/test-task-server/server.ts"],
    {
      cwd: join(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const url = `http://127.0.0.1:${port}/mcp`;
  await waitForHealth(url);

  return {
    proc,
    url,
    port,
    db,
    profile: {
      id: opts.name ?? "demo",
      name: opts.name ?? "demo",
      transport: { type: "http", url },
      authProfile: opts.token ? "env:TASKDOCK_AUTH_TOKEN" : undefined,
    },
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
      if (!proc.killed) proc.kill("SIGKILL");
    },
  };
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
