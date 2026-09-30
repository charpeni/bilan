import { GithubClient } from '../github/client.ts';
import { rawPr } from './fixtures.ts';

export interface TimelineGithubOptions {
  events: number;
  /** Points GitHub reports left after the given 1-based call. */
  remaining?: (call: number) => number;
  /** A response that replaces the given 1-based call's answer. */
  fail?: (call: number) => Response | undefined;
}

/**
 * A fake GitHub serving one PR whose review-request timeline has `events`
 * entries, paged by the size the query asks for. Every answered call costs 1.
 */
export function timelineGithub({
  events: count,
  remaining = (call) => 5000 - call,
  fail = () => undefined,
}: TimelineGithubOptions) {
  const events = Array.from({ length: count }, (_, i) => ({
    __typename: 'ReviewRequestedEvent',
    createdAt: new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString(),
    requestedReviewer: i === 0 ? {} : { login: `reviewer${i}` },
  }));
  const cursors: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const call = cursors.push(variables.number === undefined ? null : variables.cursor);
    const failure = fail(call);
    if (failure) return failure;
    const first = Number(query.match(/\n\s+timelineItems\(first:(\d+)/)?.[1]);
    const start = Number(variables.cursor ?? 0);
    const end = Math.min(start + first, events.length);
    const timelineItems = {
      nodes: events.slice(start, end),
      pageInfo: { hasNextPage: end < events.length, endCursor: String(end) },
    };
    const rateLimit = { cost: 1, remaining: remaining(call), resetAt: '2026-10-01T00:00:00Z' };
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
  };
  return { client: new GithubClient({ token: 'test', retries: 0, fetch }), cursors, fetch };
}
