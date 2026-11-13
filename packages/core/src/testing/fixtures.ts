import type { PayloadPr, RawPr } from '../types.ts';

/** A merged, human-authored PR opened ready for review; override what a test cares about. */
export function rawPr(overrides: Partial<RawPr> = {}): RawPr {
  return {
    number: 1,
    title: 'Add thing',
    state: 'MERGED',
    isDraft: false,
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-02T10:00:00Z',
    closedAt: '2026-01-02T10:00:00Z',
    mergedAt: '2026-01-02T10:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    baseRefName: 'main',
    author: 'alice',
    authorType: 'User',
    mergedBy: 'bob',
    labels: [],
    comments: 0,
    reviewThreads: 0,
    fileSample: ['src/index.ts'],
    fileCount: 1,
    reviewCount: 1,
    reviews: [{ author: 'bob', authorType: 'User', state: 'APPROVED', at: '2026-01-01T12:00:00Z' }],
    readyAt: [],
    draftedAt: [],
    reviewRequests: [{ at: '2026-01-01T10:05:00Z', to: 'bob' }],
    ...overrides,
  };
}

/** Monday 2026-01-05 09:00 UTC: a fixed origin for payload timestamps. */
export const T0 = Date.UTC(2026, 0, 5, 9);
export const HOUR_MS = 3600e3;
export const DAY_MS = 24 * HOUR_MS;

/**
 * A merged, human-authored payload PR opened ready at `T0`, approved by bob 2h
 * later and merged after 1 day; override what a test cares about.
 */
export function payloadPr(overrides: Partial<PayloadPr> = {}): PayloadPr {
  return {
    n: 1,
    t: 'Add thing',
    a: 'alice',
    bot: 0,
    c: T0,
    r: T0,
    d: 0,
    m: T0 + DAY_MS,
    x: T0 + DAY_MS,
    s: 'MERGED',
    dr: 0,
    mb: 'bob',
    ad: 10,
    de: 2,
    cf: 1,
    ar: ['src'],
    cm: 0,
    th: 0,
    rc: 1,
    rv: [['bob', 'APPROVED', T0 + 2 * HOUR_MS]],
    rq: [['bob', T0 + 5 * 60e3]],
    ...overrides,
  };
}

export const COPILOT = 'copilot-pull-request-reviewer';

/**
 * Three PRs ready at `T0`, each reviewed by a bot a minute later, in the order
 * `buildPayload` keeps (`rv` sorted by time): #1 is still open with only the
 * bot's comment, #2 also gets bob's approval after 3 days and merges, and #3
 * merges on the bot's approval alone.
 */
export function botFirstPrs(): PayloadPr[] {
  const at = T0 + 60e3;
  return [
    payloadPr({ n: 1, m: null, x: null, s: 'OPEN', mb: null, rv: [[COPILOT, 'COMMENTED', at]] }),
    payloadPr({
      n: 2,
      m: T0 + 4 * DAY_MS,
      x: T0 + 4 * DAY_MS,
      rv: [
        [COPILOT, 'COMMENTED', at],
        ['bob', 'APPROVED', T0 + 3 * DAY_MS],
      ],
    }),
    payloadPr({ n: 3, rv: [[COPILOT, 'APPROVED', at]] }),
  ];
}
