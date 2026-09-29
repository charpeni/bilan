/** `8s`, `1m 05s`, `12m`: time since a sync was queued, or since it last moved. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m >= 10) return `${m}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
