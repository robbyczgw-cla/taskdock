import { createHash } from "node:crypto";
import type { ServerProfile, Transport } from "../types.js";

/** Strip userinfo so a password in a URL cannot become identity or storage. */
export function stripUrlUserinfo(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.username && !parsed.password) return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

export function sanitizeTransport(transport: Transport): Transport {
  if (transport.type !== "http") return transport;
  return { type: "http", url: stripUrlUserinfo(transport.url) };
}

/**
 * Canonical HTTP endpoint: no userinfo, lowercase host, drop default ports,
 * drop a trailing slash on a non-root path. Query string is kept (it can be
 * part of the real MCP mount). Hash is dropped.
 */
export function normalizeHttpEndpoint(url: string): string {
  const u = new URL(stripUrlUserinfo(url));
  u.hash = "";
  const protocol = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  let port = u.port;
  if (
    (protocol === "http:" && (port === "80" || port === "")) ||
    (protocol === "https:" && (port === "443" || port === ""))
  ) {
    port = "";
  }
  let path = u.pathname || "/";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const origin = port ? `${protocol}//${host}:${port}` : `${protocol}//${host}`;
  return `${origin}${path}${u.search}`;
}

/**
 * Stable non-secret fingerprint of how to reach a server.
 * Does not include the local profile id or display name.
 */
export function serverFingerprint(
  profile: Pick<ServerProfile, "transport" | "authProfile">,
): string {
  const transport = sanitizeTransport(profile.transport);
  const endpoint =
    transport.type === "http"
      ? (["http", normalizeHttpEndpoint(transport.url)] as const)
      : (["stdio", transport.command, ...(transport.args ?? [])] as const);
  const canonical = JSON.stringify({
    endpoint,
    auth: profile.authProfile ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex");
}
