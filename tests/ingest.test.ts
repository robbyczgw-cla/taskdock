import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { TaskDock } from "../src/taskdock.ts";
import { parseObservedTask } from "../src/ingest/parse.ts";
import { callToolTask } from "../src/mcp/client.ts";
import { startFixture, tempDb } from "./helpers.ts";

const repoRoot = join(import.meta.dirname, "..");
const ctx = { serverProfileId: "demo", sourceClient: "hook" };

function runCli(
  args: string[],
  db: string,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, TASKDOCK_DB: db },
        stdio: ["pipe", "pipe", "pipe"],
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
    if (stdin !== undefined) proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

test("parse raw CreateTaskResult", () => {
  const parsed = parseObservedTask(
    { resultType: "task", taskId: "native-123", status: "working", ttlMs: 600000 },
    ctx,
  );
  assert.equal(parsed.kind, "task");
  if (parsed.kind === "task") {
    assert.equal(parsed.observed.nativeTaskId, "native-123");
    assert.equal(parsed.observed.status, "working");
    assert.equal(parsed.observed.ttlMs, 600000);
  }
});

test("parse JSON-RPC CreateTaskResult envelope", () => {
  const parsed = parseObservedTask(
    {
      jsonrpc: "2.0",
      id: 12,
      result: { resultType: "task", taskId: "native-123", status: "working" },
    },
    ctx,
  );
  assert.equal(parsed.kind, "task");
  if (parsed.kind === "task") {
    assert.equal(parsed.observed.nativeTaskId, "native-123");
  }
});

test("ordinary tool result is ignored", () => {
  const parsed = parseObservedTask(
    { resultType: "complete", content: [{ type: "text", text: "hi" }] },
    ctx,
  );
  assert.equal(parsed.kind, "ignored");
});

test("resultType task without taskId is invalid", () => {
  const parsed = parseObservedTask({ resultType: "task", status: "working" }, ctx);
  assert.equal(parsed.kind, "invalid");
});

test("empty taskId is invalid", () => {
  const parsed = parseObservedTask({ resultType: "task", taskId: "" }, ctx);
  assert.equal(parsed.kind, "invalid");
});

test("ingest unknown server is rejected", () => {
  const dock = new TaskDock(tempDb());
  assert.throws(
    () =>
      dock.ingest({
        serverProfileId: "missing",
        nativeTaskId: "n1",
      }),
    /Unknown server profile/,
  );
  dock.close();
});

test("repeated ingest is idempotent and may update status/ttl", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const first = dock.ingest({
    serverProfileId: "demo",
    nativeTaskId: "same-native",
    status: "working",
    ttlMs: 1000,
    sourceClient: "client-a",
  });
  assert.equal(first.created, true);
  const second = dock.ingest({
    serverProfileId: "demo",
    nativeTaskId: "same-native",
    status: "completed",
    ttlMs: 2000,
  });
  assert.equal(second.created, false);
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.status, "completed");
  assert.equal(second.record.ttlMs, 2000);
  assert.equal(second.record.sourceClient, "client-a");
  assert.equal(second.record.createdAt, first.record.createdAt);
  assert.equal(dock.list().length, 1);
  dock.close();
});

test("ingest does not clear lastError", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const first = dock.ingest({
    serverProfileId: "demo",
    nativeTaskId: "n1",
    status: "working",
  });
  dock.registry.recordError(first.record.id, "Native task expired: n1");
  const again = dock.ingest({
    serverProfileId: "demo",
    nativeTaskId: "n1",
    status: "working",
  });
  assert.equal(again.record.lastError, "Native task expired: n1");
  dock.close();
});

test("same native id on two servers is two rows", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "s1",
    name: "s1",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  dock.addServer({
    id: "s2",
    name: "s2",
    transport: { type: "http", url: "http://127.0.0.1:2/mcp" },
  });
  const a = dock.ingest({ serverProfileId: "s1", nativeTaskId: "shared" });
  const b = dock.ingest({ serverProfileId: "s2", nativeTaskId: "shared" });
  assert.notEqual(a.record.id, b.record.id);
  assert.equal(dock.list().length, 2);
  dock.close();
});

test("raw tool payload is not persisted", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const parsed = parseObservedTask(
    {
      resultType: "task",
      taskId: "n-secret-payload",
      status: "working",
      result: { content: [{ type: "text", text: "user private content" }] },
      arguments: { token: "sk-live-not-for-disk" },
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "fx", version: "1" },
      },
    },
    ctx,
  );
  assert.equal(parsed.kind, "task");
  if (parsed.kind !== "task") return;
  const rec = dock.ingest(parsed.observed).record;
  const blob = JSON.stringify(rec);
  assert.equal(blob.includes("user private content"), false);
  assert.equal(blob.includes("sk-live-not-for-disk"), false);
  assert.equal(rec.metadata?.serverInfo && (rec.metadata.serverInfo as { name: string }).name, "fx");
  dock.close();
});

test("ingest does not persist caller metadata that register would keep", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const rec = dock.ingest({
    serverProfileId: "demo",
    nativeTaskId: "n1",
    metadata: {
      serverInfo: { name: "fx", version: "1", leak: "nope" },
      prompt: "secret user text",
    },
  });
  assert.deepEqual(rec.record.metadata, {
    serverInfo: { name: "fx", version: "1" },
  });
  dock.close();
});

test("concurrent ingest of the same native task is one row", async () => {
  const path = tempDb();
  const setup = new TaskDock(path);
  setup.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  setup.close();

  await Promise.all(
    [1, 2, 3].map(async () => {
      const dock = new TaskDock(path);
      dock.ingest({
        serverProfileId: "demo",
        nativeTaskId: "race-me",
        status: "working",
      });
      dock.close();
    }),
  );

  const check = new TaskDock(path);
  assert.equal(check.list().length, 1);
  assert.equal(check.list()[0]?.taskHandle, "race-me");
  check.close();
});

test("CLI ingest unknown server fails", async () => {
  const db = tempDb();
  const result = await runCli(
    [
      "ingest",
      "--server",
      "missing",
      "--payload",
      JSON.stringify({ resultType: "task", taskId: "n1", status: "working" }),
    ],
    db,
  );
  assert.notEqual(result.code, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Unknown server profile/);
});

test("CLI stdin ingest from a fresh process", async () => {
  const db = tempDb();
  const added = await runCli(
    ["server", "add", "demo", "--http", "http://127.0.0.1:1/mcp"],
    db,
  );
  assert.equal(added.code, 0, added.stderr);
  const ingested = await runCli(
    ["ingest", "--server", "demo", "--source-client", "hook", "--stdin", "--json"],
    db,
    JSON.stringify({
      resultType: "task",
      taskId: "from-stdin",
      status: "working",
    }),
  );
  assert.equal(ingested.code, 0, ingested.stderr);
  const body = JSON.parse(ingested.stdout) as {
    id: string;
    created: boolean;
    server: string;
  };
  assert.equal(body.created, true);
  assert.equal(body.server, "demo");
  assert.equal(body.id, "td_01");
  assert.equal(ingested.stdout.includes("from-stdin"), false);

  const again = await runCli(
    ["ingest", "--server", "demo", "--source-client", "hook", "--payload", JSON.stringify({ resultType: "task", taskId: "from-stdin", status: "working" }), "--json"],
    db,
  );
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).created, false);

  const ignored = await runCli(
    ["ingest", "--server", "demo", "--stdin", "--json"],
    db,
    JSON.stringify({ resultType: "complete", content: [] }),
  );
  assert.equal(ignored.code, 0, ignored.stderr);
  assert.equal(JSON.parse(ignored.stdout).ignored, true);
});

test("process A ingest then process B native get", async () => {
  const fx = await startFixture({ binding: "independent" });
  const db = tempDb();
  try {
    const created = await callToolTask(
      fx.profile,
      "slow_echo",
      { message: "handoff-ingest", delayMs: 400 },
      { client: { name: "client-a" } },
    );
    const add = await runCli(
      ["server", "add", fx.profile.id, "--http", fx.url],
      db,
    );
    assert.equal(add.code, 0, add.stderr);
    const ingested = await runCli(
      [
        "ingest",
        "--server",
        fx.profile.id,
        "--source-client",
        "client-a",
        "--payload",
        JSON.stringify({
          resultType: "task",
          taskId: created.taskId,
          status: created.status,
        }),
      ],
      db,
    );
    assert.equal(ingested.code, 0, ingested.stderr);
    assert.match(ingested.stdout, /registered td_01/);

    const listed = await runCli(["list"], db);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /td_01/);

    const got = await runCli(["get", "td_01", "--json"], db);
    assert.equal(got.code, 0, got.stderr);
    const payload = JSON.parse(got.stdout) as {
      nativeTaskId: string;
      task: { taskId: string };
    };
    assert.equal(payload.nativeTaskId, created.taskId);
    assert.equal(payload.task.taskId, created.taskId);
  } finally {
    await fx.stop();
  }
});
