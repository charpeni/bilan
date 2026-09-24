import { DAY, HOUR } from './time.ts';

import type { MergedPr, MetricPr } from './derive.ts';

export interface Bucket {
  label: string;
  value: number;
}

export interface EdgedBucket extends Bucket {
  /** Exclusive upper bound of the bucket. */
  edge: number;
}

const MERGE_EDGES = [HOUR, 4 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, Infinity];
const MERGE_LABELS = ['<1h', '<4h', '<12h', '<1d', '<2d', '<3d', '<1w', '<2w', '2w+'];

/** Ready-for-review to merge, bucketed. */
export function mergeTimeBins(merged: readonly MergedPr[]): EdgedBucket[] {
  const bins = MERGE_LABELS.map((label, i) => ({
    label,
    value: 0,
    edge: MERGE_EDGES[i] ?? Infinity,
  }));
  for (const p of merged) {
    if (p.toMerge !== null) {
      const b = bins[MERGE_EDGES.findIndex((e) => p.toMerge < e)];
      if (b) b.value++;
    }
  }
  return bins;
}

const SIZE_EDGES = [11, 51, 101, 251, 501, 1001, Infinity];
const SIZE_LABELS = ['≤10', '≤50', '≤100', '≤250', '≤500', '≤1k', '1k+'];

/** Lines added + deleted per PR, bucketed. */
export function sizeBins(opened: readonly MetricPr[]): Bucket[] {
  const bins = SIZE_LABELS.map((label) => ({ label, value: 0 }));
  for (const p of opened) {
    const b = bins[SIZE_EDGES.findIndex((e) => p.size < e)];
    if (b) b.value++;
  }
  return bins;
}

/** PRs touching each area, most touched first. A PR touching two areas counts in both. */
export function areaBreakdown(prs: readonly MetricPr[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of prs) for (const a of p.ar) counts.set(a, (counts.get(a) ?? 0) + 1);
  return [...counts].toSorted((a, b) => b[1] - a[1]);
}

/** Merges per local weekday (Monday first) and hour: 7 rows of 24 cells. */
export function mergeHeatmap(merged: readonly MergedPr[]): number[][] {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const p of merged) {
    const d = new Date(p.m);
    const row = cells[(d.getDay() + 6) % 7];
    if (row) row[d.getHours()] = (row[d.getHours()] ?? 0) + 1;
  }
  return cells;
}
