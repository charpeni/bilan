import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { derive, isMerged } from './derive.ts';
import {
  busFactor,
  contributorRows,
  reviewPairs,
  reviewerRows,
  roster,
  topReviewers,
} from './people.ts';
import { createFilterState, scope, windowed } from './scope.ts';

const LAST = T0 + 10 * DAY_MS;
const win = (prs: ReturnType<typeof derive>) =>
  windowed(scope(prs, new Set(), createFilterState(), LAST), LAST);

const prs = derive([
  payloadPr({
    n: 1,
    a: 'alice',
    d: 1,
    r: T0 + 2 * HOUR_MS,
    m: T0 + DAY_MS,
    ad: 100,
    de: 20,
    ar: ['api'],
    rv: [
      ['bob', 'CHANGES_REQUESTED', T0 + 5 * HOUR_MS],
      ['bob', 'APPROVED', T0 + 9 * HOUR_MS],
    ],
    rq: [['bob', T0 + 3 * HOUR_MS]],
  }),
  payloadPr({
    n: 2,
    a: 'alice',
    c: T0 + DAY_MS,
    r: T0 + DAY_MS,
    m: T0 + 2 * DAY_MS,
    x: T0 + 2 * DAY_MS,
    mb: 'alice',
    ar: ['api'],
    rv: [],
    rq: [],
  }),
  payloadPr({
    n: 3,
    a: 'bob',
    c: T0 + 2 * DAY_MS,
    r: T0 + 2 * DAY_MS,
    m: null,
    x: T0 + 3 * DAY_MS,
    s: 'CLOSED',
    mb: null,
    ar: ['web'],
    rv: [['alice', 'COMMENTED', T0 + 2 * DAY_MS + HOUR_MS]],
    rq: [],
  }),
  payloadPr({
    n: 4,
    a: 'carol',
    c: T0 + 4 * DAY_MS,
    r: T0 + 4 * DAY_MS,
    m: null,
    x: null,
    s: 'OPEN',
    mb: null,
    ar: ['web'],
    rv: [],
    rq: [],
  }),
]);

describe('roster', () => {
  it('aggregates authoring and reviewing per person in first-seen order', () => {
    const people = roster(win(prs));
    expect(people.map((r) => r.login)).toEqual(['alice', 'bob', 'carol']);
    const alice = people[0]!;
    expect(alice).toMatchObject({
      opened: 2,
      merged: 2,
      closed: 0,
      open: 0,
      add: 110,
      del: 22,
      reviewsGiven: 1,
      commentsOnly: 1,
      unreviewedMerges: 1,
      selfMerges: 1,
    });
    expect(alice.toReady).toEqual([2 * HOUR_MS]);
    expect(alice.toFirst).toEqual([3 * HOUR_MS]);
    expect(alice.areas).toEqual(new Set(['api']));
    expect(alice.reviewersUsed).toEqual(new Set(['bob']));
    const bob = people[1]!;
    expect(bob).toMatchObject({
      opened: 1,
      closed: 1,
      reviewsGiven: 2,
      changesReq: 1,
      approvals: 1,
    });
  });

  it('measures turnaround from the latest request before the first review', () => {
    const bob = roster(win(prs))[1]!;
    // Requested at +3h, first review at +5h; the second pass is not a turnaround.
    expect(bob.response).toEqual([2 * HOUR_MS]);
    expect(bob.prsReviewed).toEqual(new Set([1]));
    expect(bob.authorsReviewed).toEqual(new Set(['alice']));
  });

  it('does not count a follow-up review as a first response when the window cuts off the first', () => {
    const last = T0 + 40 * DAY_MS;
    const reviewed = derive([
      payloadPr({
        n: 1,
        a: 'alice',
        m: null,
        x: null,
        s: 'OPEN',
        mb: null,
        rv: [
          ['bob', 'CHANGES_REQUESTED', T0 + DAY_MS],
          ['bob', 'APPROVED', T0 + 35 * DAY_MS],
        ],
        rq: [['bob', T0]],
      }),
    ]);
    const state = { ...createFilterState(), range: '10' };
    const bob = roster(windowed(scope(reviewed, new Set(), state, last), last)).find(
      (r) => r.login === 'bob',
    )!;
    // Only the day-35 follow-up is in the window: it counts as a review, not as a response.
    expect(bob.reviewsGiven).toBe(1);
    expect(bob.response).toEqual([]);
    // Over all time the day-1 review is the response.
    const all = roster(win(reviewed)).find((r) => r.login === 'bob')!;
    expect(all.response).toEqual([DAY_MS]);
  });
});

describe('contributorRows', () => {
  it('derives rates and medians per contributor', () => {
    const [alice, bob, carol] = contributorRows(roster(win(prs)));
    expect(alice).toMatchObject({
      login: 'alice',
      mergeRate: 1,
      medDraft: 2 * HOUR_MS,
      medFirst: 3 * HOUR_MS,
      medMerge: (22 * HOUR_MS + DAY_MS) / 2,
      medSize: (120 + 12) / 2,
      areas: 1,
      reviewRatio: 0.5,
    });
    expect(bob).toMatchObject({ mergeRate: 0, medDraft: null, reviewRatio: 2 });
    expect(carol).toMatchObject({ opened: 1, open: 1, mergeRate: null, reviewRatio: 0 });
  });
});

describe('reviewerRows', () => {
  it('lists only people who reviewed, with their share of all reviews', () => {
    const rows = reviewerRows(roster(win(prs)), 3);
    expect(rows.map((r) => r.login)).toEqual(['alice', 'bob']);
    expect(rows[1]).toMatchObject({
      reviews: 2,
      prsReviewed: 1,
      share: 2 / 3,
      pushback: 0.5,
      medTurnaround: 2 * HOUR_MS,
      p90Turnaround: 2 * HOUR_MS,
      authorsHelped: 1,
    });
  });
});

describe('topReviewers', () => {
  it('ranks by reviews given and honours the limit', () => {
    const people = roster(win(prs));
    expect(topReviewers(people).map((r) => [r.login, r.reviews])).toEqual([
      ['bob', 2],
      ['alice', 1],
    ]);
    expect(topReviewers(people, 1)).toHaveLength(1);
  });
});

describe('reviewPairs', () => {
  it('counts reviewer -> author pairs, busiest first', () => {
    expect(reviewPairs(win(prs).winReviews)).toEqual([
      { reviewer: 'bob', author: 'alice', reviews: 2 },
      { reviewer: 'alice', author: 'bob', reviews: 1 },
    ]);
  });
});

describe('busFactor', () => {
  it('counts how many authors cover half the merges per area, lowest first', () => {
    const merged = derive([
      ...Array.from({ length: 6 }, (_, i) => payloadPr({ n: i, a: 'alice', ar: ['api'] })),
      ...Array.from({ length: 2 }, (_, i) => payloadPr({ n: 10 + i, a: 'bob', ar: ['api'] })),
      ...['a', 'b', 'c', 'd', 'e'].map((a, i) => payloadPr({ n: 20 + i, a, ar: ['web'] })),
      ...Array.from({ length: 4 }, (_, i) => payloadPr({ n: 30 + i, a: 'solo', ar: ['tiny'] })),
    ]).filter(isMerged);
    expect(busFactor(merged)).toEqual([
      { area: 'api', bus: 1, total: 8, contributors: 2, top: 'alice', topShare: 0.75 },
      { area: 'web', bus: 3, total: 5, contributors: 5, top: 'a', topShare: 0.2 },
    ]);
  });
});
