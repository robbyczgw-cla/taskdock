import { defaultDbPath, openDatabase, type Database } from "./registry/db.js";
import { Registry } from "./registry/repository.js";
import { normalizeAuthProfile } from "./server-profiles/profiles.js";
import type {
  RegisterTaskInput,
  ServerProfile,
  TaskRecord,
  TaskRef,
} from "./types.js";

/** Tiny library API. Does not open MCP connections. */
export class TaskDock {
  readonly registry: Registry;
  readonly db: Database;
  readonly dbPath: string;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? defaultDbPath();
    this.dbPath = resolved;
    this.db = openDatabase(resolved);
    this.registry = new Registry(this.db);
  }

  addServer(profile: ServerProfile): ServerProfile {
    return this.registry.addServer({
      ...profile,
      authProfile: normalizeAuthProfile(profile.authProfile),
    });
  }

  listServers(): ServerProfile[] {
    return this.registry.listServers();
  }

  getServer(id: string): ServerProfile | undefined {
    return this.registry.getServer(id);
  }

  removeServer(id: string): void {
    this.registry.removeServer(id);
  }

  show(id: string): TaskRecord {
    const record = this.registry.get(id);
    if (!record) {
      throw new Error(`Unknown TaskDock id: ${id}`);
    }
    return record;
  }

  register(input: RegisterTaskInput): TaskRecord {
    return this.registry.register(input);
  }

  list(): TaskRecord[] {
    return this.registry.list();
  }

  resolve(id: string): TaskRef {
    const record = this.show(id);
    const serverProfile = this.registry.getServer(record.serverProfileId);
    if (!serverProfile) {
      throw new Error(
        `Task ${id} references missing server profile ${record.serverProfileId}`,
      );
    }
    return { id, taskHandle: record.taskHandle, serverProfile, record };
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore
    }
    this.db.close();
  }
}
