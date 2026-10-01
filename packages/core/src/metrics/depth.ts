import { median, sum } from './stats.ts';

import type { MergedPr, MetricPr } from './derive.ts';
import type { Windowed } from './scope.ts';

/**
 * Five bands, each a union of `sizeBins` buckets so the two charts line up.
 * The large end, where the question lies, keeps its own edges. At the small
 * end ≤10 joins ≤50 and ≤100 joins ≤250: the pairs differ by under a thread
 * per PR, so splitting them adds rows rather than signal.
 */
const DEPTH_EDGES = [51, 251, 501, 1001, Infinity];
const DEPTH_LABELS = ['≤50', '51–250', '251–500', '501–1k', '1k+'];

/**
 * Approved with no review threads: the PR has reviews (leaving out `skip`),
 * every one an approval, and no review threads. `th` counts the threads of
 * every reviewer, bots included: the payload does not say who opened them.
 */
export function isQuiet(p: MetricPr, skip: ReadonlySet<string>): boolean {
  const rv = p.rv.filter(([who]) => !skip.has(who));
  return p.th === 0 && rv.length > 0 && rv.every(([, st]) => st === 'APPROVED');
}

export interface DepthBand {
  label: string;
  /** Exclusive upper bound, in lines added + deleted. */
  edge: number;
  merged: number;
  /** Mean review threads per merged PR; null when none merged. */
  threads: number | null;
  /** Merged PRs approved with no review threads (see `isQuiet`). */
  quiet: number;
  /** `quiet` over `merged`; null when none merged. */
  quietShare: number | null;
  /** Median ready -> first approval, ms. */
  medApproval: number | null;
}

/** How deeply merged PRs were reviewed, by size band, smallest first. */
export function reviewDepth(w: Windowed): DepthBand[] {
  const { merged, skip } = w;
  const bands = DEPTH_LABELS.map((label, i) => ({
    label,
    edge: DEPTH_EDGES[i] ?? Infinity,
    prs: [] as MergedPr[],
  }));
  for (const p of merged) bands[DEPTH_EDGES.findIndex((e) => p.size < e)]?.prs.push(p);
  return bands.map(({ label, edge, prs }) => {
    const quiet = prs.filter((p) => isQuiet(p, skip)).length;
    const toApproval = prs.flatMap((p) => {
      const ok = p.rv.find(([who, st]) => st === 'APPROVED' && !skip.has(who));
      return ok && p.r !== null ? [Math.max(0, ok[2] - p.r)] : [];
    });
    return {
      label,
      edge,
      merged: prs.length,
      threads: prs.length ? sum(prs.map((p) => p.th)) / prs.length : null,
      quiet,
      quietShare: prs.length ? quiet / prs.length : null,
      medApproval: median(toApproval),
    };
  });
}
