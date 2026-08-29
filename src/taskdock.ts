import { openDatabase, type Database } from "./registry/db.ts";
import { Registry } from "./registry/repository.ts";
import type {
  RegisterTaskInput,
  ServerProfile,
  TaskRecord,
  TaskRef,
} from "./types.ts";

/** Tiny library API. Does not open MCP connections. */
export class TaskDock {
  readonly registry: Registry;
  readonly db: Database;
  readonly dbPath: string;

  constructor(dbPath?: string) {
    this.db = openDatabase(dbPath);
    this.dbPath = dbPath ?? process.env.TASKDOCK_DB ?? "(default)";
    this.registry = new Registry(this.db);
  }

  addServer(profile: ServerProfile): ServerProfile {
    return this.registry.addServer(profile);
  }

  listServers(): ServerProfile[] {
    return this.registry.listServers();
  }

  getServer(id: string): ServerProfile | undefined {
    return this.registry.getServer(id);
  }

  register(input: RegisterTaskInput): TaskRecord {
    return this.registry.register(input);
  }

  list(): TaskRecord[] {
    return this.registry.list();
  }

  show(id: string): TaskRecord {
    const record = this.registry.get(id);
    if (!record) throw new Error(`Unknown TaskDock id: ${id}`);
    return record;
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
