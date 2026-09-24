import { median, percentile } from './stats.ts';

import type { Windowed } from './scope.ts';

/** The headline tiles: counts and latencies for what happened in the window. */
export interface Headline {
  opened: number;
  /** Distinct authors among the PRs opened. */
  authors: number;
  merged: number;
  /** Merged over merged + closed unmerged; null when nothing was opened. */
  mergedShare: number | null;
  rejected: number;
  stillOpen: number;
  /** Ready -> merged, ms. */
  medMerge: number | null;
  p90Merge: number | null;
  /** Ready -> first review, ms. */
  medFirst: number | null;
  /** Share of PRs readied in the window that ever got a review. */
  reviewedShare: number | null;
  /** Draft -> ready, ms. */
  medReady: number | null;
  /** Share of PRs opened in the window that were opened as drafts. */
  draftShare: number | null;
  reviews: number;
  /** Distinct reviewers among the reviews given. */
  reviewers: number;
}

const nonNull = (v: number | null): v is number => v !== null;

export function headline(w: Windowed): Headline {
  const { opened, merged, rejected, readied, winReviews, stillOpen } = w;
  const toMerge = merged.map((p) => p.toMerge).filter(nonNull);
  return {
    opened: opened.length,
    authors: new Set(opened.map((p) => p.a)).size,
    merged: merged.length,
    mergedShare: opened.length ? merged.length / (merged.length + rejected.length) : null,
    rejected: rejected.length,
    stillOpen: stillOpen.length,
    medMerge: median(toMerge),
    p90Merge: percentile(toMerge, 0.9),
    medFirst: median(readied.map((p) => p.toFirst).filter(nonNull)),
    reviewedShare: readied.length
      ? readied.filter((p) => p.toFirst !== null).length / readied.length
      : null,
    medReady: median(opened.map((p) => p.toReady).filter(nonNull)),
    draftShare: opened.length ? opened.filter((p) => p.d).length / opened.length : null,
    reviews: winReviews.length,
    reviewers: new Set(winReviews.map((r) => r.who)).size,
  };
}
