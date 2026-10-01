import { firstActivity } from './derive.ts';
import { sum } from './stats.ts';
import { monthStart } from './time.ts';
import { weekBuckets } from './weekly.ts';

import type { Windowed } from './scope.ts';

/** The heatmap's columns: ISO weeks, or calendar months for a whole history. */
export type Period = 'week' | 'month';

export interface AreaActivityRow {
  area: string;
  /** Merged PRs per period. */
  counts: number[];
  /** Merged PRs over every period. */
  total: number;
}

export interface AreaActivity {
  /** Period start timestamps, oldest first. */
  periods: number[];
  /** The busiest areas, most merged PRs first. */
  rows: AreaActivityRow[];
}

interface Periods {
  periods: number[];
  /** Period index of a timestamp; may be out of range. */
  idxOf: (t: number) => number;
}

/** UTC months from the start of the window (or of the data) to `last`. */
function monthBuckets(w: Windowed): Periods {
  const first = new Date(monthStart(w.from === -Infinity ? firstActivity(w.authored) : w.from));
  const y0 = first.getUTCFullYear();
  const m0 = first.getUTCMonth();
  const periods: number[] = [];
  for (let i = 0; Date.UTC(y0, m0 + i, 1) <= w.last; i++) periods.push(Date.UTC(y0, m0 + i, 1));
  return {
    periods,
    idxOf: (t) => {
      const d = new Date(t);
      return (d.getUTCFullYear() - y0) * 12 + d.getUTCMonth() - m0;
    },
  };
}

function periodsOf(w: Windowed, period: Period): Periods {
  if (period === 'month') return monthBuckets(w);
  const wb = weekBuckets(w, w.last);
  return { periods: wb.weeks, idxOf: wb.idxOf };
}

/**
 * Merged PRs per area and period, for the `limit` areas with the most merged
 * PRs in the window. Weeks are the trend charts' (`weekBuckets`); months keep
 * a whole history to a readable number of columns. A PR touching two areas
 * counts in both.
 */
export function areaActivity(w: Windowed, period: Period, limit = 14): AreaActivity {
  const { periods, idxOf } = periodsOf(w, period);
  const byArea = new Map<string, number[]>();
  for (const p of w.merged) {
    const i = idxOf(p.m);
    if (!(i >= 0 && i < periods.length)) continue;
    for (const a of p.ar) {
      let counts = byArea.get(a);
      if (!counts) {
        counts = periods.map(() => 0);
        byArea.set(a, counts);
      }
      counts[i] = (counts[i] ?? 0) + 1;
    }
  }
  const rows = [...byArea]
    .map(([area, counts]) => ({ area, counts, total: sum(counts) }))
    .toSorted((a, b) => b.total - a.total || a.area.localeCompare(b.area))
    .slice(0, limit);
  return { periods, rows };
}
