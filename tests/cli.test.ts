import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb } from "./helpers.ts";

const repoRoot = join(import.meta.dirname, "..");

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], db = tempDb()): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, TASKDOCK_DB: db },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function assertSucceeded(result: CliResult): void {
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

async function registerTask(db: string, taskHandle: string): Promise<void> {
  const added = await runCli(
    ["server", "add", "demo", "--http", "http://127.0.0.1:3333/mcp"],
    db,
  );
  assertSucceeded(added);

  const registered = await runCli(
    ["register", "--server", "demo", "--task", taskHandle],
    db,
  );
  assertSucceeded(registered);
}

test("--help exits 0", async () => {
  const result = await runCli(["--help"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test("no args exits non-zero", async () => {
  const result = await runCli([]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Usage:/i);
});

test("unknown command exits non-zero", async () => {
  const result = await runCli(["not-a-command"]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Usage:|unknown command/i);
});

test("server add and server list", async () => {
  const db = tempDb();
  const url = "http://127.0.0.1:3333/mcp";
  const added = await runCli(
    ["server", "add", "demo", "--http", url],
    db,
  );
  assertSucceeded(added);
  assert.match(added.stdout, /added server demo/);

  const listed = await runCli(["server", "list"], db);
  assertSucceeded(listed);
  assert.match(listed.stdout, /demo/);
  assert.match(listed.stdout, /http:\/\/127\.0\.0\.1:3333\/mcp/);
});

test("human task list abbreviates long handles", async () => {
  const db = tempDb();
  const taskHandle = `taskdock-${"x".repeat(120)}-tail`;
  await registerTask(db, taskHandle);

  const listed = await runCli(["list"], db);
  assertSucceeded(listed);
  assert.ok(listed.stdout.includes(taskHandle.slice(0, 16)));
  assert.ok(!listed.stdout.includes(taskHandle));
  assert.match(listed.stdout, /\.\.\.|…/);
});

test("list --json contains the full taskHandle", async () => {
  const db = tempDb();
  const taskHandle = "cfth1:backend/task/123+x=y";
  await registerTask(db, taskHandle);

  const listed = await runCli(["list", "--json"], db);
  assertSucceeded(listed);
  const tasks = JSON.parse(listed.stdout) as { taskHandle: string }[];

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.taskHandle, taskHandle);
});

test("show --json contains the full taskHandle", async () => {
  const db = tempDb();
  const taskHandle = "opaque_random_blob/backend-task-123";
  await registerTask(db, taskHandle);

  const shown = await runCli(["show", "td_01", "--json"], db);
  assertSucceeded(shown);
  const task = JSON.parse(shown.stdout) as { taskHandle: string };

  assert.equal(task.taskHandle, taskHandle);
});

test("missing task reports its TaskDock id", async () => {
  const id = "td_missing";
  const result = await runCli(["show", id]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(`Unknown TaskDock id: ${id}`));
});

test("missing server reports its server id", async () => {
  const server = "missing-server";
  const result = await runCli(
    ["register", "--server", server, "--task", "task-1"],
  );

  assert.notEqual(result.code, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    new RegExp(`Unknown server profile: ${server}`),
  );
});
