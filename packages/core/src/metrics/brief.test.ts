import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { between, brief, briefStats, change } from './brief.ts';
import { derive } from './derive.ts';

const LAST = T0 + 100 * DAY_MS;
const bots = new Set(['dependabot[bot]']);

describe('change', () => {
  it('is a rounded percentage of the previous value', () => {
    expect(change(120, 100)).toBe(20);
    expect(change(80, 100)).toBe(-20);
    expect(change(101, 300)).toBe(-66);
  });

  it('is flat at zero and "new" (null) when there was nothing before', () => {
    expect(change(100, 100)).toBe(0);
    expect(change(0, 0)).toBe(0);
    expect(change(5, 0)).toBeNull();
  });
});

describe('between', () => {
  it('is open at the far end and closed at the near end', () => {
    const cur = between(LAST, 30, 0);
    expect(cur(LAST)).toBe(true);
    expect(cur(LAST - 30 * DAY_MS)).toBe(false);
    expect(cur(LAST - 30 * DAY_MS + 1)).toBe(true);
    expect(cur(LAST + 1)).toBe(false);
    expect(cur(null)).toBe(false);
  });
});

const prs = derive([
  // Current window: merged in 2 days, reviewed by bob within a day.
  payloadPr({
    n: 1,
    a: 'alice',
    c: LAST - 10 * DAY_MS,
    r: LAST - 10 * DAY_MS,
    m: LAST - 8 * DAY_MS,
    x: LAST - 8 * DAY_MS,
    ad: 1200,
    de: 0,
    ar: ['api'],
    rv: [
      ['bob', 'APPROVED', LAST - 10 * DAY_MS + 2 * HOUR_MS],
      ['dependabot[bot]', 'COMMENTED', LAST - 10 * DAY_MS + HOUR_MS],
    ],
  }),
  // Current window: opened, unreviewed for a week, still open and ready.
  payloadPr({
    n: 2,
    a: 'bob',
    c: LAST - 7 * DAY_MS,
    r: LAST - 7 * DAY_MS,
    m: null,
    x: null,
    s: 'OPEN',
    mb: null,
    ad: 10,
    de: 0,
    rv: [],
  }),
  // Previous window: merged after 10 days.
  payloadPr({
    n: 3,
    a: 'alice',
    c: LAST - 50 * DAY_MS,
    r: LAST - 50 * DAY_MS,
    m: LAST - 40 * DAY_MS,
    x: LAST - 40 * DAY_MS,
    ad: 50,
    de: 0,
    ar: ['api'],
    rv: [['carol', 'CHANGES_REQUESTED', LAST - 48 * DAY_MS]],
  }),
  // Previous window: closed unmerged within an hour.
  payloadPr({
    n: 4,
    a: 'carol',
    c: LAST - 45 * DAY_MS,
    r: LAST - 45 * DAY_MS,
    m: null,
    x: LAST - 45 * DAY_MS + HOUR_MS,
    s: 'CLOSED',
    mb: null,
    rv: [],
  }),
  // A bot PR in the current window; never counted as human work.
  payloadPr({
    n: 5,
    a: 'dependabot[bot]',
    bot: 1,
    c: LAST - DAY_MS,
    r: LAST - DAY_MS,
    m: LAST,
    x: LAST,
    rv: [],
  }),
]);

describe('briefStats', () => {
  it('summarises the current window with bot reviews dropped', () => {
    const A = briefStats(
      prs.filter((p) => !p.bot),
      bots,
      between(LAST, 30, 0),
    );
    expect(A.opened.map((p) => p.n)).toEqual([1, 2]);
    expect(A.merged.map((p) => p.n)).toEqual([1]);
    expect(A.closed).toEqual([]);
    expect(A.readied.map((p) => p.n)).toEqual([1, 2]);
    expect(A.reviews.map((r) => r.who)).toEqual(['bob']);
    expect(A.authors).toBe(2);
    expect(A.medSize).toBe(605);
    expect(A.xl).toBe(0.5);
    expect(A.small).toEqual({ first: null, merge: null });
    expect(A.large).toEqual({ first: 2 * HOUR_MS, merge: 2 * DAY_MS });
    expect(A.medFirst).toBe(2 * HOUR_MS);
    expect(A.within1d).toBe(0.5);
    expect(A.medMerge).toBe(2 * DAY_MS);
    expect(A.overWeek).toBe(0);
    expect(A.reviewers).toEqual(new Map([['bob', 1]]));
    expect(A.authored).toEqual(
      new Map([
        ['alice', 1],
        ['bob', 1],
      ]),
    );
    expect(A.changesReq).toBe(0);
    expect(A.commentOnly).toBe(0);
    expect(A.approvedMerges).toBe(1);
    expect(A.areas).toEqual(new Map([['api', 1]]));
  });

  it('summarises the previous window separately', () => {
    const B = briefStats(
      prs.filter((p) => !p.bot),
      bots,
      between(LAST, 60, 30),
    );
    expect(B.opened.map((p) => p.n)).toEqual([3, 4]);
    expect(B.merged.map((p) => p.n)).toEqual([3]);
    expect(B.closed.map((p) => p.n)).toEqual([4]);
    expect(B.overWeek).toBe(1);
    expect(B.changesReq).toBe(1);
    expect(B.approvedMerges).toBe(0);
  });
});

describe('brief', () => {
  const b = brief(prs, bots, LAST);

  it('compares the two windows', () => {
    expect(b.last).toBe(LAST);
    expect(b.cur.merged).toHaveLength(1);
    expect(b.prev.merged).toHaveLength(1);
    expect(change(b.cur.merged.length, b.prev.merged.length)).toBe(0);
  });

  it('ranks review load without flagging small volumes', () => {
    expect(b.reviewLoad.top).toEqual([['bob', 1]]);
    expect(b.reviewLoad.top3Share).toBe(1);
    expect(b.reviewLoad.imbalance).toEqual([]);
    expect(b.reviewLoad.drop).toBeNull();
  });

  it('only reports automation for bots with 5+ PRs and areas when two moved', () => {
    expect(b.automation).toBeNull();
    expect(b.areas).toBeNull();
  });

  it('finds ready PRs waiting for a human review', () => {
    expect(b.backlog).toMatchObject({ open: 1, drafts: 0, oldDrafts: 0, owner: null });
    expect(b.backlog.waiting.map((p) => p.n)).toEqual([2]);
    expect(b.backlog.approved).toEqual([]);
  });

  it('reads churn from the current window only', () => {
    expect(b.churn).toMatchObject({
      closed: 0,
      quick: 0,
      closer: null,
      reverts: 0,
      revertsBefore: 0,
      newcomers: ['bob'],
    });
    expect(b.churn.busiest).toEqual({ day: new Date(LAST - 8 * DAY_MS).getDay(), merges: 1 });
  });

  it('flags large merges approved with no threads only when there are 3+, and at least half', () => {
    // #1 (1,200 lines, one thread-free approval) is already quiet; the bot comment does not count.
    expect(b.depth).toBeNull();
    const large = (n: number, quiet: boolean, daysAgo = 5) =>
      payloadPr({
        n,
        a: 'carol',
        c: LAST - (daysAgo + 1) * DAY_MS,
        r: LAST - (daysAgo + 1) * DAY_MS,
        m: LAST - daysAgo * DAY_MS,
        x: LAST - daysAgo * DAY_MS,
        ad: 1000 + n,
        de: 0,
        th: quiet ? 0 : 4,
        rv: [['bob', 'APPROVED', LAST - daysAgo * DAY_MS - HOUR_MS]],
      });
    const two = derive([large(10, true), large(11, false), large(12, false)]);
    // 3 quiet of 5 large: flagged, largest first, with the previous window's count.
    const d = brief(
      [...prs, ...two, ...derive([large(13, true), large(14, true, 40)])],
      bots,
      LAST,
    ).depth;
    expect(d).toMatchObject({ large: 5, largeBefore: 1, quietBefore: 1 });
    expect(d?.quiet.map((p) => p.n)).toEqual([1, 13, 10]);
    // 3 quiet of 7 large is under half.
    const under = derive([large(13, true), large(15, false), large(16, false)]);
    expect(brief([...prs, ...two, ...under], bots, LAST).depth).toBeNull();
    // 2 quiet of 2 is too few to flag a month.
    expect(brief([...prs, ...derive([large(10, true)])], bots, LAST).depth).toBeNull();
  });

  it('reports the busiest bot once it opens 5 PRs', () => {
    // Together with #5 from the fixture: 6 opened, 5 merged, one still open.
    const busy = derive(
      Array.from({ length: 5 }, (_, i) =>
        payloadPr({
          n: 100 + i,
          a: 'dependabot[bot]',
          bot: 1,
          c: LAST - (i + 1) * DAY_MS,
          r: LAST - (i + 1) * DAY_MS,
          m: i < 4 ? LAST - i * DAY_MS : null,
          x: i < 4 ? LAST - i * DAY_MS : null,
          s: i < 4 ? 'MERGED' : 'OPEN',
          mb: i < 4 ? 'alice' : null,
          ad: 4,
          de: 0,
          rv: [],
        }),
      ),
    );
    const a = brief([...prs, ...busy], bots, LAST).automation;
    expect(a).toMatchObject({
      who: 'dependabot[bot]',
      opened: 6,
      before: 0,
      merged: 5,
      mergedShare: 5 / 6,
      medLead: DAY_MS,
      oneIn: 1,
      topMerger: { who: 'alice', merged: 4 },
    });
    expect(a?.medSize).toBe(4);
  });
});
