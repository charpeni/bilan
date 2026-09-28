import type { SyncProgress } from './poll.ts';

/** `8s`, `1m 05s`, `12m`: time since a sync was queued. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m >= 10) return `${m}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * One line on a running sync, built only from what the API reported: the
 * phase, how many pull requests are stored so far (a count of rows actually
 * written, so it only ever grows), and the time since the job was queued when
 * that is known. No percentage: a sync's total is not known up front.
 */
export function progressText(progress: SyncProgress, now: number = Date.now()): string {
  const parts: string[] = [];
  const n = progress.prsStored;
  if (progress.phase === 'queued') parts.push('Waiting to start…');
  else if (n === null || n === 0) parts.push('Reading pull requests from GitHub…');
  else parts.push(`${n.toLocaleString()} pull request${n === 1 ? '' : 's'} synced so far`);
  if (progress.startedAt !== null) {
    const at = Date.parse(progress.startedAt);
    if (!Number.isNaN(at)) parts.push(fmtElapsed(now - at));
  }
  return parts.join(' · ');
}
