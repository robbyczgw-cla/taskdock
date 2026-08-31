import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { TaskDock } from "../src/taskdock.ts";
import { callToolTask } from "../src/mcp/client.ts";
import {
  AuthEnvMissingError,
  ServerUnavailableError,
  TaskExpiredError,
} from "../src/mcp/errors.ts";
import { startFixture, tempDb } from "./helpers.ts";

const client = { name: "test" };
const repoRoot = join(import.meta.dirname, "..");

function runCli(
  args: string[],
  db: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, TASKDOCK_DB: db, ...env },
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
    proc.once("error", reject);
    proc.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

test("cross-process native get uses stored server identity + taskId", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "handoff", delayMs: 400 },
      { client: { name: "client-a" } },
    );
    const a = new TaskDock(db);
    a.addServer(fx.profile);
    const rec = a.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
      sourceClient: "client-a",
      status: created.status,
      ttlMs: created.ttlMs,
    });
    a.close();

    const b = new TaskDock(db);
    const live = await b.getNative(rec.id);
    assert.equal(live.ref.taskHandle, created.taskId);
    assert.equal(live.ref.serverProfile.id, fx.profile.id);
    assert.ok(
      live.task?.status === "working" || live.task?.status === "completed",
    );
    if (live.task?.status === "completed") {
      const text = (live.task.result as { content: { text: string }[] }).content[0]
        ?.text;
      assert.equal(text, "handoff");
    }
    b.close();
  } finally {
    await fx.stop();
  }
});

test("cancel routes to the native task on the stored server", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "stop-me", delayMs: 10_000 },
      { client },
    );
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
    });
    const cancelled = await dock.cancelNative(rec.id);
    assert.equal(cancelled.task?.status, "cancelled");
    assert.equal(dock.show(rec.id).status, "cancelled");
  } finally {
    dock.close();
    await fx.stop();
  }
});

test("update routes inputResponses to native tasks/update", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    const created = await callToolTask(
      fx.profile,
      "needs_input",
      { prompt: "name?" },
      { client },
    );
    assert.equal(created.status, "input_required");
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
      status: created.status,
    });
    const got = await dock.getNative(rec.id);
    assert.equal(got.task?.status, "input_required");
    assert.ok(got.task?.inputRequests && "prompt" in got.task.inputRequests);
    const updated = await dock.updateNative(rec.id, {
      prompt: { action: "accept", content: { input: "Ada" } },
    });
    assert.equal(updated.task?.status, "completed");
    const text = (updated.task?.result as { content: { text: string }[] }).content[0]
      ?.text;
    assert.equal(text, "Ada");
  } finally {
    dock.close();
    await fx.stop();
  }
});

test("same native taskId on two servers does not collide", async () => {
  const a = await startFixture({ name: "alpha", instance: "a" });
  const b = await startFixture({ name: "beta", instance: "b" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    const handle = "shared-native-id";
    const createdA = await callToolTask(
      a.profile,
      "slow_echo",
      { message: "from-a", delayMs: 50, handle },
      { client },
    );
    const createdB = await callToolTask(
      b.profile,
      "slow_echo",
      { message: "from-b", delayMs: 50, handle },
      { client },
    );
    assert.equal(createdA.taskId, handle);
    assert.equal(createdB.taskId, handle);
    dock.addServer(a.profile);
    dock.addServer(b.profile);
    const recA = dock.register({
      serverProfileId: a.profile.id,
      taskHandle: handle,
    });
    const recB = dock.register({
      serverProfileId: b.profile.id,
      taskHandle: handle,
    });
    assert.notEqual(recA.id, recB.id);
    const liveA = await dock.getNative(recA.id);
    const liveB = await dock.getNative(recB.id);
    const textA = (liveA.task?.result as { content?: { text: string }[] } | undefined)
      ?.content?.[0]?.text;
    const textB = (liveB.task?.result as { content?: { text: string }[] } | undefined)
      ?.content?.[0]?.text;
    if (liveA.task?.status === "completed") assert.equal(textA, "from-a");
    if (liveB.task?.status === "completed") assert.equal(textB, "from-b");
  } finally {
    dock.close();
    await a.stop();
    await b.stop();
  }
});

test("duplicate registration is idempotent", async () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const first = dock.register({
    serverProfileId: "demo",
    taskHandle: "native-1",
    sourceClient: "claude-code",
  });
  const second = dock.register({
    serverProfileId: "demo",
    taskHandle: "native-1",
    status: "working",
  });
  assert.equal(first.id, second.id);
  assert.equal(dock.list().length, 1);
  assert.equal(second.sourceClient, "claude-code");
  dock.close();
});

test("literal auth secret is not persisted", async () => {
  const dock = new TaskDock(tempDb());
  assert.throws(
    () =>
      dock.addServer({
        id: "demo",
        name: "demo",
        transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
        authProfile: "super-secret-token",
      }),
    /env:VAR/,
  );
  dock.close();
});

test("missing auth env var fails without deleting the row", async () => {
  const fx = await startFixture({ token: "secret-token" });
  const db = tempDb();
  const dock = new TaskDock(db);
  const previous = process.env.TASKDOCK_AUTH_TOKEN;
  try {
    delete process.env.TASKDOCK_AUTH_TOKEN;
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: "never-created",
    });
    await assert.rejects(() => dock.getNative(rec.id), AuthEnvMissingError);
    assert.equal(dock.show(rec.id).id, rec.id);
    assert.match(dock.show(rec.id).lastError ?? "", /TASKDOCK_AUTH_TOKEN/);
  } finally {
    if (previous === undefined) delete process.env.TASKDOCK_AUTH_TOKEN;
    else process.env.TASKDOCK_AUTH_TOKEN = previous;
    dock.close();
    await fx.stop();
  }
});

test("expired native task is retained", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "bye", delayMs: 10_000, ttlMs: 1 },
      { client },
    );
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
    });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(() => dock.getNative(rec.id), TaskExpiredError);
    assert.equal(dock.show(rec.id).taskHandle, created.taskId);
    assert.match(dock.show(rec.id).lastError ?? "", /expired/i);
  } finally {
    dock.close();
    await fx.stop();
  }
});

test("unavailable server is retained", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: "gone-server",
    });
    await fx.stop();
    await assert.rejects(() => dock.getNative(rec.id), ServerUnavailableError);
    const shown = dock.show(rec.id);
    assert.equal(shown.id, rec.id);
    assert.match(shown.lastError ?? "", /unavailable/i);
    assert.equal(shown.lastSeenAt, shown.createdAt);
  } finally {
    dock.close();
  }
});

test("CLI get and cancel use TaskDock ids, not native ids", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  try {
    const added = await runCli(
      ["server", "add", fx.profile.id, "--http", fx.url],
      db,
    );
    assert.equal(added.code, 0, added.stderr);
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "cli-cancel", delayMs: 8_000 },
      { client },
    );
    const registered = await runCli(
      [
        "register",
        "--server",
        fx.profile.id,
        "--task-id",
        created.taskId,
        "--source-client",
        "codex",
      ],
      db,
    );
    assert.equal(registered.code, 0, registered.stderr);
    assert.match(registered.stdout, /registered td_01/);
    const shown = await runCli(["show", "td_01", "--json"], db);
    assert.equal(shown.code, 0, shown.stderr);
    const cached = JSON.parse(shown.stdout) as {
      metadata?: { serverInfo?: { name?: string } };
    };
    assert.equal(cached.metadata?.serverInfo?.name, "taskdock-fixture");

    const listed = await runCli(["list"], db);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /NATIVE/);
    assert.match(listed.stdout, /codex/);

    const got = await runCli(["get", "td_01", "--json"], db);
    assert.equal(got.code, 0, got.stderr);
    const payload = JSON.parse(got.stdout) as {
      id: string;
      nativeTaskId: string;
      task: { taskId: string; status: string };
    };
    assert.equal(payload.id, "td_01");
    assert.equal(payload.nativeTaskId, created.taskId);
    assert.equal(payload.task.taskId, created.taskId);

    const cancelled = await runCli(["cancel", "td_01", "--json"], db);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    const cancelPayload = JSON.parse(cancelled.stdout) as {
      task?: { status: string };
    };
    assert.equal(cancelPayload.task?.status, "cancelled");

    const listedFiltered = await runCli(
      ["list", "--server", fx.profile.id, "--status", "cancelled"],
      db,
    );
    assert.equal(listedFiltered.code, 0, listedFiltered.stderr);
    assert.match(listedFiltered.stdout, /td_01/);
    const listedMiss = await runCli(["list", "--status", "working"], db);
    assert.equal(listedMiss.code, 0, listedMiss.stderr);
    assert.match(listedMiss.stdout, /\(none\)/);
  } finally {
    await fx.stop();
  }
});

test("cancel keeps the ack when the follow-up get cannot observe", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "vanish", delayMs: 8_000, vanishOnAck: true },
      { client },
    );
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
    });
    const before = dock.show(rec.id).lastSeenAt;
    const result = await dock.cancelNative(rec.id);
    assert.equal(result.ack?.resultType, "complete");
    assert.equal(result.task, undefined);
    assert.match(result.warning ?? "", /not found/i);
    const shown = dock.show(rec.id);
    assert.equal(shown.id, rec.id);
    assert.equal(shown.lastSeenAt, before);
    assert.match(shown.lastError ?? "", /not found/i);
  } finally {
    dock.close();
    await fx.stop();
  }
});

test("cancel keeps the ack when the follow-up get is expired", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "expire-after", delayMs: 8_000, expireOnAck: true },
      { client },
    );
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
    });
    const result = await dock.cancelNative(rec.id);
    assert.equal(result.ack?.resultType, "complete");
    assert.match(result.warning ?? "", /expired/i);
    assert.match(dock.show(rec.id).lastError ?? "", /expired/i);
  } finally {
    dock.close();
    await fx.stop();
  }
});

test("identity mismatch warns on get and cancel without dropping the row", async () => {
  const fx = await startFixture({ binding: "independent", name: "demo" });
  const db = tempDb();
  const dock = new TaskDock(db);
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "ident", delayMs: 4_000 },
      { client },
    );
    dock.addServer(fx.profile);
    const rec = dock.register({
      serverProfileId: fx.profile.id,
      taskHandle: created.taskId,
      metadata: { serverInfo: { name: "other-server", version: "0.0.1" } },
    });
    const got = await dock.getNative(rec.id);
    assert.match(got.warning ?? "", /identity differs/i);
    assert.equal(dock.show(rec.id).id, rec.id);
    const cancelled = await dock.cancelNative(rec.id);
    assert.match(cancelled.warning ?? "", /identity differs/i);
    assert.equal(dock.show(rec.id).id, rec.id);
  } finally {
    dock.close();
    await fx.stop();
  }
});

test("invalid --input-responses is rejected", async () => {
  const db = tempDb();
  const added = await runCli(
    ["server", "add", "demo", "--http", "http://127.0.0.1:1/mcp"],
    db,
  );
  assert.equal(added.code, 0, added.stderr);
  const registered = await runCli(
    ["register", "--server", "demo", "--task-id", "t1"],
    db,
  );
  assert.equal(registered.code, 0, registered.stderr);
  const bad = await runCli(
    ["update", "td_01", "--input-responses", "not-json"],
    db,
  );
  assert.notEqual(bad.code, 0);
  assert.match(`${bad.stderr}\n${bad.stdout}`, /invalid --input-responses JSON/);
});
