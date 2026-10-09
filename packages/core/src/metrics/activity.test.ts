import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { areaActivity } from './activity.ts';
import { derive } from './derive.ts';
import { createFilterState, scope, windowed } from './scope.ts';
import { monthStart } from './time.ts';

import type { PayloadPr } from '../types.ts';
import type { FilterState } from './scope.ts';

// T0 is a Monday 09:00 UTC, so its week starts at T0 - 9h.
const W0 = T0 - 9 * HOUR_MS;
const WEEK = 7 * DAY_MS;

/** A PR opened in week 0 and merged `at`, touching `ar`. */
const mergedAt = (n: number, at: number, ar: string[], over: Partial<PayloadPr> = {}) =>
  payloadPr({ n, c: W0 + HOUR_MS, r: W0 + HOUR_MS, m: at, x: at, ar, ...over });

const win = (prs: PayloadPr[], last: number, over: Partial<FilterState> = {}) =>
  windowed(scope(derive(prs), new Set(), { ...createFilterState(), ...over }, last), last);

describe('areaActivity', () => {
  const LAST = W0 + 2 * WEEK + DAY_MS;
  const prs = [
    mergedAt(1, W0 + DAY_MS, ['api', 'web']),
    mergedAt(2, W0 + 2 * DAY_MS, ['api']),
    mergedAt(3, W0 + WEEK + DAY_MS, ['docs']),
    mergedAt(4, W0 + 2 * WEEK, ['api']),
    // Never merged, and opened in week 1: no cell, but it is still data.
    payloadPr({ n: 5, c: W0 + WEEK, r: W0 + WEEK, m: null, x: null, s: 'OPEN', ar: ['web'] }),
  ];

  it('counts merged PRs per area and UTC day on a short window', () => {
    const act = areaActivity(win(prs, LAST, { range: '7' }), 'day');
    const from = W0 + WEEK + DAY_MS;
    expect(act.periods).toEqual(Array.from({ length: 8 }, (_, i) => from + i * DAY_MS));
    expect(act.rows).toEqual([
      { area: 'api', counts: [0, 0, 0, 0, 0, 0, 1, 0], total: 1 },
      { area: 'docs', counts: [1, 0, 0, 0, 0, 0, 0, 0], total: 1 },
    ]);
  });

  it('counts merged PRs per area and ISO week, busiest area first', () => {
    const act = areaActivity(win(prs, LAST), 'week');
    expect(act.periods).toEqual([W0, W0 + WEEK, W0 + 2 * WEEK]);
    expect(act.rows).toEqual([
      { area: 'api', counts: [2, 0, 1], total: 3 },
      // Ties read alphabetically.
      { area: 'docs', counts: [0, 1, 0], total: 1 },
      { area: 'web', counts: [1, 0, 0], total: 1 },
    ]);
  });

  it('keeps the busiest areas only', () => {
    expect(areaActivity(win(prs, LAST), 'week', 2).rows.map((r) => r.area)).toEqual([
      'api',
      'docs',
    ]);
  });

  it('follows the window and the person filter', () => {
    const recent = areaActivity(win(prs, LAST, { range: '10' }), 'week');
    // The window starts mid-week 0, so week 0 stays a column with nothing in it.
    expect(recent.periods).toHaveLength(3);
    expect(recent.rows).toEqual([
      { area: 'api', counts: [0, 0, 1], total: 1 },
      { area: 'docs', counts: [0, 1, 0], total: 1 },
    ]);
    const bobs = areaActivity(
      win([...prs, mergedAt(6, W0 + WEEK, ['ci'], { a: 'bob' })], LAST, { person: 'bob' }),
      'week',
    );
    expect(bobs.rows).toEqual([{ area: 'ci', counts: [0, 1, 0], total: 1 }]);
  });

  it('buckets by UTC calendar month, across a year end', () => {
    const nov = Date.UTC(2025, 10, 20);
    const dec = Date.UTC(2025, 11, 31, 23);
    const jan = Date.UTC(2026, 0, 1);
    const act = areaActivity(
      win(
        [
          payloadPr({ n: 1, c: nov, r: nov, m: dec, x: dec, ar: ['api'] }),
          payloadPr({ n: 2, c: dec, r: dec, m: jan, x: jan, ar: ['api'] }),
        ],
        Date.UTC(2026, 1, 3),
      ),
      'month',
    );
    expect(act.periods).toEqual([
      Date.UTC(2025, 10, 1),
      Date.UTC(2025, 11, 1),
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 1, 1),
    ]);
    expect(act.rows).toEqual([{ area: 'api', counts: [0, 1, 1, 0], total: 2 }]);
  });

  it('is empty when nothing is in scope', () => {
    expect(areaActivity(win([], LAST), 'week')).toEqual({ periods: [], rows: [] });
    expect(areaActivity(win([], LAST), 'month')).toEqual({ periods: [], rows: [] });
  });
});

describe('monthStart', () => {
  it('anchors to the first of the month, 00:00 UTC', () => {
    expect(monthStart(Date.UTC(2026, 2, 31, 23, 59))).toBe(Date.UTC(2026, 2, 1));
    expect(monthStart(Date.UTC(2026, 3, 1))).toBe(Date.UTC(2026, 3, 1));
  });
});
