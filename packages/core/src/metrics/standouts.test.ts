import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { derive } from './derive.ts';
import { roster } from './people.ts';
import { createFilterState, scope, windowed } from './scope.ts';
import { oldestOpen, standouts } from './standouts.ts';

const LAST = T0 + 30 * DAY_MS;
const win = (prs: ReturnType<typeof derive>) =>
  windowed(scope(prs, new Set(), createFilterState(), LAST), LAST);

describe('standouts', () => {
  it('computes the shares behind every insight', () => {
    const prs = derive([
      payloadPr({ n: 1, a: 'alice', m: T0 + 30 * 60e3, x: T0 + 30 * 60e3, mb: 'alice' }),
      payloadPr({ n: 2, a: 'alice', d: 1, r: T0 + 3 * HOUR_MS, rv: [], t: 'Revert "x"' }),
      payloadPr({ n: 3, a: 'bob', m: null, x: null, s: 'OPEN', mb: null, rv: [] }),
      payloadPr({
        n: 4,
        a: 'bob',
        c: T0 + 29 * DAY_MS,
        r: T0 + 29 * DAY_MS,
        m: null,
        x: null,
        s: 'OPEN',
        mb: null,
        rv: [],
      }),
    ]);
    const w = win(prs);
    const s = standouts(w, roster(w));
    expect(s).toMatchObject({
      merged: 2,
      unreviewed: 1,
      unreviewedShare: 0.5,
      approved: 1,
      approvedShare: 0.5,
      selfMergedShare: 0.5,
      reviewers: 1,
      top3Share: 1,
      fast: 1,
      fastShare: 0.5,
      opened: 4,
      draftShare: 0.25,
      medReady: 3 * HOUR_MS,
      stale: 1,
      reverts: 1,
      revertShare: 0.25,
      readied: 4,
      firstWithinDayShare: 0.25,
      p90First: 2 * HOUR_MS,
    });
    expect(s.oldest?.n).toBe(3);
    // Merge days are read in local time, so derive the expectation the same way.
    const weekend = [T0 + 30 * 60e3, T0 + DAY_MS].filter((t) =>
      [0, 6].includes(new Date(t).getDay()),
    ).length;
    expect(s.weekendMerges).toBe(weekend);
    expect(s.weekendShare).toBe(weekend / 2);
  });

  it('avoids dividing by zero for reverts and leaves other shares NaN when empty', () => {
    const w = win([]);
    const s = standouts(w, roster(w));
    expect(s.revertShare).toBe(0);
    expect(s.oldest).toBeNull();
    expect(Number.isNaN(s.unreviewedShare)).toBe(true);
  });
});

describe('oldestOpen', () => {
  it('sorts by opening time and limits', () => {
    const prs = derive(
      [3, 1, 2].map((d) =>
        payloadPr({ n: d, c: T0 + d * DAY_MS, m: null, x: null, s: 'OPEN', mb: null }),
      ),
    );
    expect(oldestOpen(prs).map((p) => p.n)).toEqual([1, 2, 3]);
    expect(oldestOpen(prs, 2).map((p) => p.n)).toEqual([1, 2]);
  });
});
