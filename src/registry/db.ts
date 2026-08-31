import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";

export type Database = DatabaseSync;

export function defaultDataDir(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "taskdock");
  }
  if (process.platform === "linux") {
    return join(home, ".local", "share", "taskdock");
  }
  return join(home, ".taskdock");
}

export function defaultDbPath(): string {
  if (process.env.TASKDOCK_DB) return process.env.TASKDOCK_DB;
  return join(defaultDataDir(), "taskdock.sqlite");
}

function chmodQuiet(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // ignore
  }
}

function ensureColumn(
  db: Database,
  table: "tasks" | "server_profiles",
  column: string,
  type: "TEXT" | "INTEGER",
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

export function openDatabase(path = defaultDbPath()): Database {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(dir, 0o700);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  ensureColumn(db, "tasks", "label", "TEXT");
  ensureColumn(db, "tasks", "ttl_ms", "INTEGER");
  ensureColumn(db, "tasks", "last_error", "TEXT");
  ensureColumn(db, "server_profiles", "fingerprint", "TEXT");
  chmodQuiet(path, 0o600);
  for (const extra of [path + "-wal", path + "-shm"]) {
    if (existsSync(extra)) chmodQuiet(extra, 0o600);
  }
  return db;
}
