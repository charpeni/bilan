import { describe, expect, it } from 'vitest';

import { COPILOT, DAY_MS, HOUR_MS, T0, botFirstPrs, payloadPr } from '../testing/fixtures.ts';
import { derive } from './derive.ts';
import { createFilterState, scope, windowed } from './scope.ts';
import { headline } from './summary.ts';
import { dayStart, weekStart } from './time.ts';
import { cycleTimeTrend, openBacklog, throughput, timeBuckets } from './weekly.ts';

import type { FilterState } from './scope.ts';

// T0 is a Monday 09:00 UTC, so its week starts at T0 - 9h.
const W0 = T0 - 9 * HOUR_MS;
const LAST = W0 + 3 * 7 * DAY_MS + DAY_MS;

const prs = derive([
  // Opened Sunday night of week 0, merged Monday morning of week 1.
  payloadPr({
    n: 1,
    c: W0 + 7 * DAY_MS - HOUR_MS,
    r: W0 + 7 * DAY_MS - HOUR_MS,
    m: W0 + 7 * DAY_MS + HOUR_MS,
    x: W0 + 7 * DAY_MS + HOUR_MS,
    rv: [['bob', 'APPROVED', W0 + 7 * DAY_MS]],
  }),
  // Opened week 1, closed unmerged week 2.
  payloadPr({
    n: 2,
    c: W0 + 8 * DAY_MS,
    r: W0 + 8 * DAY_MS,
    m: null,
    x: W0 + 15 * DAY_MS,
    s: 'CLOSED',
    mb: null,
    rv: [],
  }),
  // Opened week 2, still open.
  payloadPr({
    n: 3,
    c: W0 + 16 * DAY_MS,
    r: W0 + 16 * DAY_MS,
    m: null,
    x: null,
    s: 'OPEN',
    rv: [],
  }),
]);

const sc = (over: Partial<FilterState> = {}) =>
  scope(prs, new Set(), { ...createFilterState(), ...over }, LAST);

describe('weekStart', () => {
  it('anchors to Monday 00:00 UTC', () => {
    expect(weekStart(T0)).toBe(W0);
    expect(weekStart(W0 + 6 * DAY_MS + 23 * HOUR_MS)).toBe(W0);
    expect(weekStart(W0 + 7 * DAY_MS)).toBe(W0 + 7 * DAY_MS);
  });
});

describe('dayStart', () => {
  it('anchors to 00:00 UTC', () => {
    expect(dayStart(T0)).toBe(W0);
    expect(dayStart(W0 + DAY_MS - 1)).toBe(W0);
    expect(dayStart(W0 + DAY_MS)).toBe(W0 + DAY_MS);
  });
});

describe('timeBuckets', () => {
  it('handles all-time histories larger than the engine argument limit', () => {
    const s = { ...sc(), authored: Array.from({ length: 150_000 }, () => prs[0]!) };
    expect(timeBuckets(s, LAST).start).toBe(W0);
  });

  it('runs from the first opening to the last activity on all time', () => {
    const wb = timeBuckets(sc(), LAST);
    expect(wb.start).toBe(W0);
    expect(wb.starts).toEqual([W0, W0 + 7 * DAY_MS, W0 + 14 * DAY_MS, W0 + 21 * DAY_MS]);
    expect(wb.idxOf(W0 + 7 * DAY_MS - 1)).toBe(0);
    expect(wb.idxOf(W0 + 7 * DAY_MS)).toBe(1);
    expect(wb.inRange(-1)).toBe(false);
    expect(wb.inRange(4)).toBe(false);
  });

  it('starts at the week of the window start on a range', () => {
    const s = sc({ range: '10' });
    const wb = timeBuckets(s, LAST);
    expect(wb.start).toBe(weekStart(s.from));
  });

  it('runs by UTC day from the day of the window start', () => {
    const s = sc({ range: '7' });
    const db = timeBuckets(s, LAST, 'day');
    expect(db.start).toBe(dayStart(s.from));
    expect(db.size).toBe(DAY_MS);
    // Seven days back from a midnight: that day, the six after it, and the current one.
    expect(db.starts).toEqual(Array.from({ length: 8 }, (_, i) => db.start + i * DAY_MS));
    expect(db.idxOf(db.start + DAY_MS - 1)).toBe(0);
    expect(db.idxOf(db.start + DAY_MS)).toBe(1);
  });
});

describe('throughput', () => {
  it('buckets opened, merged, and closed by their own week', () => {
    const t = throughput(sc(), timeBuckets(sc(), LAST));
    expect(t.opened).toEqual([1, 1, 1, 0]);
    expect(t.merged).toEqual([0, 1, 0, 0]);
    expect(t.closed).toEqual([0, 0, 1, 0]);
  });

  it('drops events before the window even when their week bucket exists', () => {
    const s = sc({ range: '10' });
    const t = throughput(s, timeBuckets(s, LAST));
    // Window starts mid week 1: #1's merge (Monday of week 1) is before it,
    // and #2's opening (week 1) is too, while its close (week 2) is inside.
    expect(t.merged).toEqual([0, 0, 0]);
    expect(t.opened).toEqual([0, 1, 0]);
    expect(t.closed).toEqual([0, 1, 0]);
  });

  it('buckets by the day of each event on a daily read', () => {
    const s = sc({ range: '7' });
    const t = throughput(s, timeBuckets(s, LAST, 'day'));
    // #2 closed exactly at the shared boundary, so belongs to the previous period.
    expect(t.closed).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(t.opened).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
  });
});

describe('openBacklog', () => {
  it('counts PRs open at the end of each week', () => {
    expect(openBacklog(sc(), timeBuckets(sc(), LAST)).open).toEqual([1, 1, 1, 1]);
  });

  it('counts PRs open at the end of each day on a daily read', () => {
    const s = sc({ range: '7' });
    // #2 closed at the first day's start; #3 opened the next day and stays open.
    expect(openBacklog(s, timeBuckets(s, LAST, 'day')).open).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('counts the open PRs that were still drafts at each week end', () => {
    const drafted = derive([
      // Opened as a draft in week 0, marked ready mid week 1, merged in week 2.
      payloadPr({
        n: 1,
        c: W0 + 2 * DAY_MS,
        d: 1,
        r: W0 + 9 * DAY_MS,
        m: W0 + 15 * DAY_MS,
        x: W0 + 15 * DAY_MS,
        rv: [],
      }),
      // Opened as a draft in week 1 and never marked ready: still open, still a draft.
      payloadPr({
        n: 2,
        c: W0 + 8 * DAY_MS,
        d: 1,
        r: null,
        m: null,
        x: null,
        s: 'OPEN',
        dr: 1,
        mb: null,
        rv: [],
      }),
      // Opened ready in week 0, still open: never a draft.
      payloadPr({ n: 3, c: W0 + DAY_MS, r: W0 + DAY_MS, m: null, x: null, s: 'OPEN', rv: [] }),
    ]);
    const s = scope(drafted, new Set(), createFilterState(), LAST);
    const backlog = openBacklog(s, timeBuckets(s, LAST));
    expect(backlog.open).toEqual([2, 3, 2, 2]);
    expect(backlog.drafts).toEqual([1, 1, 1, 1]);
  });
});

describe('cycleTimeTrend', () => {
  it('reports weekly median hours, null where a week has no data', () => {
    const t = cycleTimeTrend(sc(), timeBuckets(sc(), LAST));
    // #1 became ready on the Sunday of week 0 and was reviewed and merged on
    // the Monday of week 1: its wait for a review belongs to the week it
    // became ready, its time to merge to the week it merged.
    expect(t.toFirst).toEqual([1, null, null, null]);
    expect(t.toMerge).toEqual([null, 2, null, null]);
  });

  it('counts a first review for the same days the headline does', () => {
    // Ready in week 0, first reviewed two weeks later.
    const slow = derive([
      payloadPr({
        n: 9,
        c: W0 + DAY_MS,
        r: W0 + DAY_MS,
        m: null,
        x: null,
        s: 'OPEN',
        mb: null,
        rv: [['bob', 'APPROVED', W0 + 15 * DAY_MS]],
      }),
    ]);
    const all = scope(slow, new Set(), createFilterState(), LAST);
    expect(cycleTimeTrend(all, timeBuckets(all, LAST)).toFirst).toEqual([
      14 * 24,
      null,
      null,
      null,
    ]);
    // In the last 7 days it was reviewed but did not become ready: the
    // headline has no time to first review for it, and neither has the trend.
    const week = scope(slow, new Set(), { ...createFilterState(), range: '7' }, LAST);
    expect(headline(windowed(week, LAST)).medFirst).toBeNull();
    expect(cycleTimeTrend(week, timeBuckets(week, LAST)).toFirst.every((v) => v === null)).toBe(
      true,
    );
  });
});

describe('cycleTimeTrend with bot reviewers', () => {
  it('buckets the first human review while bots are hidden', () => {
    const botPrs = derive(botFirstPrs());
    const trend = (hideBots: boolean) => {
      const s = scope(botPrs, new Set([COPILOT]), { ...createFilterState(), hideBots }, LAST);
      return cycleTimeTrend(s, timeBuckets(s, LAST)).toFirst;
    };
    // Every PR was ready at T0; bob's review on #2 lands three days later, the same week.
    expect(trend(true)[0]).toBe(72);
    expect(trend(false)[0]).toBe(1 / 60);
  });
});
