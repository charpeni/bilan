import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { derive } from './derive.ts';
import { createFilterState, filterOptions, scope, windowed } from './scope.ts';

import type { FilterState } from './scope.ts';

const LAST = T0 + 100 * DAY_MS;
const bots = new Set(['dependabot[bot]']);

const prs = derive([
  // Opened before a 30-day window, merged inside it.
  payloadPr({
    n: 1,
    a: 'alice',
    c: LAST - 40 * DAY_MS,
    r: LAST - 40 * DAY_MS,
    m: LAST - 10 * DAY_MS,
    x: LAST - 10 * DAY_MS,
    ar: ['api'],
    rv: [['bob', 'APPROVED', LAST - 35 * DAY_MS]],
  }),
  // Opened and still open inside the window.
  payloadPr({
    n: 2,
    a: 'bob',
    c: LAST - 5 * DAY_MS,
    r: LAST - 5 * DAY_MS,
    m: null,
    x: null,
    s: 'OPEN',
    mb: null,
    ar: ['web'],
    rv: [['alice', 'COMMENTED', LAST - 4 * DAY_MS]],
  }),
  // Closed unmerged long before the window.
  payloadPr({
    n: 3,
    a: 'alice',
    c: LAST - 80 * DAY_MS,
    r: LAST - 80 * DAY_MS,
    m: null,
    x: LAST - 70 * DAY_MS,
    s: 'CLOSED',
    mb: null,
    ar: ['api', 'web'],
    rv: [['dependabot[bot]', 'COMMENTED', LAST - 75 * DAY_MS]],
  }),
  // A bot PR inside the window, reviewed by a human.
  payloadPr({
    n: 4,
    a: 'dependabot[bot]',
    bot: 1,
    c: LAST - 2 * DAY_MS,
    r: LAST - 2 * DAY_MS,
    m: LAST - DAY_MS,
    x: LAST - DAY_MS,
    ar: ['deps'],
    rv: [['carol', 'APPROVED', LAST - 2 * DAY_MS + HOUR_MS]],
  }),
]);

const state = (over: Partial<FilterState> = {}): FilterState => ({
  ...createFilterState(),
  ...over,
});

describe('createFilterState', () => {
  it('starts on all time, everyone, every area, bots hidden', () => {
    expect(createFilterState()).toEqual({ range: 'all', area: '', person: '', hideBots: true });
  });
});

describe('scope', () => {
  it('keeps everything human on all time with bots hidden', () => {
    const s = scope(prs, bots, state(), LAST);
    expect(s.from).toBe(-Infinity);
    expect(s.base.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(s.authored).toBe(s.base);
    expect(s.focus).toBeNull();
    expect(s.reviews.map((r) => [r.who, r.pr.n])).toEqual([
      ['bob', 1],
      ['alice', 2],
    ]);
    expect(s.skip).toBe(bots);
  });

  it('includes bot authors and bot reviews when bots are shown', () => {
    const s = scope(prs, bots, state({ hideBots: false }), LAST);
    expect(s.base.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    expect(s.reviews.map((r) => r.who)).toEqual(['bob', 'alice', 'dependabot[bot]', 'carol']);
    expect(s.skip.size).toBe(0);
  });

  it('narrows to PRs touching the chosen area', () => {
    const s = scope(prs, bots, state({ area: 'web' }), LAST);
    expect(s.base.map((p) => p.n)).toEqual([2, 3]);
  });

  it('focuses a person on both what they authored and what they reviewed', () => {
    const s = scope(prs, bots, state({ person: 'alice' }), LAST);
    expect(s.focus).toBe('alice');
    expect(s.base.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(s.authored.map((p) => p.n)).toEqual([1, 3]);
    expect(s.reviews.map((r) => [r.who, r.pr.n])).toEqual([['alice', 2]]);
  });

  it('measures the window back from the last activity', () => {
    const s = scope(prs, bots, state({ range: '30' }), LAST);
    expect(s.from).toBe(LAST - 30 * DAY_MS);
    expect(s.inWin(LAST - 30 * DAY_MS)).toBe(true);
    expect(s.inWin(LAST - 30 * DAY_MS - 1)).toBe(false);
    expect(s.inWin(null)).toBe(false);
    expect(s.inWin(undefined)).toBe(false);
  });
});

describe('windowed', () => {
  it('anchors each metric to its own event', () => {
    const w = windowed(scope(prs, bots, state({ range: '30' }), LAST), LAST);
    // #1 was opened before the window but merged inside it.
    expect(w.opened.map((p) => p.n)).toEqual([2]);
    expect(w.merged.map((p) => p.n)).toEqual([1]);
    expect(w.readied.map((p) => p.n)).toEqual([2]);
    expect(w.rejected).toEqual([]);
    // Only the review submitted inside the window counts.
    expect(w.winReviews.map((r) => r.who)).toEqual(['alice']);
    // Still open is not windowed at all.
    expect(w.stillOpen.map((p) => p.n)).toEqual([2]);
    expect(w.last).toBe(LAST);
  });

  it('counts the close, not the opening, for a PR closed without merging', () => {
    const w = windowed(scope(prs, bots, state({ range: '90' }), LAST), LAST);
    expect(w.opened.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(w.rejected.map((p) => p.n)).toEqual([3]);
  });
});

describe('filterOptions', () => {
  it('lists areas by how many PRs touch them and humans alphabetically', () => {
    const o = filterOptions(prs, bots);
    expect(o.areas).toEqual([
      ['api', 2],
      ['web', 2],
      ['deps', 1],
    ]);
    // carol only reviewed a bot PR, so she is not offered; dependabot is a bot.
    expect(o.people).toEqual(['alice', 'bob']);
  });
});
