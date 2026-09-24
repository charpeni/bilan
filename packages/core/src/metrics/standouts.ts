import { median, percentile, sum } from './stats.ts';
import { DAY, HOUR } from './time.ts';

import type { MetricPr } from './derive.ts';
import type { PersonRec } from './people.ts';
import type { Windowed } from './scope.ts';

export const STALE_DAYS = 14;

/** The numbers behind the "what stands out" list. Shares are fractions of `merged`/`opened`/`readied`. */
export interface Standouts {
  merged: number;
  /** Merged PRs with no review from anyone else. */
  unreviewed: number;
  unreviewedShare: number;
  /** Merged PRs carrying an explicit approval. */
  approved: number;
  approvedShare: number;
  selfMergedShare: number;
  /** People who reviewed at all. */
  reviewers: number;
  /** Share of all reviews given by the top 3 reviewers. */
  top3Share: number;
  /** Merged within an hour of becoming ready. */
  fast: number;
  fastShare: number;
  opened: number;
  draftShare: number;
  /** Median draft -> ready, ms. */
  medReady: number | null;
  weekendMerges: number;
  weekendShare: number;
  /** Open PRs older than `STALE_DAYS`. */
  stale: number;
  oldest: MetricPr | null;
  reverts: number;
  /** Reverts over PRs opened (at least 1). */
  revertShare: number;
  readied: number;
  /** Share of readied PRs reviewed within a day. */
  firstWithinDayShare: number;
  p90First: number | null;
}

const nonNull = (v: number | null): v is number => v !== null;

export function standouts(w: Windowed, people: readonly PersonRec[]): Standouts {
  const { opened, merged, readied, stillOpen, last } = w;
  const mergedWithReview = merged.filter((p) => p.rv.length);
  const approvedMerges = merged.filter((p) => p.rv.some(([, st]) => st === 'APPROVED'));
  const reviewTotals = people
    .filter((r) => r.reviewsGiven)
    .map((r) => r.reviewsGiven)
    .toSorted((a, b) => b - a);
  const top3 = sum(reviewTotals.slice(0, 3));
  const weekendMerges = merged.filter((p) => [0, 6].includes(new Date(p.m).getDay()));
  const fast = merged.filter((p) => p.toMerge !== null && p.toMerge < HOUR);
  const oldest = stillOpen.toSorted((a, b) => a.c - b.c)[0];
  const stale = stillOpen.filter((p) => last - p.c > STALE_DAYS * DAY);
  const reverts = opened.filter((p) => p.revert);
  return {
    merged: merged.length,
    unreviewed: merged.length - mergedWithReview.length,
    unreviewedShare: 1 - mergedWithReview.length / merged.length,
    approved: approvedMerges.length,
    approvedShare: approvedMerges.length / merged.length,
    selfMergedShare: merged.filter((p) => p.selfMerged).length / merged.length,
    reviewers: reviewTotals.length,
    top3Share: top3 / sum(reviewTotals),
    fast: fast.length,
    fastShare: fast.length / merged.length,
    opened: opened.length,
    draftShare: opened.filter((p) => p.d).length / opened.length,
    medReady: median(opened.map((p) => p.toReady).filter(nonNull)),
    weekendMerges: weekendMerges.length,
    weekendShare: weekendMerges.length / merged.length,
    stale: stale.length,
    oldest: oldest ?? null,
    reverts: reverts.length,
    revertShare: reverts.length / Math.max(1, opened.length),
    readied: readied.length,
    firstWithinDayShare:
      readied.filter((p) => p.toFirst !== null && p.toFirst < DAY).length / readied.length,
    p90First: percentile(readied.map((p) => p.toFirst).filter(nonNull), 0.9),
  };
}

/** The longest-open PRs, oldest first. */
export const oldestOpen = (stillOpen: readonly MetricPr[], limit = 15): MetricPr[] =>
  stillOpen.toSorted((a, b) => a.c - b.c).slice(0, limit);
