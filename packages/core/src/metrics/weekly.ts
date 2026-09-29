import { median } from './stats.ts';
import { DAY, HOUR, weekStart } from './time.ts';

import type { Scope } from './scope.ts';

/** ISO-week buckets from the start of the window (or of the data) to `last`. */
export interface WeekBuckets {
  start: number;
  /** Bucket start timestamps, one per week. */
  weeks: number[];
  /** Bucket index of a timestamp; may be out of range. */
  idxOf: (t: number) => number;
  inRange: (i: number) => boolean;
}

export function weekBuckets(s: Scope, last: number): WeekBuckets {
  const { from, authored } = s;
  const start =
    from === -Infinity ? weekStart(Math.min(...authored.map((p) => p.c))) : weekStart(from);
  const weeks: number[] = [];
  for (let w = start; w <= last; w += 7 * DAY) weeks.push(w);
  return {
    start,
    weeks,
    idxOf: (t) => Math.floor((weekStart(t) - start) / (7 * DAY)),
    inRange: (i) => i >= 0 && i < weeks.length,
  };
}

const bump = (arr: number[], i: number): void => {
  arr[i] = (arr[i] ?? 0) + 1;
};

export interface Throughput {
  opened: number[];
  merged: number[];
  closed: number[];
}

/** PRs opened, merged, and closed without merging per week. */
export function throughput(s: Scope, wb: WeekBuckets): Throughput {
  const { authored, inWin } = s;
  const { weeks, idxOf, inRange } = wb;
  const opened = weeks.map(() => 0);
  const merged = weeks.map(() => 0);
  const closed = weeks.map(() => 0);
  for (const p of authored) {
    let i = idxOf(p.c);
    if (inRange(i) && inWin(p.c)) bump(opened, i);
    if (p.m !== null) {
      i = idxOf(p.m);
      if (inRange(i) && inWin(p.m)) bump(merged, i);
    } else if (p.x !== null) {
      i = idxOf(p.x);
      if (inRange(i) && inWin(p.x)) bump(closed, i);
    }
  }
  return { opened, merged, closed };
}

export interface OpenBacklog {
  /** PRs still open at the end of each week. */
  open: number[];
  /** Of those, the ones still drafts at that instant: never marked ready, or marked ready later. */
  drafts: number[];
}

/**
 * PRs still open at the end of each week, and how many of them were drafts
 * then. Draft is read from the ready-for-review event alone (`r`, null when
 * never ready): a PR is a draft at the week's end when it was open and not
 * yet ready. Re-drafts are ignored, as in the rest of the metrics.
 */
export function openBacklog(s: Scope, wb: WeekBuckets): OpenBacklog {
  const open: number[] = [];
  const drafts: number[] = [];
  for (const w of wb.weeks) {
    const edge = w + 7 * DAY - 1;
    const atEdge = s.authored.filter((p) => p.c <= edge && (p.x === null || p.x > edge));
    open.push(atEdge.length);
    drafts.push(atEdge.filter((p) => p.r === null || p.r > edge).length);
  }
  return { open, drafts };
}

/** Weekly median in hours; null for empty buckets so a line can skip them. */
const hours = (b: number[]): number | null => {
  const m = b.length ? median(b) : null;
  return m === null ? null : m / HOUR;
};

export interface CycleTimeTrend {
  /** Weekly median hours from ready to first review, by week of the review. */
  toFirst: (number | null)[];
  /** Weekly median hours from ready to merge, by week of the merge. */
  toMerge: (number | null)[];
}

export function cycleTimeTrend(s: Scope, wb: WeekBuckets): CycleTimeTrend {
  const { authored, inWin } = s;
  const { weeks, idxOf, inRange } = wb;
  const mergeBuckets: number[][] = weeks.map(() => []);
  const reviewBuckets: number[][] = weeks.map(() => []);
  for (const p of authored) {
    if (p.m !== null && inWin(p.m) && p.toMerge !== null) {
      const i = idxOf(p.m);
      if (inRange(i)) mergeBuckets[i]?.push(p.toMerge);
    }
    if (p.toFirst !== null && inWin(p.first)) {
      const i = idxOf(p.first);
      if (inRange(i)) reviewBuckets[i]?.push(p.toFirst);
    }
  }
  return { toFirst: reviewBuckets.map(hours), toMerge: mergeBuckets.map(hours) };
}
