import { describe, expect, it } from 'vitest';

import { GithubClient } from '../github/client.ts';
import { DAY } from '../metrics/time.ts';
import { catchUpSince, defaultSince, effectiveSince, sync } from './engine.ts';

import type { PullRequestNode } from '../github/query.ts';
import type { PrState, RawPr, RepoMeta } from '../types.ts';
import type { SyncStore } from './store.ts';

/**
 * Follows the same rules as the real stores: keeps the earliest bound it is
 * given (the first stamp is taken as is), keeps the earliest start across
 * consecutive unfinished runs, and only a complete run promotes that start to
 * `reconciledAt`, clears it, and may stamp `openPrsSyncedAt`.
 */
class MemoryStore implements SyncStore {
  prs = new Map<number, RawPr>();
  syncedAt: string | null = null;
  coverageSince: string | null = null;
  openPrsSyncedAt: string | null = null;
  startedAt: string | null = null;
  reconciledAt: string | null = null;
  meta(): Promise<RepoMeta> {
    return Promise.resolve({
      repo: 'acme/widgets',
      syncedAt: this.syncedAt,
      coverageSince: this.coverageSince,
      openPrsSyncedAt: this.openPrsSyncedAt,
      interrupted: this.startedAt !== null,
      syncStartedAt: this.startedAt,
      reconciledAt: this.reconciledAt,
    });
  }
  updatedAtByNumber(numbers: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const n of numbers) {
      const pr = this.prs.get(n);
      if (pr) out.set(n, pr.updatedAt);
    }
    return Promise.resolve(out);
  }
  upsert(prs: RawPr[]): Promise<void> {
    for (const pr of prs) this.prs.set(pr.number, pr);
    return Promise.resolve();
  }
  all(): Promise<RawPr[]> {
    return Promise.resolve([...this.prs.values()]);
  }
  markStarted(at: string): Promise<void> {
    this.startedAt ??= at;
    return Promise.resolve();
  }
  markSynced(
    at: string,
    coverageSince: string | null,
    openPrsComplete: boolean,
    complete: boolean,
  ): Promise<void> {
    if (this.syncedAt === null || coverageSince === null || this.coverageSince === null) {
      this.coverageSince = this.syncedAt === null ? coverageSince : null;
    } else if (Date.parse(coverageSince) < Date.parse(this.coverageSince)) {
      this.coverageSince = coverageSince;
    }
    this.syncedAt = at;
    if (complete) {
      this.reconciledAt = this.startedAt ?? this.reconciledAt;
      this.startedAt = null;
      if (openPrsComplete) this.openPrsSyncedAt = at;
    }
    return Promise.resolve();
  }
}

function node(number: number, updatedAt: string, state: PrState = 'MERGED'): PullRequestNode {
  return {
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    closedAt: null,
    mergedAt: null,
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
    timelineItems: { nodes: [] },
  };
}

interface FakeCall {
  cursor: string | null;
  states: PrState[] | null;
}

/**
 * A fake GitHub that serves `pages` in order and reports a fixed cost per page.
 * With `states` it serves the matching nodes re-paged by the requested size.
 * `dieAfter` makes every request past that many fail at the transport level,
 * the way a dropped connection would.
 */
function fakeGithub(pages: PullRequestNode[][], remaining = 5000, dieAfter = Infinity) {
  const calls: FakeCall[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body)) as {
      variables: { cursor: string | null; page: number; states: PrState[] | null };
    };
    if (calls.length >= dieAfter) throw new TypeError('fetch failed');
    calls.push({ cursor: variables.cursor, states: variables.states });
    const served =
      variables.states === null
        ? pages
        : chunk(
            pages.flat().filter((n) => variables.states?.includes(n.state)),
            variables.page,
          );
    const index = variables.cursor === null ? 0 : Number(variables.cursor);
    const nodes = served[index] ?? [];
    const hasNextPage = index < served.length - 1;
    remaining -= 20;
    return new Response(
      JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null },
              nodes,
            },
          },
          rateLimit: { cost: 20, remaining, resetAt: '2026-01-01T01:00:00Z' },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { client: new GithubClient({ token: 't', fetch: fetchImpl, retries: 0 }), calls };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const cursors = (calls: FakeCall[]) => calls.map((c) => c.cursor);

const repo = { owner: 'acme', name: 'widgets' };
const threePages = () => [
  [node(3, '2026-01-03T00:00:00Z')],
  [node(2, '2026-01-02T00:00:00Z')],
  [node(1, '2026-01-01T00:00:00Z')],
];

/** Merged and open PRs interleaved, so an open pass has stale open PRs to find. */
const mixedPages = () => [
  [node(10, '2026-01-10T00:00:00Z', 'OPEN'), node(9, '2026-01-09T00:00:00Z')],
  [node(8, '2026-01-08T00:00:00Z', 'OPEN'), node(7, '2026-01-07T00:00:00Z')],
  [node(6, '2026-01-06T00:00:00Z', 'OPEN'), node(5, '2026-01-05T00:00:00Z', 'OPEN')],
  [node(4, '2026-01-04T00:00:00Z', 'OPEN'), node(3, '2026-01-03T00:00:00Z', 'OPEN')],
  [node(2, '2026-01-02T00:00:00Z', 'OPEN'), node(1, '2026-01-01T00:00:00Z', 'OPEN')],
];

/** Five open PRs, one per page. */
const openPages = () => [5, 4, 3, 2, 1].map((n) => [node(n, `2026-01-0${n}T00:00:00Z`, 'OPEN')]);
/** The same five, all closed upstream since; still one per page, newest first. */
const closedPages = () =>
  [5, 4, 3, 2, 1].map((n) => [node(n, `2026-02-0${n}T00:00:00Z`, 'CLOSED')]);

const cachedStates = (store: MemoryStore) =>
  [...store.prs.values()].toSorted((a, b) => a.number - b.number).map((pr) => pr.state);

/** A `now` whose every call is one minute later than the previous one, from 2026-03-01. */
function minuteClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 2, 1, 0, tick++));
}

describe('defaultSince', () => {
  it('is 30 days before now', () => {
    expect(defaultSince(new Date('2026-09-23T10:00:00Z')).toISOString()).toBe(
      '2026-08-24T10:00:00.000Z',
    );
    expect(Date.now() - defaultSince().getTime()).toBeGreaterThanOrEqual(30 * 86_400_000);
  });
});

describe('sync', () => {
  it('keeps fetched pages and reports a distant API rate limit as a partial run', async () => {
    let calls = 0;
    const store = new MemoryStore();
    const client = new GithubClient({
      token: 'test',
      fetch: async () => {
        if (++calls > 1)
          return new Response('rate limit', { status: 429, headers: { 'retry-after': '3600' } });
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  nodes: [node(1, '2026-01-01T00:00:00Z')],
                  pageInfo: { hasNextPage: true, endCursor: 'next' },
                },
              },
              rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-09-30T00:00:00Z' },
            },
          }),
        );
      },
    });
    const result = await sync({ client, store, repo });
    expect(result).toMatchObject({
      fetched: 1,
      stoppedBecause: 'rate-limit',
      complete: false,
      rateLimit: { remaining: 0 },
    });
    expect(store.prs.size).toBe(1);
    expect((await store.meta()).interrupted).toBe(true);
    expect(calls).toBe(2);
  });

  it.each([1, 30])('requests at most %i PRs across real-sized pages', async (maxPrs) => {
    const requests: number[] = [];
    const rows = Array.from({ length: 60 }, (_, i) => node(i + 1, '2026-01-01T00:00:00Z', 'OPEN'));
    const client = new GithubClient({
      token: 'test',
      fetch: async (_url, init) => {
        const { variables } = JSON.parse(String(init?.body));
        const start = Number(variables.cursor ?? 0);
        requests.push(variables.page);
        const end = Math.min(start + variables.page, rows.length);
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  nodes: rows.slice(start, end),
                  pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) },
                },
              },
              rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-01-01T01:00:00Z' },
            },
          }),
        );
      },
    });
    const result = await sync({ client, repo, store: new MemoryStore(), maxPrs, mode: 'full' });
    expect(result.fetched).toBe(maxPrs);
    expect(requests).toEqual(maxPrs === 1 ? [1] : [25, 5]);
    requests.length = 0;
    const bounded = await sync({
      client,
      repo,
      store: new MemoryStore(),
      maxPrs,
      since: new Date('2026-02-01'),
    });
    expect(bounded.fetched).toBe(maxPrs);
    expect(requests).toEqual(maxPrs === 1 ? [1] : [25, 5]);
  });

  it.each([0, -1, 0.5, Infinity, NaN])(
    'rejects invalid PR budget %s before touching the store',
    async (maxPrs) => {
      const { client, calls } = fakeGithub(threePages());
      const store = new MemoryStore();
      await expect(sync({ client, repo, store, maxPrs })).rejects.toThrow(/positive integer/);
      expect(calls).toEqual([]);
      expect(store.startedAt).toBeNull();
    },
  );

  it('walks every page on a cold store and stamps syncedAt', async () => {
    const { client, calls } = fakeGithub([
      [node(3, '2026-01-03T00:00:00Z'), node(2, '2026-01-02T00:00:00Z')],
      [node(1, '2026-01-01T00:00:00Z')],
    ]);
    const store = new MemoryStore();
    const result = await sync({ client, store, repo, now: () => new Date('2026-02-01T00:00:00Z') });
    expect(result).toMatchObject({
      pages: 2,
      fetched: 3,
      changed: 3,
      pointsSpent: 40,
      stoppedBecause: 'exhausted',
    });
    expect(cursors(calls)).toEqual([null, '1']);
    expect(calls.every((c) => c.states === null)).toBe(true);
    expect(store.prs.size).toBe(3);
    expect(store.syncedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(store.coverageSince).toBeNull();
    expect(result.coverageSince).toBeNull();
    expect(result.openPass).toBeNull();
    expect(result.openPrsComplete).toBe(true);
    expect(result.complete).toBe(true);
    expect(store.openPrsSyncedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(store.reconciledAt).toBe('2026-02-01T00:00:00.000Z');
    expect(store.startedAt).toBeNull();
  });

  it('stops after two unchanged pages in incremental mode', async () => {
    const pages = [
      [node(5, '2026-01-05T00:00:00Z')],
      [node(4, '2026-01-04T00:00:00Z')],
      [node(3, '2026-01-03T00:00:00Z')],
      [node(2, '2026-01-02T00:00:00Z')],
      [node(1, '2026-01-01T00:00:00Z')],
    ];
    const store = new MemoryStore();
    await sync({ client: fakeGithub(pages).client, store, repo });

    pages[0] = [node(5, '2026-01-06T00:00:00Z')];
    const { client, calls } = fakeGithub(pages);
    const result = await sync({ client, store, repo });
    expect(result).toMatchObject({ pages: 3, changed: 1, stoppedBecause: 'already-synced' });
    expect(calls).toHaveLength(3);
  });

  it('keeps going through unchanged pages in full mode', async () => {
    const store = new MemoryStore();
    await sync({ client: fakeGithub(threePages()).client, store, repo });
    const result = await sync({
      client: fakeGithub(threePages()).client,
      store,
      repo,
      mode: 'full',
    });
    expect(result).toMatchObject({ pages: 3, changed: 0, stoppedBecause: 'exhausted' });
  });

  it('stops at --max-prs', async () => {
    const result = await sync({
      client: fakeGithub(threePages()).client,
      store: new MemoryStore(),
      repo,
      maxPrs: 2,
    });
    expect(result).toMatchObject({ fetched: 2, stoppedBecause: 'max-prs' });
  });

  it('stops once a page is older than --since and records that as coverage', async () => {
    const store = new MemoryStore();
    const result = await sync({
      client: fakeGithub(threePages()).client,
      store,
      repo,
      since: new Date('2026-01-02T12:00:00Z'),
    });
    expect(result).toMatchObject({
      stoppedBecause: 'since',
      coverageSince: '2026-01-02T12:00:00.000Z',
      openPass: { pages: 1, fetched: 0, stoppedBecause: 'exhausted' },
      openPrsComplete: true,
    });
    expect(store.coverageSince).toBe('2026-01-02T12:00:00.000Z');
    expect(store.openPrsSyncedAt).toBe(store.syncedAt);
  });

  it('records full coverage when a --since run runs out of pages first', async () => {
    const store = new MemoryStore();
    const result = await sync({
      client: fakeGithub(threePages()).client,
      store,
      repo,
      since: new Date('2025-01-01T00:00:00Z'),
    });
    expect(result).toMatchObject({ stoppedBecause: 'exhausted', coverageSince: null });
    expect(result.openPass).toBeNull();
    expect(store.coverageSince).toBeNull();
  });

  it('only guarantees the oldest page reached when --max-prs cuts a --since run short', async () => {
    const store = new MemoryStore();
    const result = await sync({
      client: fakeGithub(threePages()).client,
      store,
      repo,
      maxPrs: 2,
      since: new Date('2025-01-01T00:00:00Z'),
    });
    // One millisecond past the oldest PR fetched: the next page may share its instant.
    expect(result).toMatchObject({
      stoppedBecause: 'max-prs',
      coverageSince: '2026-01-02T00:00:00.001Z',
      openPass: null,
      openPrsComplete: false,
      complete: false,
    });
    expect(store.coverageSince).toBe('2026-01-02T00:00:00.001Z');
    expect(store.openPrsSyncedAt).toBeNull();
  });

  it('excludes the oldest instant reached when the budget stops with pages left, since the next page may share it', async () => {
    const tie = '2026-01-02T00:00:00Z';
    const store = new MemoryStore();
    const result = await sync({
      client: fakeGithub([[node(3, tie)], [node(2, tie)], [node(1, '2026-01-01T00:00:00Z')]])
        .client,
      store,
      repo,
      maxPrs: 1,
      since: new Date('2025-01-01T00:00:00Z'),
    });
    // #2 shares #3's `updatedAt` but sits on the page that was never fetched,
    // so a bound of `tie` itself would claim a PR the store does not have.
    expect(result).toMatchObject({
      stoppedBecause: 'max-prs',
      fetched: 1,
      coverageSince: '2026-01-02T00:00:00.001Z',
      complete: false,
    });
    expect(store.prs.has(2)).toBe(false);
    expect(store.coverageSince).toBe('2026-01-02T00:00:00.001Z');
  });

  it('only guarantees the oldest page reached when the rate limit cuts a --since run short', async () => {
    const store = new MemoryStore();
    const result = await sync({
      client: fakeGithub(threePages(), 215).client,
      store,
      repo,
      since: new Date('2025-01-01T00:00:00Z'),
    });
    expect(result).toMatchObject({ stoppedBecause: 'rate-limit', openPass: null, complete: false });
    expect(store.coverageSince).toBe('2026-01-03T00:00:00.001Z');
  });

  describe('open pass', () => {
    const pages = mixedPages;
    const since = new Date('2026-01-06T12:00:00Z');

    it('walks every open PR after the --since cutoff, with only OPEN requested', async () => {
      const { client, calls } = fakeGithub(pages());
      const store = new MemoryStore();
      const result = await sync({ client, store, repo, pageSize: 2, since });
      expect(result).toMatchObject({
        pages: 7,
        fetched: 14,
        changed: 10,
        pointsSpent: 140,
        stoppedBecause: 'since',
        openPass: { pages: 4, fetched: 8, changed: 4, stoppedBecause: 'exhausted' },
      });
      expect(calls.map((c) => c.states)).toEqual([
        null,
        null,
        null,
        ['OPEN'],
        ['OPEN'],
        ['OPEN'],
        ['OPEN'],
      ]);
      expect([...store.prs.keys()].toSorted((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      expect(store.coverageSince).toBe('2026-01-06T12:00:00.000Z');
    });

    it('stops the open pass on unchanged pages older than --since once a complete walk exists', async () => {
      const store = new MemoryStore();
      await sync({ client: fakeGithub(pages()).client, store, repo, pageSize: 2, since });
      expect(store.openPrsSyncedAt).not.toBeNull();
      const { client, calls } = fakeGithub(pages());
      const result = await sync({
        client,
        store,
        repo,
        pageSize: 2,
        since,
        now: () => new Date('2026-03-01T00:00:00Z'),
      });
      expect(result).toMatchObject({ stoppedBecause: 'already-synced', changed: 0 });
      // Pages inside the window were just stored by the main pass and prove nothing.
      expect(result.openPass).toMatchObject({
        pages: 3,
        changed: 0,
        stoppedBecause: 'already-synced',
      });
      expect(calls.filter((c) => c.states !== null)).toHaveLength(3);
      // The earlier complete walk was confirmed, so the set is still complete as of now.
      expect(result.openPrsComplete).toBe(true);
      expect(store.openPrsSyncedAt).toBe('2026-03-01T00:00:00.000Z');
    });

    it('walks the open pass to the end when no complete walk exists, even over cached pages', async () => {
      // Same store as after a first run, but without the completeness stamp (a
      // legacy cache, or a run whose open pass was cut short).
      const store = new MemoryStore();
      await sync({ client: fakeGithub(pages()).client, store, repo, pageSize: 2, since });
      store.openPrsSyncedAt = null;
      const { client, calls } = fakeGithub(pages());
      const result = await sync({ client, store, repo, pageSize: 2, since });
      expect(result.openPass).toMatchObject({ pages: 4, changed: 0, stoppedBecause: 'exhausted' });
      expect(calls.filter((c) => c.states !== null)).toHaveLength(4);
      expect(result.openPrsComplete).toBe(true);
      expect(store.openPrsSyncedAt).toBe(store.syncedAt);
    });

    it('leaves the open set marked incomplete when --max-prs cuts the open pass short', async () => {
      const store = new MemoryStore();
      const result = await sync({
        client: fakeGithub(pages()).client,
        store,
        repo,
        pageSize: 2,
        maxPrs: 7,
        since,
      });
      expect(result).toMatchObject({
        openPass: { stoppedBecause: 'max-prs' },
        openPrsComplete: false,
        complete: false,
        // Only one PR remains in the budget: strictly after #10.
        coverageSince: '2026-01-10T00:00:00.001Z',
      });
      expect(store.syncedAt).not.toBeNull();
      expect(store.openPrsSyncedAt).toBeNull();
      expect(store.reconciledAt).toBeNull();
      expect((await store.meta()).interrupted).toBe(true);
    });

    it('walks the open pass to the end in full mode', async () => {
      const store = new MemoryStore();
      await sync({ client: fakeGithub(pages()).client, store, repo, pageSize: 2, since });
      const result = await sync({
        client: fakeGithub(pages()).client,
        store,
        repo,
        mode: 'full',
        pageSize: 2,
        since,
      });
      expect(result.openPass).toMatchObject({ pages: 4, changed: 0, stoppedBecause: 'exhausted' });
    });

    it('counts open-pass PRs against --max-prs and reports progress per pass', async () => {
      const seen: string[] = [];
      const result = await sync({
        client: fakeGithub(pages()).client,
        store: new MemoryStore(),
        repo,
        pageSize: 2,
        maxPrs: 7,
        since,
        onPage: (p) => seen.push(`${p.pass}:${p.pages}:${p.fetched}`),
      });
      expect(result).toMatchObject({ fetched: 7, openPass: { stoppedBecause: 'max-prs' } });
      expect(seen).toEqual(['all:1:2', 'all:2:4', 'all:3:6', 'open:4:7']);
    });
  });

  describe('coverage', () => {
    it('never shrinks: a shallower run keeps the earlier bound', async () => {
      const store = new MemoryStore();
      await sync({
        client: fakeGithub(threePages()).client,
        store,
        repo,
        since: new Date('2026-01-02T12:00:00Z'),
      });
      expect(store.coverageSince).toBe('2026-01-02T12:00:00.000Z');
      const result = await sync({
        client: fakeGithub(threePages()).client,
        store,
        repo,
        since: new Date('2026-01-03T12:00:00Z'),
      });
      expect(result).toMatchObject({
        stoppedBecause: 'since',
        coverageSince: '2026-01-02T12:00:00.000Z',
      });
      expect(store.coverageSince).toBe('2026-01-02T12:00:00.000Z');
    });

    it('keeps walking past already-covered pages when a run wants to go deeper', async () => {
      const pages = [
        [node(5, '2026-01-05T00:00:00Z')],
        [node(4, '2026-01-04T00:00:00Z')],
        [node(3, '2026-01-03T00:00:00Z')],
        [node(2, '2026-01-02T00:00:00Z')],
        [node(1, '2026-01-01T00:00:00Z')],
      ];
      const store = new MemoryStore();
      await sync({
        client: fakeGithub(pages).client,
        store,
        repo,
        since: new Date('2026-01-03T12:00:00Z'),
      });
      expect(store.prs.size).toBe(3);

      // Without the guard, the two unchanged pages inside the old coverage would stop the run here.
      const result = await sync({
        client: fakeGithub(pages).client,
        store,
        repo,
        since: new Date('2026-01-02T12:00:00Z'),
      });
      expect(result).toMatchObject({
        pages: 5,
        fetched: 4,
        stoppedBecause: 'since',
        coverageSince: '2026-01-02T12:00:00.000Z',
        openPass: { pages: 1, fetched: 0 },
      });
      expect(store.prs.size).toBe(4);
    });

    it('fetches closed PRs hiding between cached open ones when deepening', async () => {
      // Open PRs (cached by the earlier open pass) interleaved with closed PRs
      // the store has never seen. Two cached open pages in a row used to look
      // like "already synced" and end the deeper walk before #6, #5, #3, #2.
      const pages = [
        [node(10, '2026-01-10T00:00:00Z')],
        [node(9, '2026-01-09T00:00:00Z')],
        [node(8, '2026-01-08T00:00:00Z', 'OPEN')],
        [node(7, '2026-01-07T00:00:00Z', 'OPEN')],
        [node(6, '2026-01-06T00:00:00Z')],
        [node(5, '2026-01-05T00:00:00Z')],
        [node(4, '2026-01-04T00:00:00Z', 'OPEN')],
        [node(3, '2026-01-03T00:00:00Z')],
        [node(2, '2026-01-02T00:00:00Z')],
        [node(1, '2026-01-01T00:00:00Z')],
      ];
      const store = new MemoryStore();
      await sync({
        client: fakeGithub(pages).client,
        store,
        repo,
        pageSize: 1,
        since: new Date('2026-01-08T12:00:00Z'),
      });
      expect([...store.prs.keys()].toSorted((a, b) => a - b)).toEqual([4, 7, 8, 9, 10]);
      expect(store.openPrsSyncedAt).not.toBeNull();

      const { client, calls } = fakeGithub(pages);
      const result = await sync({
        client,
        store,
        repo,
        pageSize: 1,
        since: new Date('2026-01-02T12:00:00Z'),
      });
      expect(result).toMatchObject({
        stoppedBecause: 'since',
        changed: 4,
        coverageSince: '2026-01-02T12:00:00.000Z',
        openPrsComplete: true,
      });
      expect(calls.filter((c) => c.states === null)).toHaveLength(9);
      expect([...store.prs.keys()].toSorted((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('a --full run after a --since run widens to full history', async () => {
      const store = new MemoryStore();
      await sync({
        client: fakeGithub(threePages()).client,
        store,
        repo,
        since: new Date('2026-01-02T12:00:00Z'),
      });
      const result = await sync({
        client: fakeGithub(threePages()).client,
        store,
        repo,
        mode: 'full',
      });
      expect(result.coverageSince).toBeNull();
      expect(store.coverageSince).toBeNull();
    });

    it('stamps the start before the first page and syncedAt once, at the end of the run', async () => {
      const stamps: string[] = [];
      const store = new MemoryStore();
      store.markStarted = (at) => {
        stamps.push(`started ${at}`);
        store.startedAt = at;
        return Promise.resolve();
      };
      store.markSynced = (at, coverage, openPrsComplete) => {
        stamps.push(`synced ${at}`);
        store.startedAt = null;
        store.syncedAt = at;
        store.coverageSince = coverage;
        if (openPrsComplete) store.openPrsSyncedAt = at;
        return Promise.resolve();
      };
      let tick = 0;
      await sync({
        client: fakeGithub(threePages()).client,
        store,
        repo,
        now: () => new Date(Date.UTC(2026, 1, 1, 0, 0, tick++)),
      });
      expect(stamps).toEqual([
        'started 2026-02-01T00:00:00.000Z',
        'synced 2026-02-01T00:00:01.000Z',
      ]);
      expect(store.startedAt).toBeNull();
    });
  });

  describe('interrupted run', () => {
    const since = new Date('2026-01-15T00:00:00Z');

    async function interruptedStore(): Promise<MemoryStore> {
      const store = new MemoryStore();
      await sync({ client: fakeGithub(openPages()).client, store, repo, since });
      expect(cachedStates(store)).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']);
      expect(store.openPrsSyncedAt).not.toBeNull();
      // A refresh that dies after two pages: #5 and #4 are now CLOSED in the
      // store, #3, #2 and #1 still say OPEN, and no completion stamp was written.
      const dying = fakeGithub(closedPages(), 5000, 2);
      await expect(sync({ client: dying.client, store, repo, since })).rejects.toThrow(
        'fetch failed',
      );
      expect(cachedStates(store)).toEqual(['OPEN', 'OPEN', 'OPEN', 'CLOSED', 'CLOSED']);
      expect(store.startedAt).not.toBeNull();
      expect((await store.meta()).interrupted).toBe(true);
      return store;
    }

    it('leaves the store flagged so the next run knows not to trust unchanged pages', async () => {
      const store = await interruptedStore();
      expect(store.syncedAt).not.toBeNull();
      expect(store.startedAt).not.toBeNull();
    });

    it('does not stop on the pages the dead run already wrote, and fixes the stale rows', async () => {
      const store = await interruptedStore();
      const { client, calls } = fakeGithub(closedPages());
      const result = await sync({ client, store, repo, since });
      // Without the flag: pages #5 and #4 look unchanged, the walk stops as
      // "already-synced", the open pass finds nothing upstream and stamps the
      // open set complete while #3, #2 and #1 are still cached as OPEN.
      expect(result).toMatchObject({ stoppedBecause: 'exhausted', changed: 3 });
      expect(calls.filter((c) => c.states === null)).toHaveLength(5);
      expect(cachedStates(store)).toEqual(['CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'CLOSED']);
      expect(store.startedAt).toBeNull();
      expect((await store.meta()).interrupted).toBe(false);
    });

    it('clears the flag once a run completes, so the run after that stops early again', async () => {
      const store = await interruptedStore();
      await sync({ client: fakeGithub(closedPages()).client, store, repo, since });
      const { client, calls } = fakeGithub(closedPages());
      const result = await sync({ client, store, repo, since });
      expect(result).toMatchObject({ stoppedBecause: 'already-synced', changed: 0 });
      expect(calls.filter((c) => c.states === null)).toHaveLength(2);
    });

    it('walks the open pass to the end as well, ignoring its unchanged pages', async () => {
      const pages = mixedPages();
      const openSince = new Date('2026-01-06T12:00:00Z');
      const store = new MemoryStore();
      await sync({ client: fakeGithub(pages).client, store, repo, pageSize: 2, since: openSince });
      expect(store.openPrsSyncedAt).not.toBeNull();
      // A second run that dies on its very first page.
      await expect(
        sync({
          client: fakeGithub(pages, 5000, 0).client,
          store,
          repo,
          pageSize: 2,
          since: openSince,
        }),
      ).rejects.toThrow('fetch failed');
      expect((await store.meta()).interrupted).toBe(true);

      const { client, calls } = fakeGithub(pages);
      const result = await sync({ client, store, repo, pageSize: 2, since: openSince });
      // A trusted store would stop the open pass after two unchanged pages
      // older than `since` (see "stops the open pass on unchanged pages").
      expect(result.openPass).toMatchObject({ pages: 4, changed: 0, stoppedBecause: 'exhausted' });
      expect(calls.filter((c) => c.states !== null)).toHaveLength(4);
      expect(result.openPrsComplete).toBe(true);
      expect((await store.meta()).interrupted).toBe(false);
    });
  });

  it('stops when the rate limit drops under the reserve', async () => {
    const result = await sync({
      client: fakeGithub(threePages(), 215).client,
      store: new MemoryStore(),
      repo,
    });
    expect(result).toMatchObject({
      pages: 1,
      stoppedBecause: 'rate-limit',
      openPrsComplete: false,
      complete: false,
    });
  });

  describe('budget-cut run', () => {
    const since = new Date('2026-01-15T00:00:00Z');

    it('stays flagged as interrupted so the next run walks past its half-written pages', async () => {
      const store = new MemoryStore();
      const now = minuteClock();
      await sync({ client: fakeGithub(openPages()).client, store, repo, since, now });
      expect(cachedStates(store)).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']);
      expect(store.reconciledAt).toBe('2026-03-01T00:00:00.000Z');

      // Every PR closed upstream; a run capped at two pages rewrites #5 and #4 only.
      const cut = await sync({
        client: fakeGithub(closedPages()).client,
        store,
        repo,
        since,
        maxPrs: 2,
        now,
      });
      expect(cut).toMatchObject({
        stoppedBecause: 'max-prs',
        fetched: 2,
        complete: false,
        openPass: null,
      });
      expect(cachedStates(store)).toEqual(['OPEN', 'OPEN', 'OPEN', 'CLOSED', 'CLOSED']);
      expect(store.syncedAt).toBe('2026-03-01T00:03:00.000Z');
      expect(store.reconciledAt).toBe('2026-03-01T00:00:00.000Z');
      expect(store.startedAt).toBe('2026-03-01T00:02:00.000Z');
      expect((await store.meta()).interrupted).toBe(true);

      // Had the cut run published itself as complete, #5 and #4 would look
      // unchanged here, the walk would stop as "already-synced", and an empty
      // open pass would stamp the run complete with #3, #2 and #1 still OPEN.
      const { client, calls } = fakeGithub(closedPages());
      const result = await sync({ client, store, repo, since, now });
      expect(result).toMatchObject({ stoppedBecause: 'exhausted', changed: 3, complete: true });
      expect(calls.filter((c) => c.states === null)).toHaveLength(5);
      expect(cachedStates(store)).toEqual(['CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'CLOSED']);
      // The watermark is the cut run's start, the earliest instant nothing has
      // been reconciled from: a PR updated while the cut run walked would sort
      // below this run's start and be skipped by the next catch-up otherwise.
      expect(store.reconciledAt).toBe('2026-03-01T00:02:00.000Z');
      expect(store.startedAt).toBeNull();
      expect((await store.meta()).interrupted).toBe(false);
    });

    it('is incomplete when the budget runs out before the open pass can start', async () => {
      const store = new MemoryStore();
      // One page reaches `since` and uses the whole budget, so no open pass runs.
      const result = await sync({
        client: fakeGithub(threePages()).client,
        store,
        repo,
        maxPrs: 1,
        since: new Date('2026-01-02T12:00:00Z'),
      });
      expect(result).toMatchObject({ stoppedBecause: 'max-prs', openPass: null, complete: false });
      expect(store.reconciledAt).toBeNull();
      expect((await store.meta()).interrupted).toBe(true);
    });

    it('keeps the earliest start across consecutive cut runs until one completes', async () => {
      const store = new MemoryStore();
      const now = minuteClock();
      const pages = closedPages;
      await sync({ client: fakeGithub(pages()).client, store, repo, since, maxPrs: 1, now });
      expect(store.startedAt).toBe('2026-03-01T00:00:00.000Z');
      await sync({ client: fakeGithub(pages()).client, store, repo, since, maxPrs: 1, now });
      expect(store.startedAt).toBe('2026-03-01T00:00:00.000Z');
      expect((await store.meta()).syncStartedAt).toBe('2026-03-01T00:00:00.000Z');
      const result = await sync({ client: fakeGithub(pages()).client, store, repo, since, now });
      expect(result.complete).toBe(true);
      expect(store.reconciledAt).toBe('2026-03-01T00:00:00.000Z');
      expect(store.startedAt).toBeNull();
    });
  });

  describe('catch-up watermark', () => {
    const base = Date.UTC(2026, 2, 1);
    const MINUTE = 60_000;
    const at = (offset: number) => new Date(base + offset).toISOString();

    /** A 30-day run that starts at 00:00 and finishes at 00:05. */
    async function firstRun(store: MemoryStore) {
      const stamps = [0, 5 * MINUTE];
      let i = 0;
      await sync({
        client: fakeGithub([[node(1, at(-1 * DAY))], [node(2, at(-40 * DAY))]]).client,
        store,
        repo,
        since: new Date(base - 30 * DAY),
        now: () => new Date(base + (stamps[i++] ?? 0)),
      });
      expect(store.reconciledAt).toBe(at(0));
      expect(store.syncedAt).toBe(at(5 * MINUTE));
    }

    // Upstream 40 days later: #1 was updated at 00:01 and #2 at 00:04, both
    // after their page had been fetched by the first run; #4 changed after it
    // finished; #3 is recent and #5, #6 are older than everything.
    const laterPages = () => [
      [node(3, at(39 * DAY))],
      [node(4, at(6 * MINUTE))],
      [node(2, at(4 * MINUTE))],
      [node(1, at(1 * MINUTE))],
      [node(5, at(-1 * DAY))],
      [node(6, at(-2 * DAY))],
    ];

    it('walks back to the start of the last complete run, so PRs updated while it ran are caught', async () => {
      const store = new MemoryStore();
      await firstRun(store);
      const { client, calls } = fakeGithub(laterPages());
      const result = await sync({
        client,
        store,
        repo,
        since: new Date(base + 10 * DAY),
        now: () => new Date(base + 40 * DAY),
      });
      expect(result.stoppedBecause).toBe('since');
      expect(calls.filter((c) => c.states === null)).toHaveLength(5);
      expect(store.prs.get(2)?.updatedAt).toBe(at(4 * MINUTE));
      expect(store.prs.get(1)?.updatedAt).toBe(at(1 * MINUTE));
    });

    it('walks back to the start of a first-ever partial run, not its finish', async () => {
      // The first run is cut by the budget after one page: no `reconciledAt`
      // yet, only the in-flight start (00:00) and the finish time (00:05).
      const store = new MemoryStore();
      const stamps = [0, 5 * MINUTE];
      let i = 0;
      await sync({
        client: fakeGithub([[node(1, at(-1 * DAY))], [node(2, at(-40 * DAY))]]).client,
        store,
        repo,
        since: new Date(base - 30 * DAY),
        maxPrs: 1,
        now: () => new Date(base + (stamps[i++] ?? 0)),
      });
      expect(store).toMatchObject({
        reconciledAt: null,
        startedAt: at(0),
        syncedAt: at(5 * MINUTE),
      });

      const { client, calls } = fakeGithub(laterPages());
      await sync({
        client,
        store,
        repo,
        since: new Date(base + 10 * DAY),
        now: () => new Date(base + 40 * DAY),
      });
      // Falling back to the finish time would stop on the page that dips under
      // 00:05: #2 would come along and #1, updated at 00:01, would be missed.
      expect(calls.filter((c) => c.states === null)).toHaveLength(5);
      expect(store.prs.get(2)?.updatedAt).toBe(at(4 * MINUTE));
      expect(store.prs.get(1)?.updatedAt).toBe(at(1 * MINUTE));
      expect(store.reconciledAt).toBe(at(0));
    });

    it('never stops on unchanged pages for a legacy store with neither stamp', async () => {
      // A file written before either stamp existed: only `syncedAt`. Nothing
      // says what that run reconciled, so cached pages prove nothing.
      const pages = [[node(1, at(-1 * DAY))], [node(9, at(-2 * DAY))], [node(2, at(-40 * DAY))]];
      const store = new MemoryStore();
      await sync({
        client: fakeGithub(pages).client,
        store,
        repo,
        since: new Date(base - 30 * DAY),
        now: () => new Date(base),
      });
      store.reconciledAt = null;
      store.startedAt = null;
      expect((await store.meta()).interrupted).toBe(false);

      // #10 appeared below two pages the store already holds.
      const { client, calls } = fakeGithub([
        pages[0] ?? [],
        pages[1] ?? [],
        [node(10, at(-3 * DAY))],
        pages[2] ?? [],
      ]);
      const result = await sync({
        client,
        store,
        repo,
        since: new Date(base - 30 * DAY),
        now: () => new Date(base + 1 * DAY),
      });
      // Two unchanged pages used to end the walk as "already-synced" above #10.
      expect(result).toMatchObject({ stoppedBecause: 'exhausted', changed: 1 });
      expect(calls.filter((c) => c.states === null)).toHaveLength(4);
      expect(store.prs.has(10)).toBe(true);
    });

    it('does not count unchanged pages newer than the watermark, so a closure below them is reached', async () => {
      // Run 1 starts at 00:00. Its main pass fetches open #12, #11 and #10,
      // then #1 sends it past `since`. Before its open pass, #10 closes (00:01)
      // and #12, #11 get touched (00:02, 00:03); the open pass caches those two
      // at their new `updatedAt`. Run 2 then meets two unchanged pages first.
      const since = new Date(base - 30 * DAY);
      const pages = [
        [node(12, at(-1 * DAY), 'OPEN')],
        [node(11, at(-2 * DAY), 'OPEN')],
        [node(10, at(-3 * DAY), 'OPEN')],
        [node(1, at(-40 * DAY))],
        [node(0, at(-50 * DAY))],
      ];
      const upstreamAfterMainPass = () => [
        [node(11, at(3 * MINUTE), 'OPEN')],
        [node(12, at(2 * MINUTE), 'OPEN')],
        [node(10, at(1 * MINUTE), 'CLOSED')],
        [node(1, at(-40 * DAY))],
        [node(0, at(-50 * DAY))],
      ];
      const store = new MemoryStore();
      const now = minuteClock();
      const first = await sync({
        client: fakeGithub(pages).client,
        store,
        repo,
        since,
        now,
        onPage: (p) => {
          if (p.pass === 'all' && p.pages === 4) pages.splice(0, 5, ...upstreamAfterMainPass());
        },
      });
      expect(first).toMatchObject({
        stoppedBecause: 'since',
        openPass: { pages: 1, changed: 2, stoppedBecause: 'exhausted' },
        complete: true,
      });
      expect(store.reconciledAt).toBe(at(0));
      expect(store.prs.get(10)?.state).toBe('OPEN');
      expect(store.prs.get(12)?.updatedAt).toBe(at(2 * MINUTE));

      // Without the rule, #11 and #12 look unchanged, the walk stops as
      // "already-synced" above #10, and the run completes with #10 still OPEN.
      const { client, calls } = fakeGithub(upstreamAfterMainPass());
      const result = await sync({ client, store, repo, since, now });
      expect(result).toMatchObject({ stoppedBecause: 'since', changed: 1, complete: true });
      expect(calls.filter((c) => c.states === null)).toHaveLength(4);
      expect(store.prs.get(10)?.state).toBe('CLOSED');
    });
  });
});

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 24 * 3600e3);
const iso = (n: number) => day(n).toISOString();

describe('effectiveSince', () => {
  it('walks back to the last completed sync when that is older than the cutoff', () => {
    expect(effectiveSince(new Date('2026-03-01T00:00:00Z'), '2026-01-01T00:00:00Z')).toEqual(
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(effectiveSince(new Date('2026-03-01T00:00:00Z'), '2026-04-01T00:00:00Z')).toEqual(
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(effectiveSince(new Date('2026-03-01T00:00:00Z'), null)).toEqual(
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(effectiveSince(undefined, '2026-01-01T00:00:00Z')).toBeUndefined();
  });

  it('fetches PRs updated between two syncs even when they are older than the new cutoff', async () => {
    const store = new MemoryStore();
    await sync({
      client: fakeGithub([[node(1, iso(-5))], [node(7, iso(-60))], [node(8, iso(-70))]]).client,
      store,
      repo,
      since: day(-30),
      now: () => day(0),
    });
    expect(store.syncedAt).toBe(iso(0));

    const pages = [
      [node(2, iso(50))],
      [node(5, iso(29))],
      [node(3, iso(10))],
      [node(4, iso(-40))],
      [node(6, iso(-50))],
    ];
    const { client, calls } = fakeGithub(pages);
    const result = await sync({ client, store, repo, since: day(30), now: () => day(60) });
    expect(calls.filter((c) => c.states === null)).toHaveLength(4);
    expect(store.prs.has(3)).toBe(true);
    expect(result.stoppedBecause).toBe('since');
    expect(store.coverageSince).toBe(iso(-30));
  });
});

describe('catchUpSince', () => {
  const requested = new Date('2026-03-01T00:00:00Z');

  it('uses the safe watermark when there is one', () => {
    expect(
      catchUpSince(requested, {
        reconciledAt: '2026-01-01T00:00:00Z',
        syncStartedAt: null,
        syncedAt: '2026-02-01T00:00:00Z',
        coverageSince: '2025-06-01T00:00:00Z',
      }),
    ).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('takes the request as-is for a never-synced store', () => {
    expect(
      catchUpSince(requested, {
        reconciledAt: null,
        syncStartedAt: null,
        syncedAt: null,
        coverageSince: null,
      }),
    ).toEqual(requested);
  });

  it('reconciles a legacy store back to its coverage boundary, or everything when full', () => {
    const legacy = { reconciledAt: null, syncStartedAt: null, syncedAt: '2026-02-01T00:00:00Z' };
    expect(catchUpSince(requested, { ...legacy, coverageSince: '2025-12-01T00:00:00Z' })).toEqual(
      new Date('2025-12-01T00:00:00Z'),
    );
    expect(catchUpSince(requested, { ...legacy, coverageSince: null })).toBeUndefined();
  });
});
