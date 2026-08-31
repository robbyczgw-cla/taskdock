import { defaultDbPath, openDatabase, type Database } from "./registry/db.js";
import { Registry } from "./registry/repository.js";
import { normalizeAuthProfile } from "./server-profiles/profiles.js";
import {
  cancelTask,
  connect,
  extractServerInfo,
  getTask,
  identityWarning,
  updateTask,
  type ConnectedClient,
} from "./mcp/client.js";
import {
  classifyControlError,
  ServerConfigRemovedError,
  TaskDockError,
} from "./mcp/errors.js";
import type {
  McpTask,
  RegisterTaskInput,
  ServerProfile,
  TaskRecord,
  TaskRef,
} from "./types.js";
import type { IngestResult, ObservedNativeTask } from "./ingest/types.js";
import { toRegisterInput } from "./ingest/types.js";

export type NativeControlResult = {
  ref: TaskRef;
  task?: McpTask;
  ack?: Record<string, unknown>;
  warning?: string;
};

const CLI_CLIENT = { name: "taskdock", version: "0.2.0" };

/** Local durable index. Control methods open a fresh MCP connection per call. */
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

  ingest(observed: ObservedNativeTask): IngestResult {
    if (!observed.nativeTaskId) {
      throw new Error("CreateTaskResult is missing a native taskId");
    }
    return this.registry.ingest(toRegisterInput(observed));
  }

  list(filter?: {
    server?: string;
    status?: string;
    active?: boolean;
  }): TaskRecord[] {
    return this.registry.list(filter);
  }

  resolve(id: string): TaskRef {
    const record = this.show(id);
    const serverProfile = this.registry.getServer(record.serverProfileId);
    if (!serverProfile) {
      throw new ServerConfigRemovedError(id, record.serverProfileId);
    }
    return { id, taskHandle: record.taskHandle, serverProfile, record };
  }

  private requireRef(id: string): TaskRef {
    this.show(id);
    try {
      return this.resolve(id);
    } catch (err) {
      if (err instanceof ServerConfigRemovedError) {
        this.registry.recordError(id, err.message);
      }
      throw err;
    }
  }

  /** Store serverInfo from discover when reachable. Does not fail registration. */
  async captureIdentity(id: string): Promise<void> {
    const ref = this.resolve(id);
    try {
      const connected = await connect(ref.serverProfile, CLI_CLIENT);
      this.rememberIdentity(id, connected.serverInfo);
    } catch {
      // leave unprobed
    }
  }

  private rememberIdentity(
    id: string,
    current: Record<string, unknown> | undefined,
  ): string | undefined {
    const recorded = this.show(id).metadata?.serverInfo as
      | Record<string, unknown>
      | undefined;
    if (!current || Object.keys(current).length === 0) {
      return undefined;
    }
    if (!recorded) {
      this.registry.mergeMetadata(id, { serverInfo: current });
      return undefined;
    }
    return identityWarning(recorded, current);
  }

  private rememberIdentityFromTask(id: string, task: McpTask): string | undefined {
    return this.rememberIdentity(id, extractServerInfo(task));
  }

  private observeAfterWrite(
    ref: TaskRef,
    ack: Record<string, unknown>,
    warning: string | undefined,
    read: () => Promise<McpTask>,
  ): Promise<NativeControlResult> {
    return read()
      .then((task) => {
        const observeWarning =
          this.rememberIdentityFromTask(ref.id, task) ?? warning;
        this.registry.touch(ref.id, task.status, {
          ttlMs: task.ttlMs,
          clearError: true,
        });
        return { ref: this.resolve(ref.id), ack, task, warning: observeWarning };
      })
      .catch((err) => {
        const classified = classifyControlError(
          err,
          ref.taskHandle,
          ref.serverProfile.id,
        );
        this.registry.recordError(ref.id, classified.message);
        const observeWarning = warning
          ? `${warning}\n${classified.message}`
          : classified.message;
        return { ref: this.resolve(ref.id), ack, warning: observeWarning };
      });
  }

  async getNative(id: string): Promise<NativeControlResult> {
    const ref = this.requireRef(id);
    return this.withNative(ref, async () => {
      const task = await getTask(ref.serverProfile, ref.taskHandle, {
        client: CLI_CLIENT,
      });
      const warning = this.rememberIdentityFromTask(ref.id, task);
      this.registry.touch(ref.id, task.status, {
        ttlMs: task.ttlMs,
        clearError: true,
      });
      return { ref: this.resolve(id), task, warning };
    });
  }

  async cancelNative(id: string): Promise<NativeControlResult> {
    const ref = this.requireRef(id);
    return this.withNative(ref, async () => {
      const ack = await cancelTask(ref.serverProfile, ref.taskHandle, {
        client: CLI_CLIENT,
      });
      return this.observeAfterWrite(ref, ack, undefined, () =>
        getTask(ref.serverProfile, ref.taskHandle, { client: CLI_CLIENT }),
      );
    });
  }

  async updateNative(
    id: string,
    inputResponses: Record<string, unknown>,
  ): Promise<NativeControlResult> {
    const ref = this.requireRef(id);
    return this.withNative(ref, async () => {
      const ack = await updateTask(
        ref.serverProfile,
        ref.taskHandle,
        inputResponses,
        { client: CLI_CLIENT },
      );
      return this.observeAfterWrite(ref, ack, undefined, () =>
        getTask(ref.serverProfile, ref.taskHandle, { client: CLI_CLIENT }),
      );
    });
  }

  private async withNative(
    ref: TaskRef,
    op: () => Promise<NativeControlResult>,
  ): Promise<NativeControlResult> {
    try {
      return await op();
    } catch (err) {
      const classified = classifyControlError(
        err,
        ref.taskHandle,
        ref.serverProfile.id,
      );
      this.registry.recordError(ref.id, classified.message);
      throw classified;
    }
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

export { TaskDockError };
