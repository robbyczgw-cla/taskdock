import type {
  RegisterTaskInput,
  ServerProfile,
  TaskRecord,
  Transport,
} from "../types.ts";
import type { Database } from "./db.ts";

type ProfileRow = {
  id: string;
  name: string;
  transport_json: string;
  auth_profile: string | null;
};

type TaskRow = {
  id: string;
  task_handle: string;
  server_profile_id: string;
  protocol_version: string | null;
  extension_version: string | null;
  status: string | null;
  source_client: string | null;
  label?: string | null;
  created_at: string;
  last_seen_at: string;
  metadata_json: string | null;
};

function profileFromRow(row: ProfileRow): ServerProfile {
  return {
    id: row.id,
    name: row.name,
    transport: JSON.parse(row.transport_json) as Transport,
    authProfile: row.auth_profile ?? undefined,
  };
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    taskHandle: row.task_handle,
    serverProfileId: row.server_profile_id,
    protocolVersion: row.protocol_version ?? undefined,
    taskExtensionVersion: row.extension_version ?? undefined,
    status: row.status ?? undefined,
    sourceClient: row.source_client ?? undefined,
    label: row.label ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : undefined,
  };
}

function nextTaskId(db: Database): string {
  const row = db
    .prepare(
      `SELECT id FROM tasks WHERE id LIKE 'td_%' ORDER BY length(id) DESC, id DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  let n = 1;
  if (row?.id) {
    const parsed = Number.parseInt(row.id.slice(3), 10);
    if (Number.isFinite(parsed)) n = parsed + 1;
  }
  return `td_${String(n).padStart(2, "0")}`;
}

export class Registry {
  constructor(private readonly db: Database) {}

  addServer(profile: ServerProfile): ServerProfile {
    this.db
      .prepare(
        `INSERT INTO server_profiles (id, name, transport_json, auth_profile)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           transport_json = excluded.transport_json,
           auth_profile = excluded.auth_profile`,
      )
      .run(
        profile.id,
        profile.name,
        JSON.stringify(profile.transport),
        profile.authProfile ?? null,
      );
    return this.getServer(profile.id)!;
  }

  getServer(id: string): ServerProfile | undefined {
    const row = this.db
      .prepare(`SELECT * FROM server_profiles WHERE id = ?`)
      .get(id) as ProfileRow | undefined;
    return row ? profileFromRow(row) : undefined;
  }

  listServers(): ServerProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM server_profiles ORDER BY name`)
      .all() as ProfileRow[];
    return rows.map(profileFromRow);
  }

  removeServer(id: string): void {
    const server = this.getServer(id);
    if (!server) {
      throw new Error(`Unknown server profile: ${id}`);
    }
    const n = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE server_profile_id = ?`)
      .get(id) as { n: number };
    if (n.n > 0) {
      throw new Error(
        `Cannot remove server ${id}: ${n.n} task(s) still reference it`,
      );
    }
    this.db.prepare(`DELETE FROM server_profiles WHERE id = ?`).run(id);
  }

  register(input: RegisterTaskInput): TaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.registerLocked(input);
      this.db.exec("COMMIT");
      return record;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private registerLocked(input: RegisterTaskInput): TaskRecord {
    const server = this.getServer(input.serverProfileId);
    if (!server) {
      throw new Error(
        `Unknown server profile: ${input.serverProfileId}. Add it with: taskdock server add`,
      );
    }
    if (input.taskHandle.length === 0) {
      throw new Error("task handle must be a non-empty opaque string");
    }

    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM tasks WHERE server_profile_id = ? AND task_handle = ?`,
      )
      .get(input.serverProfileId, input.taskHandle) as TaskRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE tasks SET
             last_seen_at = ?,
             status = COALESCE(?, status),
             source_client = COALESCE(?, source_client),
             label = COALESCE(?, label),
             protocol_version = COALESCE(?, protocol_version),
             extension_version = COALESCE(?, extension_version),
             metadata_json = COALESCE(?, metadata_json)
           WHERE id = ?`,
        )
        .run(
          now,
          input.status ?? null,
          input.sourceClient ?? null,
          input.label ?? null,
          input.protocolVersion ?? null,
          input.taskExtensionVersion ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          existing.id,
        );
      return this.get(existing.id)!;
    }

    const id = nextTaskId(this.db);
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, task_handle, server_profile_id,
           protocol_version, extension_version, status, source_client, label,
           created_at, last_seen_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskHandle,
        input.serverProfileId,
        input.protocolVersion ?? null,
        input.taskExtensionVersion ?? null,
        input.status ?? null,
        input.sourceClient ?? null,
        input.label ?? null,
        now,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
    return this.get(id)!;
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  findByHandle(
    serverProfileId: string,
    taskHandle: string,
  ): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE server_profile_id = ? AND task_handle = ?`,
      )
      .get(serverProfileId, taskHandle) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  list(): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at`)
      .all() as TaskRow[];
    return rows.map(taskFromRow);
  }

  touch(id: string, status?: string): TaskRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET last_seen_at = ?, status = COALESCE(?, status) WHERE id = ?`,
      )
      .run(now, status ?? null, id);
    const updated = this.get(id);
    if (!updated) throw new Error(`Unknown task: ${id}`);
    return updated;
  }
}
