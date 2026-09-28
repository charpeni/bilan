import { DAY, HOUR } from '@bilan/core';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-28T19:35:35.669Z` -> `Sep 28, 19:35 UTC`; the input when it is not a date. */
export function fmtSyncedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

/** `2026-09-28T…` -> `Sep 28, 2026`; the input when it is not a date. */
export function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** What a payload covers, as the header chip and the repo list say it. */
export function fmtCoverage(coverageSince: string | null): string {
  return coverageSince === null ? 'full history' : `since ${fmtDay(coverageSince)}`;
}

/** Durations as the dashboard tiles print them: `55m`, `2.4d`, `1.2mo`. */
export function dur(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—';
  if (ms < 60e3) return '<1m';
  if (ms < HOUR) return `${Math.round(ms / 60e3)}m`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(ms < 10 * HOUR ? 1 : 0)}h`;
  if (ms < 30 * DAY) return `${(ms / DAY).toFixed(ms < 10 * DAY ? 1 : 0)}d`;
  return `${(ms / (30 * DAY)).toFixed(1)}mo`;
}

export const pct = (v: number | null): string =>
  v === null || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}%`;
