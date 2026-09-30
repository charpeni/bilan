import { GithubClient } from '../github/client.ts';

import type { PullRequestNode } from '../github/query.ts';
import type { PrState } from '../types.ts';

export interface FakePr {
  number: number;
  updatedAt: string;
  state: PrState;
}

export interface FakeCall {
  cursor: string | null;
  states: PrState[] | null;
  page: number;
}

/** A pull request node with only what a test sets; everything else empty. */
export function prNode(number: number, updatedAt: string, state: PrState = 'MERGED') {
  return {
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt,
    closedAt: state === 'OPEN' ? null : updatedAt,
    mergedAt: state === 'MERGED' ? updatedAt : null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    baseRefName: 'main',
    author: { login: 'alice', __typename: 'User' },
    mergedBy: null,
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    reviewThreads: { totalCount: 0 },
    files: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    readyEvents: { nodes: [] },
    draftEvents: { nodes: [] },
    timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  } satisfies PullRequestNode;
}

const order = (a: FakePr, b: FakePr) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number;

/**
 * A repository's pull requests behind a GraphQL endpoint that behaves like
 * GitHub's where sync depends on it: newest `updatedAt` first, and a cursor
 * that encodes the last PR's sort key, so a page after it holds the PRs that
 * sort after that key now, however the ones above it moved since.
 *
 * Each answered request costs `cost` points out of `remaining`; once that
 * would go negative GitHub answers `RATE_LIMITED` until `newWindow`. `fail`
 * replaces the answer to a 1-based request.
 */
export class FakeGithub {
  readonly prs = new Map<number, FakePr>();
  readonly calls: FakeCall[] = [];
  remaining: number;
  cost = 1;
  resetAt = '2999-01-01T00:00:00.000Z';
  fail: (call: number) => Response | undefined = () => undefined;

  constructor(prs: FakePr[] = [], remaining = 5000) {
    for (const pr of prs) this.prs.set(pr.number, pr);
    this.remaining = remaining;
  }

  /** `count` merged PRs numbered from 1, the highest updated most recently, an hour apart before `newest`. */
  static history(count: number, newest = '2026-06-01T00:00:00Z', remaining?: number): FakeGithub {
    return new FakeGithub(
      Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        updatedAt: new Date(Date.parse(newest) - (count - 1 - i) * 3_600_000).toISOString(),
        state: 'MERGED' as const,
      })),
      remaining,
    );
  }

  /** Create or touch a PR, as GitHub does on any change. */
  set(number: number, updatedAt: string, state: PrState = 'MERGED'): void {
    this.prs.set(number, { number, updatedAt, state });
  }

  newWindow(points: number): void {
    this.remaining = points;
  }

  readonly fetch: typeof globalThis.fetch = async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body)) as {
      variables: { cursor: string | null; page: number; states: PrState[] | null };
    };
    this.calls.push({ cursor: variables.cursor, states: variables.states, page: variables.page });
    const failure = this.fail(this.calls.length);
    if (failure) return failure;
    if (this.remaining - this.cost < 0) {
      return Response.json({
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
        data: { rateLimit: { cost: 0, remaining: this.remaining, resetAt: this.resetAt } },
      });
    }
    this.remaining -= this.cost;
    const sorted = [...this.prs.values()]
      .filter((pr) => variables.states === null || variables.states.includes(pr.state))
      .toSorted(order);
    const after =
      variables.cursor === null
        ? null
        : (JSON.parse(atob(variables.cursor)) as { updatedAt: string; number: number });
    const rest =
      after === null ? sorted : sorted.filter((pr) => order(pr, { ...after, state: 'MERGED' }) > 0);
    const nodes = rest.slice(0, variables.page);
    const last = nodes.at(-1);
    const hasNextPage = rest.length > nodes.length;
    return Response.json({
      data: {
        repository: {
          pullRequests: {
            pageInfo: {
              hasNextPage,
              endCursor:
                last === undefined
                  ? null
                  : btoa(JSON.stringify({ updatedAt: last.updatedAt, number: last.number })),
            },
            nodes: nodes.map((pr) => prNode(pr.number, pr.updatedAt, pr.state)),
          },
        },
        rateLimit: { cost: this.cost, remaining: this.remaining, resetAt: this.resetAt },
      },
    });
  };

  client(): GithubClient {
    return new GithubClient({ token: 'test', fetch: this.fetch, retries: 0 });
  }
}
