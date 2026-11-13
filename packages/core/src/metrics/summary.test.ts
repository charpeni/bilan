import { describe, expect, it } from 'vitest';

import { COPILOT, DAY_MS, HOUR_MS, T0, botFirstPrs, payloadPr } from '../testing/fixtures.ts';
import { derive } from './derive.ts';
import { createFilterState, scope, windowed } from './scope.ts';
import { headline } from './summary.ts';

const LAST = T0 + 20 * DAY_MS;
const win = (prs: ReturnType<typeof derive>) =>
  windowed(scope(prs, new Set(), createFilterState(), LAST), LAST);

describe('headline', () => {
  it('reports medians and p90 of ready-anchored latencies', () => {
    const prs = derive(
      [1, 2, 3, 4, 10].map((days, i) =>
        payloadPr({
          n: i + 1,
          c: T0,
          r: T0 + HOUR_MS,
          m: T0 + HOUR_MS + days * DAY_MS,
          x: T0 + HOUR_MS + days * DAY_MS,
          rv: [['bob', 'APPROVED', T0 + HOUR_MS + i * HOUR_MS]],
        }),
      ),
    );
    const h = headline(win(prs));
    expect(h.merged).toBe(5);
    expect(h.medMerge).toBe(3 * DAY_MS);
    // Nearest rank: the ceil(0.9 * 5) = 5th smallest of the five.
    expect(h.p90Merge).toBe(10 * DAY_MS);
    expect(h.medFirst).toBe(2 * HOUR_MS);
    expect(h.reviewedShare).toBe(1);
  });

  it('counts authors, resolved share, drafts, and reviewers', () => {
    const prs = derive([
      payloadPr({ n: 1, a: 'alice', d: 1, r: T0 + 4 * HOUR_MS }),
      payloadPr({ n: 2, a: 'alice', rv: [] }),
      payloadPr({ n: 3, a: 'bob', m: null, x: T0 + HOUR_MS, s: 'CLOSED', mb: null, rv: [] }),
      payloadPr({
        n: 4,
        a: 'carol',
        m: null,
        x: null,
        s: 'OPEN',
        mb: null,
        rv: [['alice', 'COMMENTED', T0 + HOUR_MS]],
      }),
    ]);
    const h = headline(win(prs));
    expect(h).toMatchObject({
      opened: 4,
      authors: 3,
      merged: 2,
      rejected: 1,
      stillOpen: 1,
      reviews: 2,
      reviewers: 2,
    });
    expect(h.mergedShare).toBeCloseTo(2 / 3);
    expect(h.draftShare).toBe(0.25);
    expect(h.medReady).toBe(4 * HOUR_MS);
    expect(h.reviewedShare).toBe(0.5);
  });

  it('shares merged over resolved, whatever was opened in the window', () => {
    // A 7-day window ending at LAST: everything below is resolved inside it.
    const lastWeek = (prs: ReturnType<typeof derive>) =>
      windowed(scope(prs, new Set(), { ...createFilterState(), range: '7' }, LAST), LAST);
    const before = LAST - 10 * DAY_MS;
    const merged = (n: number) =>
      payloadPr({ n, c: before, r: before, m: LAST - DAY_MS, x: LAST - DAY_MS });
    const closed = (n: number) =>
      payloadPr({ n, c: before, r: before, m: null, x: LAST - DAY_MS, s: 'CLOSED', mb: null });

    const oneMerged = headline(lastWeek(derive([merged(1)])));
    expect(oneMerged).toMatchObject({ opened: 0, merged: 1, mergedShare: 1 });

    const mixed = headline(lastWeek(derive([merged(1), merged(2), merged(3), closed(4)])));
    expect(mixed).toMatchObject({ opened: 0, merged: 3, rejected: 1, mergedShare: 0.75 });
  });

  it('has no merged share when something was opened but nothing resolved', () => {
    const prs = derive([payloadPr({ m: null, x: null, s: 'OPEN', mb: null, rv: [] })]);
    const h = headline(win(prs));
    expect(h).toMatchObject({ opened: 1, merged: 0, rejected: 0, stillOpen: 1 });
    expect(h.mergedShare).toBeNull();
  });

  it('does not count a bot review as the first review while bots are hidden', () => {
    const prs = derive(botFirstPrs());
    const at = (hideBots: boolean) =>
      headline(
        windowed(scope(prs, new Set([COPILOT]), { ...createFilterState(), hideBots }, LAST), LAST),
      );
    // Only #2 has a human review, three days after it was ready.
    expect(at(true)).toMatchObject({ medFirst: 3 * DAY_MS, reviews: 1, reviewers: 1 });
    expect(at(true).reviewedShare).toBeCloseTo(1 / 3);
    expect(at(false)).toMatchObject({ medFirst: 60e3, reviewedShare: 1, reviews: 4, reviewers: 2 });
  });

  it('is all nulls and zeros with nothing in range', () => {
    const h = headline(win([]));
    expect(h).toEqual({
      opened: 0,
      authors: 0,
      merged: 0,
      mergedShare: null,
      rejected: 0,
      stillOpen: 0,
      medMerge: null,
      p90Merge: null,
      medFirst: null,
      reviewedShare: null,
      medReady: null,
      draftShare: null,
      reviews: 0,
      reviewers: 0,
    });
  });
});
