/**
 * The synthetic repository the dashboard tests render: fourteen PRs over a
 * hundred days, with drafts, reviews, a bot, a revert, and open work.
 */
import type { Payload, PayloadPr, PayloadReview, PayloadReviewRequest } from '@bilan/core';

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
/** Monday 2026-01-05, so the synthetic data lines up with week buckets. */
const T0 = Date.UTC(2026, 0, 5, 9);

interface PrSpec {
  n: number;
  title: string;
  author: string | null;
  bot?: boolean;
  /** Days after T0 the PR was opened. */
  day: number;
  draft?: boolean;
  /** Hours from open to ready (draft PRs only). */
  readyAfter?: number;
  /** Hours from ready to merge; undefined = not merged. */
  mergeAfter?: number;
  /** Hours from open to close without merging. */
  closeAfter?: number;
  mergedBy?: string | null;
  add?: number;
  del?: number;
  areas?: string[];
  /** [reviewer, state, hours after ready] */
  reviews?: [string, PayloadReview[1], number][];
  /** [reviewer, hours after ready] */
  requests?: [string, number][];
  currentlyDraft?: boolean;
}

function pr(spec: PrSpec): PayloadPr {
  const c = T0 + spec.day * DAY;
  const r = spec.draft ? (spec.readyAfter === undefined ? null : c + spec.readyAfter * HOUR) : c;
  const m = spec.mergeAfter === undefined || r === null ? null : r + spec.mergeAfter * HOUR;
  const x = m ?? (spec.closeAfter === undefined ? null : c + spec.closeAfter * HOUR);
  const base = r ?? c;
  const rv: PayloadReview[] = (spec.reviews ?? []).map(([who, st, h]) => [
    who,
    st,
    base + h * HOUR,
  ]);
  const rq: PayloadReviewRequest[] = (spec.requests ?? []).map(([who, h]) => [
    who,
    base + h * HOUR,
  ]);
  return {
    n: spec.n,
    t: spec.title,
    a: spec.author,
    bot: spec.bot ? 1 : 0,
    c,
    r,
    d: spec.draft ? 1 : 0,
    m,
    x,
    s: m !== null ? 'MERGED' : x !== null ? 'CLOSED' : 'OPEN',
    dr: spec.currentlyDraft ? 1 : 0,
    mb: m === null ? null : (spec.mergedBy ?? spec.author),
    ad: spec.add ?? 40,
    de: spec.del ?? 10,
    cf: 3,
    ar: spec.areas ?? ['api'],
    cm: 1,
    th: 1,
    rc: rv.length,
    rv,
    rq,
  };
}

/** Last activity in the fixture: PR #14 merged 2 hours after opening on day 98. */
export const LAST = T0 + 98 * DAY + 2 * HOUR;

export function fixturePayload(
  coverageSince: string | null = null,
  openPrsSyncedAt: string | null = null,
): Payload {
  const prs = [
    pr({
      n: 1,
      title: 'Add login endpoint',
      author: 'alice',
      day: 0,
      mergeAfter: 20,
      mergedBy: 'bob',
      reviews: [['bob', 'APPROVED', 6]],
      requests: [['bob', 1]],
    }),
    pr({
      n: 2,
      title: 'Fix header layout',
      author: 'bob',
      day: 3,
      mergeAfter: 5,
      areas: ['web'],
      reviews: [['alice', 'APPROVED', 2]],
    }),
    pr({
      n: 3,
      title: 'Refactor billing',
      author: 'alice',
      day: 10,
      draft: true,
      readyAfter: 30,
      mergeAfter: 48,
      mergedBy: 'carol',
      add: 600,
      del: 200,
      reviews: [
        ['carol', 'CHANGES_REQUESTED', 4],
        ['carol', 'APPROVED', 30],
      ],
    }),
    pr({
      n: 4,
      title: 'Bump deps',
      author: 'dependabot[bot]',
      bot: true,
      day: 12,
      mergeAfter: 1,
      mergedBy: 'bob',
      add: 3,
      del: 3,
    }),
    pr({
      n: 5,
      title: 'Revert "Fix header layout"',
      author: 'carol',
      day: 20,
      mergeAfter: 2,
      areas: ['web'],
      reviews: [['bob', 'APPROVED', 1]],
    }),
    pr({
      n: 6,
      title: 'Docs: getting started',
      author: 'carol',
      day: 25,
      closeAfter: 10,
      areas: ['docs'],
    }),
    pr({
      n: 7,
      title: 'Search indexing',
      author: 'alice',
      day: 40,
      mergeAfter: 100,
      add: 1500,
      del: 300,
      areas: ['api', 'web'],
      reviews: [
        ['bob', 'COMMENTED', 10],
        ['carol', 'APPROVED', 80],
      ],
    }),
    pr({
      n: 8,
      title: 'Rate limiting',
      author: 'bob',
      day: 55,
      mergeAfter: 30,
      reviews: [['alice', 'APPROVED', 12]],
      requests: [['alice', 0]],
    }),
    pr({
      n: 9,
      title: 'Old forgotten draft',
      author: 'carol',
      day: 60,
      draft: true,
      currentlyDraft: true,
    }),
    pr({ n: 10, title: 'Waiting for review', author: 'alice', day: 88, areas: ['docs'] }),
    pr({
      n: 11,
      title: 'Approved but stalled',
      author: 'bob',
      day: 90,
      reviews: [['carol', 'APPROVED', 3]],
    }),
    pr({
      n: 12,
      title: 'Telemetry hooks',
      author: 'carol',
      day: 95,
      mergeAfter: 8,
      areas: ['api'],
      reviews: [['alice', 'APPROVED', 4]],
    }),
    pr({
      n: 13,
      title: 'Weekend hotfix',
      author: 'alice',
      day: 96,
      mergeAfter: 0.5,
      areas: ['web'],
    }),
    pr({
      n: 14,
      title: 'Bump deps again',
      author: 'dependabot[bot]',
      bot: true,
      day: 98,
      mergeAfter: 2,
      mergedBy: 'alice',
      add: 2,
      del: 2,
    }),
  ];
  const last = Math.max(...prs.map((p) => Math.max(p.c, p.m ?? 0, p.x ?? 0)));
  if (last !== LAST) throw new Error('fixture drifted: update LAST');
  return {
    repo: 'acme/widgets',
    syncedAt: new Date(last + HOUR).toISOString(),
    coverageSince,
    openPrsSyncedAt,
    areas: ['api', 'web', 'docs'],
    bots: ['dependabot[bot]'],
    prs,
  };
}
