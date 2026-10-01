import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { isQuiet, reviewDepth } from './depth.ts';
import { derive } from './derive.ts';
import { createFilterState, scope, windowed } from './scope.ts';

import type { PayloadReview } from '../types.ts';
import type { FilterState } from './scope.ts';

const LAST = T0 + 30 * DAY_MS;
const bots = new Set(['copilot[bot]']);
const win = (prs: ReturnType<typeof derive>, over: Partial<FilterState> = {}) =>
  windowed(scope(prs, bots, { ...createFilterState(), ...over }, LAST), LAST);

const quiet = (over: Parameters<typeof payloadPr>[0]) =>
  derive([payloadPr(over)]).map((p) => isQuiet(p, bots))[0];

describe('isQuiet', () => {
  it('needs reviews, every one an approval, and no threads', () => {
    expect(quiet({})).toBe(true);
    expect(quiet({ th: 1 })).toBe(false);
    expect(quiet({ rv: [] })).toBe(false);
    expect(
      quiet({
        rv: [
          ['carol', 'COMMENTED', T0 + HOUR_MS],
          ['bob', 'APPROVED', T0 + 2 * HOUR_MS],
        ],
      }),
    ).toBe(false);
  });

  it('leaves out the skipped reviewers', () => {
    const rv: PayloadReview[] = [
      ['copilot[bot]', 'COMMENTED', T0 + HOUR_MS],
      ['bob', 'APPROVED', T0 + 2 * HOUR_MS],
    ];
    expect(quiet({ rv })).toBe(true);
    expect(quiet({ rv: [['copilot[bot]', 'APPROVED', T0 + HOUR_MS]] })).toBe(false);
  });
});

describe('reviewDepth', () => {
  const prs = derive([
    // ≤50: one quiet approval, one with threads and a bot comment before the approval.
    payloadPr({ n: 1, ad: 40, de: 10 }),
    payloadPr({
      n: 2,
      ad: 20,
      de: 0,
      th: 3,
      rv: [
        ['copilot[bot]', 'COMMENTED', T0 + HOUR_MS],
        ['bob', 'CHANGES_REQUESTED', T0 + 2 * HOUR_MS],
        ['bob', 'APPROVED', T0 + 6 * HOUR_MS],
      ],
    }),
    // 51–250: merged with no review at all.
    payloadPr({ n: 3, ad: 51, de: 0, rv: [] }),
    // 1k+: two threads, approved a day after ready.
    payloadPr({
      n: 4,
      ad: 900,
      de: 101,
      th: 2,
      rv: [['carol', 'APPROVED', T0 + DAY_MS]],
      m: T0 + 2 * DAY_MS,
      x: T0 + 2 * DAY_MS,
    }),
    // Still open: not part of any band.
    payloadPr({ n: 5, ad: 5000, de: 0, m: null, x: null, s: 'OPEN', mb: null }),
  ]);

  it('groups merged PRs by size, smallest band first', () => {
    const bands = reviewDepth(win(prs));
    expect(bands.map((b) => [b.label, b.edge, b.merged])).toEqual([
      ['≤50', 51, 2],
      ['51–250', 251, 1],
      ['251–500', 501, 0],
      ['501–1k', 1001, 0],
      ['1k+', Infinity, 1],
    ]);
  });

  it('reads threads, quiet approvals, and time to the first approval per band', () => {
    const [small, mid, , , large] = reviewDepth(win(prs));
    expect(small).toMatchObject({
      threads: 1.5,
      quiet: 1,
      quietShare: 0.5,
      // 2h for #1 and 6h for #2: the bot comment and the change request are not approvals.
      medApproval: 4 * HOUR_MS,
    });
    expect(mid).toMatchObject({ threads: 0, quiet: 0, quietShare: 0, medApproval: null });
    expect(large).toMatchObject({ threads: 2, quiet: 0, quietShare: 0, medApproval: DAY_MS });
  });

  it('leaves empty bands without averages', () => {
    const band = reviewDepth(win(prs))[2];
    expect(band).toMatchObject({ merged: 0, threads: null, quietShare: null, medApproval: null });
  });

  it('follows the filter row: the window, and bot reviews only while bots are hidden', () => {
    const late = derive([
      payloadPr({ n: 6, m: LAST - DAY_MS, x: LAST - DAY_MS }),
      payloadPr({
        n: 7,
        m: LAST - DAY_MS,
        x: LAST - DAY_MS,
        rv: [
          ['copilot[bot]', 'COMMENTED', T0 + HOUR_MS],
          ['bob', 'APPROVED', T0 + 2 * HOUR_MS],
        ],
      }),
    ]);
    const all = [...prs, ...late];
    expect(reviewDepth(win(all, { range: '7' }))[0]).toMatchObject({ merged: 2, quiet: 2 });
    expect(reviewDepth(win(all, { range: '7', hideBots: false }))[0]).toMatchObject({
      merged: 2,
      quiet: 1,
    });
  });
});
