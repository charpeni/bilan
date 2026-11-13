import type { PayloadPr } from '../types.ts';

/** A payload PR plus the per-PR fields every metric builds on, derived once. */
export interface MetricPr extends PayloadPr {
  merged: boolean;
  open: boolean;
  /**
   * First review by someone else, epoch ms. Counts every reviewer as derived;
   * `ignoringReviewers` recomputes it (with `toFirst` and `unreviewed`) when
   * some reviewers, the bots, are left out.
   */
  first: number | null;
  /** Lines added + deleted. */
  size: number;
  /** Draft -> ready; only meaningful if opened as draft. */
  toReady: number | null;
  /** Ready -> first review. */
  toFirst: number | null;
  /** Ready -> merged. */
  toMerge: number | null;
  /** Opened -> merged, no draft credit. */
  lead: number | null;
  selfMerged: boolean;
  unreviewed: boolean;
  revert: boolean;
}

/** A PR that has been merged: `m` and `toMerge` are both set. */
export type MergedPr = MetricPr & { m: number; toMerge: number };
/** A PR closed without merging: `x` is set. */
export type ClosedPr = MetricPr & { x: number };
/** A PR that has been marked ready for review: `r` is set. */
export type ReadyPr = MetricPr & { r: number };

export const isMerged = (p: MetricPr): p is MergedPr => p.m !== null;
export const isReady = (p: MetricPr): p is ReadyPr => p.r !== null;

const NOBODY: ReadonlySet<string> = new Set();

/** The fields that depend on who counts as a reviewer. */
function reviewed(
  p: PayloadPr,
  skip: ReadonlySet<string>,
): Pick<MetricPr, 'first' | 'toFirst' | 'unreviewed'> {
  // `rv` is sorted by time, so the first kept review is the earliest.
  const r0 = p.rv.find(([who]) => !skip.has(who));
  const first = r0 ? r0[2] : null;
  return {
    first,
    // p.r is null for PRs that never left draft; they have no review latency.
    toFirst: first !== null && p.r !== null ? Math.max(0, first - p.r) : null,
    unreviewed: p.m !== null && first === null,
  };
}

/**
 * `p` as if the reviewers in `skip` had never reviewed it: the first review,
 * the wait for it, and whether a merge went unreviewed come from the others.
 * `rv` itself is untouched. Returns `p` when none of them reviewed it.
 */
export const ignoringReviewers = (p: MetricPr, skip: ReadonlySet<string>): MetricPr =>
  skip.size && p.rv.some(([who]) => skip.has(who)) ? { ...p, ...reviewed(p, skip) } : p;

export function derive(prs: readonly PayloadPr[]): MetricPr[] {
  return prs.map((p) => {
    const merged = p.m !== null;
    return {
      ...p,
      ...reviewed(p, NOBODY),
      merged,
      open: p.x === null,
      size: p.ad + p.de,
      toReady: p.d && p.r !== null ? p.r - p.c : null,
      // A PR merged straight from draft was never reviewable, so it has no
      // ready-anchored merge time (the original arithmetic coerced the missing
      // ready time to the epoch and produced decades).
      toMerge: p.m !== null && p.r !== null ? Math.max(0, p.m - p.r) : null,
      lead: p.m !== null ? p.m - p.c : null,
      selfMerged: merged && p.mb !== null && p.mb === p.a,
      revert: /^revert\b/i.test(p.t),
    };
  });
}

/** Timestamp of the most recent event in the data set. */
export const lastActivity = (prs: readonly MetricPr[]): number =>
  prs.reduce((latest, p) => Math.max(latest, p.c, p.x ?? 0, p.m ?? 0), -Infinity);

/** Earliest opening time in the data set. */
export const firstActivity = (prs: readonly MetricPr[]): number =>
  prs.reduce((earliest, p) => Math.min(earliest, p.c), Infinity);
