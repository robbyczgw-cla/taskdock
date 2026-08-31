import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TaskDock } from "../src/taskdock.ts";
import { tempDb } from "./helpers.ts";

test("register, retrieve, list", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:3333/mcp" },
  });
  const rec = dock.register({
    serverProfileId: "demo",
    taskHandle: "abc123",
    sourceClient: "client-a",
    status: "working",
  });
  assert.equal(rec.id, "td_01");
  assert.equal(rec.taskHandle, "abc123");
  assert.equal(dock.show("td_01").taskHandle, "abc123");
  assert.equal(dock.list().length, 1);
  const ref = dock.resolve("td_01");
  assert.equal(ref.serverProfile.transport.type, "http");
  dock.close();
});

test("persist across db reopen", () => {
  const path = tempDb();
  const a = new TaskDock(path);
  a.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  a.register({ serverProfileId: "demo", taskHandle: "persist-me" });
  a.close();

  const b = new TaskDock(path);
  assert.equal(b.list().length, 1);
  assert.equal(b.show("td_01").taskHandle, "persist-me");
  b.close();
});

test("same handle on different servers is allowed", () => {
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
  const a = dock.register({ serverProfileId: "s1", taskHandle: "same" });
  const b = dock.register({ serverProfileId: "s2", taskHandle: "same" });
  assert.notEqual(a.id, b.id);
  assert.equal(dock.list().length, 2);
  dock.close();
});

test("same handle on same server upserts", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const a = dock.register({
    serverProfileId: "demo",
    taskHandle: "h1",
    status: "working",
  });
  const b = dock.register({
    serverProfileId: "demo",
    taskHandle: "h1",
    status: "completed",
  });
  assert.equal(a.id, b.id);
  assert.equal(b.status, "completed");
  assert.equal(dock.list().length, 1);
  dock.close();
});

test("invalid server reference fails", () => {
  const dock = new TaskDock(tempDb());
  assert.throws(
    () =>
      dock.register({
        serverProfileId: "missing",
        taskHandle: "x",
      }),
    /Unknown server profile/,
  );
  dock.close();
});

test("opaque handles stored verbatim", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const handles = [
    "cfth1:....",
    "opaque_random_blob",
    "backend/task/123",
    "a+b=c/d:e",
    "任务-äöü",
    "x".repeat(400),
  ];
  for (const h of handles) {
    const rec = dock.register({ serverProfileId: "demo", taskHandle: h });
    assert.equal(rec.taskHandle, h);
    assert.equal(dock.show(rec.id).taskHandle, h);
  }
  dock.close();
});

test("removeServer fails while tasks exist", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  dock.register({ serverProfileId: "demo", taskHandle: "h1" });
  assert.throws(() => dock.removeServer("demo"), /still reference/);
  assert.equal(dock.getServer("demo")?.id, "demo");
  assert.equal(dock.list().length, 1);
  dock.close();
});

test("removeServer succeeds when no tasks reference it", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  dock.removeServer("demo");
  assert.equal(dock.getServer("demo"), undefined);
  assert.equal(dock.listServers().length, 0);
  dock.close();
});

test("addServer stores env:VAR and rejects a literal credential", () => {
  const dock = new TaskDock(tempDb());
  const stored = dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
    authProfile: "env:TASKDOCK_AUTH_TOKEN",
  });
  assert.equal(stored.authProfile, "env:TASKDOCK_AUTH_TOKEN");
  assert.throws(
    () =>
      dock.addServer({
        id: "bad",
        name: "bad",
        transport: { type: "http", url: "http://127.0.0.1:2/mcp" },
        authProfile: "literal-demo-credential",
      }),
    /env:VAR|does not store credential/,
  );
  assert.equal(dock.getServer("bad"), undefined);
  dock.close();
});

test("list filters by server, status, and active", () => {
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
  dock.register({
    serverProfileId: "s1",
    taskHandle: "a",
    status: "working",
  });
  dock.register({
    serverProfileId: "s1",
    taskHandle: "b",
    status: "completed",
  });
  dock.register({
    serverProfileId: "s2",
    taskHandle: "c",
    status: "working",
  });
  assert.equal(dock.list({ server: "s1" }).length, 2);
  assert.equal(dock.list({ status: "working" }).length, 2);
  assert.equal(dock.list({ active: true }).length, 2);
  assert.equal(dock.list({ server: "s1", status: "completed" }).length, 1);
  dock.close();
});

test("addServer refuses identity change while tasks exist", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  dock.register({ serverProfileId: "demo", taskHandle: "h1" });
  assert.throws(
    () =>
      dock.addServer({
        id: "demo",
        name: "demo",
        transport: { type: "http", url: "http://127.0.0.1:9/mcp" },
      }),
    /Cannot change server demo/,
  );
  const kept = dock.getServer("demo");
  assert.equal(kept?.transport.type, "http");
  if (kept?.transport.type === "http") {
    assert.equal(kept.transport.url, "http://127.0.0.1:1/mcp");
  }
  dock.addServer({
    id: "demo",
    name: "renamed",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  assert.equal(dock.getServer("demo")?.name, "renamed");
  dock.close();
});

test("re-register does not clear a retained last_error", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const rec = dock.register({
    serverProfileId: "demo",
    taskHandle: "h1",
    status: "working",
  });
  dock.registry.recordError(rec.id, "Native task expired: h1");
  const again = dock.register({
    serverProfileId: "demo",
    taskHandle: "h1",
    sourceClient: "client-a",
  });
  assert.equal(again.id, rec.id);
  assert.equal(again.lastError, "Native task expired: h1");
  assert.equal(again.sourceClient, "client-a");
  dock.close();
});

test("fingerprint is stable and omits secrets", () => {
  const dock = new TaskDock(tempDb());
  const a = dock.addServer({
    id: "one",
    name: "display-one",
    transport: { type: "http", url: "http://user:secret@127.0.0.1:9/mcp/" },
    authProfile: "env:TASKDOCK_AUTH_TOKEN",
  });
  const b = dock.addServer({
    id: "two",
    name: "display-two",
    transport: { type: "http", url: "HTTP://127.0.0.1:9/mcp" },
    authProfile: "env:TASKDOCK_AUTH_TOKEN",
  });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.ok(a.fingerprint && a.fingerprint.length === 64);
  assert.equal(a.transport.type, "http");
  if (a.transport.type === "http") {
    assert.equal(a.transport.url.includes("secret"), false);
    assert.equal(a.transport.url.includes("user:"), false);
  }
  const raw = JSON.stringify(a);
  assert.equal(raw.includes("secret"), false);
  dock.close();
});

test("label round-trips", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  const rec = dock.register({
    serverProfileId: "demo",
    taskHandle: "h1",
    label: "review-pr",
  });
  assert.equal(rec.label, "review-pr");
  assert.equal(dock.show(rec.id).label, "review-pr");
  dock.close();
});

test("openDatabase upgrades a prior schema and backfills fingerprints", () => {
  const path = tempDb();
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE server_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport_json TEXT NOT NULL,
      auth_profile TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      task_handle TEXT NOT NULL,
      server_profile_id TEXT NOT NULL,
      protocol_version TEXT,
      extension_version TEXT,
      status TEXT,
      source_client TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY(server_profile_id) REFERENCES server_profiles(id)
    );
  `);
  old
    .prepare(
      `INSERT INTO server_profiles (id, name, transport_json, auth_profile)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      "demo",
      "demo",
      JSON.stringify({ type: "http", url: "http://127.0.0.1:1/mcp" }),
      null,
    );
  old.close();

  const dock = new TaskDock(path);
  const server = dock.getServer("demo");
  assert.ok(server?.fingerprint);
  assert.equal(server.fingerprint?.length, 64);
  const rec = dock.register({
    serverProfileId: "demo",
    taskHandle: "upgraded",
    label: "ok",
  });
  assert.equal(rec.label, "ok");
  dock.close();
});
