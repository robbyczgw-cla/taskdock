import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.throws(() => dock.removeServer("demo"), /task/i);
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

test("removeServer fails while tasks exist", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  dock.register({ serverProfileId: "demo", taskHandle: "h" });
  assert.throws(() => dock.removeServer("demo"), /still reference/);
  dock.close();
});

test("removeServer succeeds with no tasks", () => {
  const dock = new TaskDock(tempDb());
  dock.addServer({
    id: "demo",
    name: "demo",
    transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
  });
  dock.removeServer("demo");
  assert.equal(dock.getServer("demo"), undefined);
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
    taskHandle: "h",
    label: "nightly",
  });
  assert.equal(rec.label, "nightly");
  assert.equal(dock.show(rec.id).label, "nightly");
  dock.close();
});
