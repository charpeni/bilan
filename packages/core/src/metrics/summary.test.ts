import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
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
    // Nearest rank: index floor(4 * 0.9) = 3 of the sorted five.
    expect(h.p90Merge).toBe(4 * DAY_MS);
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
