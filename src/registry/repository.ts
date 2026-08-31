import type {
  RegisterTaskInput,
  ServerProfile,
  TaskRecord,
  Transport,
} from "../types.ts";
import type { IngestResult } from "../ingest/types.js";
import { pickSafeMetadata } from "../ingest/metadata.js";
import type { Database } from "./db.ts";
import {
  sanitizeTransport,
  serverFingerprint,
} from "../server-profiles/fingerprint.js";
import { normalizeAuthProfile } from "../server-profiles/profiles.js";

type ProfileRow = {
  id: string;
  name: string;
  transport_json: string;
  auth_profile: string | null;
  fingerprint?: string | null;
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
  ttl_ms?: number | null;
  last_error?: string | null;
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
    fingerprint: row.fingerprint ?? undefined,
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
    ttlMs: row.ttl_ms === undefined || row.ttl_ms === null ? undefined : row.ttl_ms,
    lastError: row.last_error ?? undefined,
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
  constructor(private readonly db: Database) {
    this.sanitizeStoredProfiles();
  }

  private sanitizeStoredProfiles(): void {
    const rows = this.db
      .prepare(`SELECT * FROM server_profiles`)
      .all() as ProfileRow[];
    const update = this.db.prepare(
      `UPDATE server_profiles SET transport_json = ?, auth_profile = ?, fingerprint = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const profile = profileFromRow(row);
      const transport = sanitizeTransport(profile.transport);
      let authProfile: string | undefined;
      try {
        authProfile = normalizeAuthProfile(profile.authProfile);
      } catch {
        authProfile = undefined;
      }
      const fingerprint = serverFingerprint({ transport, authProfile });
      const transportJson = JSON.stringify(transport);
      if (
        transportJson !== row.transport_json ||
        (row.auth_profile ?? null) !== (authProfile ?? null) ||
        row.fingerprint !== fingerprint
      ) {
        update.run(transportJson, authProfile ?? null, fingerprint, row.id);
      }
    }
  }

  private taskCount(serverProfileId: string): number {
    const n = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE server_profile_id = ?`)
      .get(serverProfileId) as { n: number };
    return n.n;
  }

  addServer(profile: ServerProfile): ServerProfile {
    const transport = sanitizeTransport(profile.transport);
    const authProfile = normalizeAuthProfile(profile.authProfile);
    const fingerprint = serverFingerprint({
      transport,
      authProfile,
    });
    const existing = this.getServer(profile.id);
    if (existing && existing.fingerprint && existing.fingerprint !== fingerprint) {
      const n = this.taskCount(profile.id);
      if (n > 0) {
        throw new Error(
          `Cannot change server ${profile.id}: ${n} task(s) still reference it. Add a new profile id instead.`,
        );
      }
    }
    this.db
      .prepare(
        `INSERT INTO server_profiles (id, name, transport_json, auth_profile, fingerprint)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           transport_json = excluded.transport_json,
           auth_profile = excluded.auth_profile,
           fingerprint = excluded.fingerprint`,
      )
      .run(
        profile.id,
        profile.name,
        JSON.stringify(transport),
        authProfile ?? null,
        fingerprint,
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
    const n = this.taskCount(id);
    if (n > 0) {
      throw new Error(
        `Cannot remove server ${id}: ${n} task(s) still reference it`,
      );
    }
    this.db.prepare(`DELETE FROM server_profiles WHERE id = ?`).run(id);
  }

  register(input: RegisterTaskInput): TaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.upsertLocked(input, "register").record;
      this.db.exec("COMMIT");
      return record;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  ingest(input: RegisterTaskInput): IngestResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.upsertLocked(input, "ingest");
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private upsertLocked(
    input: RegisterTaskInput,
    mode: "register" | "ingest",
  ): IngestResult {
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
    const metadataJson =
      mode === "ingest"
        ? pickSafeMetadata(input.metadata)
        : input.metadata;

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
             ttl_ms = COALESCE(?, ttl_ms)
           WHERE id = ?`,
        )
        .run(
          now,
          input.status ?? null,
          input.sourceClient ?? null,
          input.label ?? null,
          input.protocolVersion ?? null,
          input.taskExtensionVersion ?? null,
          input.ttlMs ?? null,
          existing.id,
        );
      if (mode === "register" && input.metadata) {
        this.db
          .prepare(`UPDATE tasks SET metadata_json = ? WHERE id = ?`)
          .run(JSON.stringify(input.metadata), existing.id);
      } else if (mode === "ingest" && metadataJson) {
        this.mergeMetadata(existing.id, metadataJson);
      }
      return { record: this.get(existing.id)!, created: false };
    }

    const id = nextTaskId(this.db);
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, task_handle, server_profile_id,
           protocol_version, extension_version, status, source_client, label,
           ttl_ms, last_error, created_at, last_seen_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
        input.ttlMs ?? null,
        now,
        now,
        metadataJson ? JSON.stringify(metadataJson) : null,
      );
    return { record: this.get(id)!, created: true };
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

  list(filter?: {
    server?: string;
    status?: string;
    active?: boolean;
  }): TaskRecord[] {
    let rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at`)
      .all() as TaskRow[];
    if (filter?.server) {
      rows = rows.filter((row) => row.server_profile_id === filter.server);
    }
    if (filter?.status) {
      rows = rows.filter((row) => row.status === filter.status);
    }
    const records = rows.map(taskFromRow);
    if (filter?.active) {
      return records.filter((record) => {
        const status = record.status;
        if (!status) return true;
        return status !== "completed" && status !== "failed" && status !== "cancelled";
      });
    }
    return records;
  }

  touch(
    id: string,
    status?: string,
    extras?: { ttlMs?: number | null; clearError?: boolean },
  ): TaskRecord {
    const now = new Date().toISOString();
    if (extras?.ttlMs !== undefined) {
      this.db
        .prepare(
          `UPDATE tasks SET last_seen_at = ?, status = COALESCE(?, status), ttl_ms = ?, last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE id = ?`,
        )
        .run(
          now,
          status ?? null,
          extras.ttlMs,
          extras.clearError ? 1 : 0,
          id,
        );
    } else {
      this.db
        .prepare(
          `UPDATE tasks SET last_seen_at = ?, status = COALESCE(?, status), last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE id = ?`,
        )
        .run(now, status ?? null, extras?.clearError ? 1 : 0, id);
    }
    const updated = this.get(id);
    if (!updated) throw new Error(`Unknown task: ${id}`);
    return updated;
  }

  recordError(id: string, message: string): void {
    this.db
      .prepare(`UPDATE tasks SET last_error = ? WHERE id = ?`)
      .run(message, id);
  }

  mergeMetadata(id: string, patch: Record<string, unknown>): TaskRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown task: ${id}`);
    const metadata = { ...(current.metadata ?? {}), ...patch };
    this.db
      .prepare(`UPDATE tasks SET metadata_json = ? WHERE id = ?`)
      .run(JSON.stringify(metadata), id);
    return this.get(id)!;
  }
}
