import { DAY } from './utils.ts';

/** The date-range buttons: days back from the snapshot, or everything. */
export type Range = '7' | '30' | '90' | '180' | 'all';

export const RANGES: readonly Range[] = ['7', '30', '90', '180', 'all'];

/** The product default: the depth every sync guarantees. */
export const DEFAULT_RANGE: Range = '30';

/** Allow for the time between sync start and the completed snapshot when enabling ranges. */
export const COVERAGE_SLACK = DAY;

export const isRange = (value: unknown): value is Range =>
  typeof value === 'string' && (RANGES as readonly string[]).includes(value);

/** Epoch ms where a range's window starts; `-Infinity` for `'all'`. */
export const rangeStart = (range: Range, last: number): number =>
  range === 'all' ? -Infinity : last - Number(range) * DAY;

/**
 * Whether every PR from `days` before `last` onwards is guaranteed to be in
 * the payload. `null` coverage is full history; otherwise `coverageSince` must
 * be at or before `last − days`, exactly: a comparison built on a window that
 * is short by even a day is a comparison against a truncated period. `slack`
 * (ms) loosens that for display purposes only. A bound that does not parse is
 * treated as covering nothing: better a disabled comparison than a wrong one.
 */
export function coversDays(
  coverageSince: string | null,
  last: number,
  days: number,
  slack = 0,
): boolean {
  if (coverageSince === null) return true;
  const since = Date.parse(coverageSince);
  if (Number.isNaN(since)) return false;
  return since <= last - days * DAY + slack;
}

/**
 * Whether every PR the range button can show is guaranteed to be in the
 * payload, give or take `COVERAGE_SLACK`.
 */
export function isCovered(coverageSince: string | null, last: number, range: Range): boolean {
  if (range === 'all') return coverageSince === null;
  return coversDays(coverageSince, last, Number(range), COVERAGE_SLACK);
}

/** The `--since` date (UTC `YYYY-MM-DD`) a CLI re-run needs to cover `range`. */
export const rangeSinceDate = (range: Range, last: number): string | null =>
  range === 'all' ? null : new Date(rangeStart(range, last)).toISOString().slice(0, 10);
