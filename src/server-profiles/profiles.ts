import type { ServerProfile, Transport } from "../types.ts";

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
    authProfile: opts.auth,
  };
}
