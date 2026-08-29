import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

export type Database = DatabaseSync;

export function defaultDbPath(): string {
  if (process.env.TASKDOCK_DB) return process.env.TASKDOCK_DB;
  return join(process.cwd(), "data", "taskdock.sqlite");
}

export function openDatabase(path = defaultDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}
