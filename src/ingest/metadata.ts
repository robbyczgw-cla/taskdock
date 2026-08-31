/** Fields allowed on ingested task metadata. No raw tool payloads. */
export function pickSafeMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  if (meta.serverInfo && typeof meta.serverInfo === "object" && !Array.isArray(meta.serverInfo)) {
    const si = meta.serverInfo as Record<string, unknown>;
    const clean: Record<string, string> = {};
    if (typeof si.name === "string") clean.name = si.name;
    if (typeof si.version === "string") clean.version = si.version;
    if (Object.keys(clean).length > 0) out.serverInfo = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
