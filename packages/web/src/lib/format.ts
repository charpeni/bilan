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

/**
 * `just now`, `12 min ago`, `5 h ago`, `yesterday`, `3 days ago`, then the
 * day (`Sep 2, 2026`) past a week; the input when it is not a date. A time a
 * little in the future (clock skew) reads as `just now`.
 */
export function fmtAgo(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ms = now - at;
  if (ms < 60e3) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / 60e3)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  if (ms < 2 * DAY) return 'yesterday';
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)} days ago`;
  return fmtDay(iso);
}

/**
 * How much history a payload holds, as the header chip and the repo list say
 * it: `full history`, or `last 30 days` counted from the sync that produced it.
 * Without a sync instant (or with bounds that do not parse), the bound's day.
 */
export function fmtHistory(coverageSince: string | null, syncedAt: string | null): string {
  if (coverageSince === null) return 'full history';
  const since = Date.parse(coverageSince);
  const at = syncedAt === null ? Number.NaN : Date.parse(syncedAt);
  if (Number.isNaN(since) || Number.isNaN(at) || at < since) return fmtCoverage(coverageSince);
  const days = Math.max(1, Math.round((at - since) / DAY));
  return days === 1 ? 'last day' : `last ${days} days`;
}

/** `Sep 28, 2026, 19:35 UTC`: the absolute instant behind a relative one, for tooltips. */
export function fmtInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDay(iso)}, ${fmtSyncedAt(iso).split(', ')[1] ?? ''}`;
}

/** Capitalise the first letter, for a phrase that starts a cell (`Last 30 days`). */
export const capitalize = (text: string): string =>
  text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;

/** `1 author`, `3 authors`. */
export const plural = (n: number, noun: string): string =>
  `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
