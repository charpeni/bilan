import { describe, expect, it } from 'vitest';

import { prNode } from '../testing/github.ts';
import { compact } from './compact.ts';

import type { PullRequestNode } from './query.ts';

type Reviews = PullRequestNode['reviews']['nodes'];

const bob: Reviews[number] = {
  author: { login: 'bob', __typename: 'User' },
  state: 'APPROVED',
  submittedAt: '2026-01-02T00:00:00Z',
};
const carol: Reviews[number] = {
  author: { login: 'carol', __typename: 'User' },
  state: 'CHANGES_REQUESTED',
  submittedAt: '2026-01-03T00:00:00Z',
};

const node = (latestOpinionatedReviews?: PullRequestNode['latestOpinionatedReviews']) => ({
  ...prNode(1, '2026-01-04T00:00:00Z', 'OPEN'),
  ...(latestOpinionatedReviews ? { latestOpinionatedReviews } : {}),
});

describe('compact', () => {
  it("keeps each reviewer's latest verdict as GitHub reports it", () => {
    expect(compact(node({ totalCount: 2, nodes: [carol, bob] })).verdicts).toEqual([
      { author: 'carol', authorType: 'User', state: 'CHANGES_REQUESTED', at: carol.submittedAt },
      { author: 'bob', authorType: 'User', state: 'APPROVED', at: bob.submittedAt },
    ]);
    expect(compact(node({ totalCount: 0, nodes: [] })).verdicts).toEqual([]);
  });

  it('leaves the verdicts out when GitHub returned only part of them, or none', () => {
    // More reviewers than the page asked for: where the rest stand is unknown.
    expect('verdicts' in compact(node({ totalCount: 3, nodes: [carol, bob] }))).toBe(false);
    // A page fetched before the query asked for them.
    expect('verdicts' in compact(node())).toBe(false);
  });
});
