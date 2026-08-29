import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { TaskDock } from "../src/taskdock.ts";
import { callToolTask, getTask, pollUntilTerminal } from "../src/mcp/client.ts";
import { McpRpcError } from "../src/mcp/transport.ts";
import { startFixture, tempDb } from "./helpers.ts";

const client = { name: "test" };

test("new connection can get stored task (Mode A)", async () => {
  const fx = await startFixture({ binding: "independent" });
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "hello", delayMs: 400 },
      { client },
    );
    assert.equal(created.resultType, "task");
    const again = await getTask(fx.profile, created.taskId, { client });
    assert.ok(again.status === "working" || again.status === "completed");
    const done = await pollUntilTerminal(fx.profile, created.taskId, { client });
    assert.equal(done.status, "completed");
    const text = (done.result as { content: { text: string }[] }).content[0]!.text;
    assert.equal(text, "hello");
  } finally {
    await fx.stop();
  }
});

test("new process can get stored task via TaskDock sqlite", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  try {
    const dock = new TaskDock(db);
    dock.addServer(fx.profile);
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "from-process", delayMs: 800 },
      { client: { name: "client-a" } },
    );
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
      sourceClient: "client-a",
    });
    dock.close();

    const result = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        const proc = spawn(
          process.execPath,
          ["--import", "tsx", "src/clients/client-b.ts", rec.id],
          {
            cwd: join(import.meta.dirname, ".."),
            env: { ...process.env, TASKDOCK_DB: db },
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
          resolve({ status: code ?? 1, stdout, stderr }),
        );
      },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Opening fresh MCP connection/);
    assert.match(result.stdout, /from-process/);
    assert.match(result.stdout, /completed/);
  } finally {
    await fx.stop();
  }
});

test("invalid handle fails without deleting the registry row", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: "does-not-exist",
    });
    await assert.rejects(
      () => getTask(fx.profile, rec.taskHandle, { client }),
      (err: unknown) => {
        assert.ok(err instanceof McpRpcError);
        assert.equal(err.code, -32602);
        assert.match(err.message, /not found/i);
        return true;
      },
    );
    assert.equal(dock.show(rec.id).taskHandle, "does-not-exist");
  } finally {
    dock.close();
    await fx.stop();
  }
});

test("expired handle fails", async () => {
  const fx = await startFixture({ binding: "independent" });
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "bye", delayMs: 10_000, ttlMs: 1 },
      { client },
    );
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
      () => getTask(fx.profile, created.taskId, { client }),
      (err: unknown) => {
        assert.ok(err instanceof McpRpcError);
        assert.match(err.message, /expired/i);
        return true;
      },
    );
  } finally {
    await fx.stop();
  }
});

test("wrong server fails", async () => {
  const a = await startFixture({ name: "alpha", instance: "a" });
  const b = await startFixture({ name: "beta", instance: "b" });
  try {
    const created = await callToolTask(
      a.profile,
      "slow_echo",
      { message: "secret", delayMs: 5000 },
      { client },
    );
    await assert.rejects(
      () => getTask(b.profile, created.taskId, { client }),
      (err: unknown) => {
        assert.ok(err instanceof McpRpcError);
        assert.match(err.message, /not found/i);
        return true;
      },
    );
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("Mode B session binding: new connection cannot resume", async () => {
  const fx = await startFixture({ binding: "session" });
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "session-bound", delayMs: 2000 },
      { client },
    );
    await assert.rejects(
      () => getTask(fx.profile, created.taskId, { client }),
      (err: unknown) => {
        assert.ok(err instanceof McpRpcError);
        assert.match(err.message, /session/i);
        return true;
      },
    );
  } finally {
    await fx.stop();
  }
});

test("Mode B session binding: same session header can resume", async () => {
  const fx = await startFixture({ binding: "session" });
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "keep-session", delayMs: 200 },
      { client, extraHeaders: { "X-Fixture-Session": "sess_fixed" } },
    );
    const got = await getTask(fx.profile, created.taskId, {
      client,
      extraHeaders: { "X-Fixture-Session": "sess_fixed" },
    });
    assert.ok(got.status === "working" || got.status === "completed");
  } finally {
    await fx.stop();
  }
});

test("opaque handle round-trip through MCP", async () => {
  const fx = await startFixture({ binding: "independent" });
  try {
    const handle = "cfth1:backend/task/123+x=y";
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "opaque", delayMs: 50, handle },
      { client },
    );
    assert.equal(created.taskId, handle);
    const done = await pollUntilTerminal(fx.profile, handle, { client });
    assert.equal(done.taskId, handle);
    assert.equal(done.status, "completed");
  } finally {
    await fx.stop();
  }
});

test("unicode handle round-trips with Base64 Mcp-Name sentinel", async () => {
  const fx = await startFixture({ binding: "independent" });
  try {
    const handle = "任务-äöü";
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "unicode", delayMs: 50, handle },
      { client },
    );
    assert.equal(created.taskId, handle);
    const done = await pollUntilTerminal(fx.profile, handle, { client });
    assert.equal(done.taskId, handle);
    assert.equal(done.status, "completed");
  } finally {
    await fx.stop();
  }
});

test("auth token required when fixture is locked", async () => {
  const fx = await startFixture({ token: "secret-token" });
  const previous = process.env.TASKDOCK_AUTH_TOKEN;
  try {
    await assert.rejects(
      () =>
        callToolTask(
          { ...fx.profile, authProfile: undefined },
          "slow_echo",
          { message: "nope", delayMs: 10 },
          { client },
        ),
      /unauthorized|MCP/,
    );
    process.env.TASKDOCK_AUTH_TOKEN = "secret-token";
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "ok", delayMs: 10 },
      { client },
    );
    assert.equal(created.resultType, "task");
  } finally {
    if (previous === undefined) delete process.env.TASKDOCK_AUTH_TOKEN;
    else process.env.TASKDOCK_AUTH_TOKEN = previous;
    await fx.stop();
  }
});
