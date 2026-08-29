import type { ServerProfile, Transport } from "../types.js";

const ENV_AUTH = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function parseTransport(args: {
  http?: string;
  stdio?: string;
  args?: string[];
}): Transport {
  if (args.http) {
    return { type: "http", url: args.http };
  }
  if (args.stdio) {
    return { type: "stdio", command: args.stdio, args: args.args };
  }
  throw new Error("specify --http <url> or --stdio <command>");
}

/** Persist only env:VAR references. Never store a credential value. */
export function normalizeAuthProfile(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value === "none") return undefined;
  if (ENV_AUTH.test(value)) return value;
  throw new Error(
    "authProfile must be env:VAR (an environment variable name). TaskDock does not store credential values.",
  );
}

export function profileFromFlags(opts: {
  id: string;
  http?: string;
  stdio?: string;
  args?: string[];
  auth?: string;
}): ServerProfile {
  return {
    id: opts.id,
    name: opts.id,
    transport: parseTransport(opts),
    authProfile: normalizeAuthProfile(opts.auth),
  };
}
