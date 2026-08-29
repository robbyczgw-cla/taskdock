/**
 * Client B: load a TaskDock record and resume via a NEW MCP connection.
 * Must not import client-a. Must not reuse an open connection.
 */
import { TaskDock } from "../taskdock.ts";
import { connect, pollUntilTerminal } from "../mcp/client.ts";

const id = process.argv[2] ?? process.env.TASKDOCK_ID;

async function main(): Promise<void> {
  console.log("[client-b]");
  console.log();
  console.log("No state from Client A loaded.");
  console.log();
  console.log("Querying TaskDock...");
  console.log();

  if (!id) {
    console.error("usage: client-b <taskdock-id>");
    process.exit(2);
  }

  const dock = new TaskDock();
  const ref = dock.resolve(id);

  console.log("Found:");
  console.log(ref.id);
  console.log(`server: ${ref.serverProfile.id}`);
  console.log(`task: ${ref.taskHandle}`);
  console.log(`sourceClient in registry: ${ref.record.sourceClient ?? "(none)"}`);
  console.log();
  console.log(`Loaded ${ref.id} from persistent TaskDock registry`);
  console.log("Opening fresh MCP connection");
  console.log(`Using task handle ${ref.taskHandle}`);
  console.log();

  const connected = await connect(ref.serverProfile, {
    name: "client-b",
    version: "0.1.0",
  });
  console.log(`serverInfo: ${JSON.stringify(connected.serverInfo)}`);
  console.log("Polling task...");
  console.log();

  const task = await pollUntilTerminal(
    ref.serverProfile,
    ref.taskHandle,
    { client: { name: "client-b" } },
    {
      timeoutMs: 120_000,
      onTick: (t) => {
        dock.registry.touch(ref.id, t.status);
        console.log(`Task status: ${t.status}`);
        if (t.statusMessage) console.log(`  ${t.statusMessage}`);
      },
    },
  );

  console.log();
  if (task.status === "completed") {
    const result = task.result as { content?: { text?: string }[] } | undefined;
    const text = result?.content?.[0]?.text ?? JSON.stringify(task.result);
    console.log("status: completed");
    console.log("Result:", text);
  } else {
    console.log(`status: ${task.status}`);
    console.log(JSON.stringify(task, null, 2));
  }

  dock.close();
}

main().catch((err) => {
  console.error("[client-b] failed:", err);
  process.exit(1);
});
