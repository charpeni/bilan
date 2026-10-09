import { firstActivity } from './derive.ts';
import { median } from './stats.ts';
import { DAY, HOUR, dayStart, weekStart } from './time.ts';

import type { Scope } from './scope.ts';

/** What a trend bucket spans: a UTC day, or an ISO week. */
export type TimeUnit = 'day' | 'week';

/** Buckets of one `TimeUnit` from the start of the window (or of the data) to `last`. */
export interface TimeBuckets {
  start: number;
  /** Length of one bucket, ms. */
  size: number;
  /** Bucket start timestamps, oldest first. */
  starts: number[];
  /** Bucket index of a timestamp; may be out of range. */
  idxOf: (t: number) => number;
  inRange: (i: number) => boolean;
}

export function timeBuckets(s: Scope, last: number, unit: TimeUnit = 'week'): TimeBuckets {
  const { from, authored } = s;
  const floor = unit === 'day' ? dayStart : weekStart;
  const size = unit === 'day' ? DAY : 7 * DAY;
  const start = floor(from === -Infinity ? firstActivity(authored) : from);
  const starts: number[] = [];
  for (let b = start; b <= last; b += size) starts.push(b);
  return {
    start,
    size,
    starts,
    idxOf: (t) => Math.floor((floor(t) - start) / size),
    inRange: (i) => i >= 0 && i < starts.length,
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

/** PRs opened, merged, and closed without merging per bucket. */
export function throughput(s: Scope, tb: TimeBuckets): Throughput {
  const { authored, inWin } = s;
  const { starts, idxOf, inRange } = tb;
  const opened = starts.map(() => 0);
  const merged = starts.map(() => 0);
  const closed = starts.map(() => 0);
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
  /** PRs still open at the end of each bucket. */
  open: number[];
  /** Of those, the ones still drafts at that instant: never marked ready, or marked ready later. */
  drafts: number[];
}

/**
 * PRs still open at the end of each bucket, and how many of them were drafts
 * then. Draft is read from the ready-for-review event alone (`r`, null when
 * never ready): a PR is a draft at the bucket's end when it was open and not
 * yet ready. Re-drafts are ignored, as in the rest of the metrics.
 */
export function openBacklog(s: Scope, tb: TimeBuckets): OpenBacklog {
  const open: number[] = [];
  const drafts: number[] = [];
  for (const b of tb.starts) {
    const edge = b + tb.size - 1;
    const atEdge = s.authored.filter((p) => p.c <= edge && (p.x === null || p.x > edge));
    open.push(atEdge.length);
    drafts.push(atEdge.filter((p) => p.r === null || p.r > edge).length);
  }
  return { open, drafts };
}

/** A bucket's median in hours; null for empty buckets so a line can skip them. */
const hours = (b: number[]): number | null => {
  const m = b.length ? median(b) : null;
  return m === null ? null : m / HOUR;
};

export interface CycleTimeTrend {
  /** Median hours from ready to first review, by bucket of the review. */
  toFirst: (number | null)[];
  /** Median hours from ready to merge, by bucket of the merge. */
  toMerge: (number | null)[];
}

export function cycleTimeTrend(s: Scope, tb: TimeBuckets): CycleTimeTrend {
  const { authored, inWin } = s;
  const { starts, idxOf, inRange } = tb;
  const mergeBuckets: number[][] = starts.map(() => []);
  const reviewBuckets: number[][] = starts.map(() => []);
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
