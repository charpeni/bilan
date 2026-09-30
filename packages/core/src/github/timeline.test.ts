import { describe, expect, it } from 'vitest';

import { readyInfo } from '../derive/ready.ts';
import { rawPr } from '../testing/fixtures.ts';
import { GithubClient } from './client.ts';
import { compact } from './compact.ts';

describe('pull request timelines', () => {
  it('keeps draft readiness independent of requests and follows every request page', async () => {
    const events = Array.from({ length: 125 }, (_, i) => ({
      __typename: 'ReviewRequestedEvent',
      createdAt: new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString(),
      requestedReviewer: { login: `reviewer${i}` },
    }));
    let calls = 0;
    const client = new GithubClient({
      token: 'test',
      fetch: async (_url, init) => {
        calls++;
        const { query, variables } = JSON.parse(String(init?.body));
        const first = Number(query.match(/\n\s+timelineItems\(first:(\d+)/)?.[1]);
        const start = Number(variables.cursor ?? 0);
        const end = Math.min(start + first, events.length);
        const timelineItems = {
          nodes: events.slice(start, end),
          pageInfo: { hasNextPage: end < events.length, endCursor: String(end) },
        };
        const rateLimit = { cost: 1, remaining: 5000 - calls, resetAt: '2026-10-01T00:00:00Z' };
        if (variables.number !== undefined)
          return new Response(
            JSON.stringify({ data: { repository: { pullRequest: { timelineItems } }, rateLimit } }),
          );
        const pr = {
          ...rawPr(),
          author: null,
          mergedBy: null,
          labels: { nodes: [] },
          comments: { totalCount: 0 },
          reviewThreads: { totalCount: 0 },
          files: { totalCount: 0, nodes: [] },
          reviews: { totalCount: 0, nodes: [] },
          timelineItems,
          ...(query.includes('readyEvents:')
            ? { readyEvents: { nodes: [{ createdAt: '2026-01-02T10:00:00Z' }] } }
            : {}),
          ...(query.includes('draftEvents:') ? { draftEvents: { nodes: [] } } : {}),
        };
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: { nodes: [pr], pageInfo: { hasNextPage: false, endCursor: null } },
              },
              rateLimit,
            },
          }),
        );
      },
    });
    const result = await client.pullRequestsPage({ owner: 'acme', name: 'widgets' }, 25, null);
    const pr = compact(result.page.nodes[0]!);
    expect(pr.reviewRequests).toHaveLength(125);
    expect(pr.reviewRequests.at(-1)?.to).toBe('reviewer124');
    expect(readyInfo(pr)).toEqual({
      openedAsDraft: true,
      readyAt: Date.parse('2026-01-02T10:00:00Z'),
    });
    expect(result.rateLimit).toMatchObject({ cost: 2, remaining: 4998 });
    expect(calls).toBe(2);
  });
});
