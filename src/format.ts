const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function abbreviateHandle(handle: string): string {
  if (handle.length <= 20) return handle;
  return `${handle.slice(0, 16)}…${handle.slice(-4)}`;
}

export function formatAge(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "-";
  const sec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function isActiveStatus(status?: string): boolean {
  if (!status) return true;
  return !TERMINAL.has(status);
}
