import { isMerged } from './derive.ts';
import { DAY } from './time.ts';

import type { ReviewState } from '../types.ts';
import type { MergedPr, MetricPr } from './derive.ts';

export interface FilterState {
  /** Days back from the last activity, or `'all'`. */
  range: string;
  area: string;
  person: string;
  hideBots: boolean;
}

export const createFilterState = (): FilterState => ({
  range: 'all',
  area: '',
  person: '',
  hideBots: true,
});

export interface ReviewRow {
  who: string;
  st: ReviewState;
  at: number;
  pr: MetricPr;
}

/** True when `t` is a timestamp inside the window. */
export type InWindow = (t: number | null | undefined) => t is number;

export interface Scope {
  from: number;
  base: MetricPr[];
  authored: MetricPr[];
  reviews: ReviewRow[];
  /** Reviewers whose reviews are left out: the bots, while bots are hidden. */
  skip: ReadonlySet<string>;
  inWin: InWindow;
  focus: string | null;
}

/**
 * Apply the filter row: bots, area, person, and the time window measured back
 * from `last`. Nothing is windowed yet; `inWin` is what each metric applies to
 * its own anchor event.
 */
export function scope(
  prs: readonly MetricPr[],
  bots: ReadonlySet<string>,
  state: FilterState,
  last: number,
): Scope {
  const from = state.range === 'all' ? -Infinity : last - Number(state.range) * DAY;
  const base = prs.filter(
    (p) => (!state.hideBots || !p.bot) && (!state.area || p.ar.includes(state.area)),
  );
  const inWin: InWindow = (t): t is number => t !== null && t !== undefined && t >= from;
  const focus = state.person || null;
  const authored = focus ? base.filter((p) => p.a === focus) : base;
  const skip: ReadonlySet<string> = state.hideBots ? bots : new Set();
  // Review rows, flattened, already excluding self-reviews at build time.
  const reviews: ReviewRow[] = [];
  for (const p of base) {
    for (const [who, st, at] of p.rv) {
      if (focus && who !== focus) continue;
      if (skip.has(who)) continue;
      reviews.push({ who, st, at, pr: p });
    }
  }
  return { from, base, authored, reviews, skip, inWin, focus };
}

/** The scoped PRs and reviews, each windowed on its own anchor event. */
export interface Windowed extends Scope {
  /** Opened in the window. */
  opened: MetricPr[];
  /** Merged in the window, whenever they were opened. */
  merged: MergedPr[];
  /** Closed without merging in the window. */
  rejected: MetricPr[];
  /** Marked ready for review in the window. */
  readied: MetricPr[];
  /** Reviews submitted in the window. */
  winReviews: ReviewRow[];
  /** Currently open, regardless of the window. */
  stillOpen: MetricPr[];
  last: number;
}

/**
 * Each metric is anchored to its own event, so a window means "what happened
 * in this window" rather than "PRs that happen to have been opened in it".
 */
export function windowed(s: Scope, last: number): Windowed {
  const { authored, reviews, inWin } = s;
  return {
    ...s,
    opened: authored.filter((p) => inWin(p.c)),
    merged: authored.filter((p): p is MergedPr => isMerged(p) && inWin(p.m)),
    rejected: authored.filter((p) => !p.merged && p.x !== null && inWin(p.x)),
    readied: authored.filter((p) => inWin(p.r)),
    winReviews: reviews.filter((r) => inWin(r.at)),
    stillOpen: authored.filter((p) => p.open),
    last,
  };
}

export interface FilterOptions {
  /** Every area with how many PRs touch it, most common first. */
  areas: [string, number][];
  /** Every human author or reviewer, alphabetical. */
  people: string[];
}

/** What the area and contributor filters offer, taken from the data itself. */
export function filterOptions(prs: readonly MetricPr[], bots: ReadonlySet<string>): FilterOptions {
  const counts = new Map<string, number>();
  for (const p of prs) for (const a of p.ar) counts.set(a, (counts.get(a) ?? 0) + 1);
  const byPerson = new Map<string, number>();
  for (const p of prs) {
    if (p.bot) continue;
    if (p.a) byPerson.set(p.a, (byPerson.get(p.a) ?? 0) + 1);
    for (const [who] of p.rv) if (!bots.has(who) && !byPerson.has(who)) byPerson.set(who, 0);
  }
  return {
    areas: [...counts].toSorted((x, y) => y[1] - x[1]),
    people: [...byPerson.keys()].toSorted((x, y) => x.localeCompare(y)),
  };
}
