import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export type FixtureMode = "independent" | "session";

export type StoredTask = {
  taskId: string;
  sessionId: string | null;
  status: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  message: string;
  delayMs: number;
  completeAt: string;
  resultJson: string | null;
  errorJson: string | null;
  cancelled: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  session_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  ttl_ms INTEGER,
  poll_interval_ms INTEGER NOT NULL,
  message TEXT NOT NULL,
  delay_ms INTEGER NOT NULL,
  complete_at TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0
);
`;

export class TaskStore {
  private readonly db: DatabaseSync;
  readonly mode: FixtureMode;
  readonly authToken: string | undefined;

  constructor(path: string, mode: FixtureMode, authToken?: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.mode = mode;
    this.authToken = authToken;
  }

  create(opts: {
    taskId?: string;
    sessionId?: string | null;
    message: string;
    delayMs: number;
    ttlMs: number | null;
    pollIntervalMs: number;
  }): StoredTask {
    const now = new Date();
    const taskId = opts.taskId ?? `task_${randomBytes(8).toString("hex")}`;
    const completeAt = new Date(now.getTime() + opts.delayMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (
           task_id, session_id, status, created_at, last_updated_at,
           ttl_ms, poll_interval_ms, message, delay_ms, complete_at,
           result_json, error_json, cancelled
         ) VALUES (?, ?, 'working', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
      )
      .run(
        taskId,
        opts.sessionId ?? null,
        now.toISOString(),
        now.toISOString(),
        opts.ttlMs,
        opts.pollIntervalMs,
        opts.message,
        opts.delayMs,
        completeAt,
      );
    return this.getRaw(taskId)!;
  }

  getRaw(taskId: string): StoredTask | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as
      | {
          task_id: string;
          session_id: string | null;
          status: string;
          created_at: string;
          last_updated_at: string;
          ttl_ms: number | null;
          poll_interval_ms: number;
          message: string;
          delay_ms: number;
          complete_at: string;
          result_json: string | null;
          error_json: string | null;
          cancelled: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      sessionId: row.session_id,
      status: row.status,
      createdAt: row.created_at,
      lastUpdatedAt: row.last_updated_at,
      ttlMs: row.ttl_ms,
      pollIntervalMs: row.poll_interval_ms,
      message: row.message,
      delayMs: row.delay_ms,
      completeAt: row.complete_at,
      resultJson: row.result_json,
      errorJson: row.error_json,
      cancelled: row.cancelled,
    };
  }

  cancel(taskId: string): StoredTask | undefined {
    const task = this.materialize(taskId);
    if (!task) return undefined;
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      return task;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'cancelled', cancelled = 1, last_updated_at = ? WHERE task_id = ?`,
      )
      .run(now, taskId);
    return this.getRaw(taskId);
  }

  /** Apply time-based completion and expiry. */
  materialize(taskId: string): StoredTask | undefined {
    const task = this.getRaw(taskId);
    if (!task) return undefined;
    const now = Date.now();
    if (task.ttlMs != null) {
      const created = Date.parse(task.createdAt);
      if (now > created + task.ttlMs) {
        return { ...task, status: "expired" };
      }
    }
    if (
      task.status === "working" &&
      !task.cancelled &&
      now >= Date.parse(task.completeAt)
    ) {
      const result = {
        content: [{ type: "text", text: task.message }],
        isError: false,
      };
      const iso = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE tasks SET status = 'completed', result_json = ?, last_updated_at = ? WHERE task_id = ?`,
        )
        .run(JSON.stringify(result), iso, taskId);
      return this.getRaw(taskId);
    }
    return task;
  }

  close(): void {
    this.db.close();
  }
}
