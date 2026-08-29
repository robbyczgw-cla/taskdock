import type { McpTask, ServerProfile } from "../types.ts";
import { mcpCall, type McpCallOptions } from "./transport.ts";

export async function callToolTask(
  profile: ServerProfile,
  name: string,
  args: Record<string, unknown>,
  options: McpCallOptions,
): Promise<McpTask> {
  const { result } = await mcpCall<McpTask>(
    profile,
    "tools/call",
    { name, arguments: args },
    options,
  );
  if (result.resultType !== "task" || typeof result.taskId !== "string") {
    throw new Error(
      `expected CreateTaskResult (resultType=task), got: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

export async function getTask(
  profile: ServerProfile,
  taskId: string,
  options: McpCallOptions,
): Promise<McpTask> {
  const { result } = await mcpCall<McpTask>(
    profile,
    "tasks/get",
    { taskId },
    options,
  );
  if (result.resultType && result.resultType !== "complete") {
    throw new Error(
      `expected GetTaskResult (resultType=complete), got: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

export async function cancelTask(
  profile: ServerProfile,
  taskId: string,
  options: McpCallOptions,
): Promise<Record<string, unknown>> {
  const { result } = await mcpCall<Record<string, unknown>>(
    profile,
    "tasks/cancel",
    { taskId },
    options,
  );
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntilTerminal(
  profile: ServerProfile,
  taskId: string,
  options: McpCallOptions,
  opts?: { timeoutMs?: number; onTick?: (task: McpTask) => void },
): Promise<McpTask> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const task = await getTask(profile, taskId, options);
    opts?.onTick?.(task);
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      return task;
    }
    const wait = Math.max(50, task.pollIntervalMs ?? 200);
    await sleep(wait);
  }
  throw new Error(`timed out polling task ${taskId}`);
}
