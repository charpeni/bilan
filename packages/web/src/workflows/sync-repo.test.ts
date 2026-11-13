import { REPO_META_QUERY } from '@bilan/core';
/**
 * The sync Workflow's page loop against fakes: GitHub (a static history with
 * GitHub's cursor semantics), the store (core's `CheckpointStore`, which keeps
 * D1Store's rules), the sync model, and a `step` that caches each result the
 * way Workflows do, so a second `run()` with the same steps is a replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prNode } from '../../../core/src/testing/github.ts';
import { CheckpointStore } from '../../../core/src/testing/memory-store.ts';
import { SyncRepoWorkflow } from './sync-repo.ts';

import type { FakePr } from '../../../core/src/testing/github.ts';
import type { SyncRepoParams } from './sync-repo.ts';
import type { PrState } from '@bilan/core';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const shared = vi.hoisted(() => {
  const state = {
    store: undefined as unknown,
    published: [] as string[],
    // Every store the Workflow opens is the one the test holds.
    D1Store: function D1Store() {
      return state.store;
    },
  };
  return state;
});

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock('@bilan/store-d1', () => ({
  createDb: () => ({}),
  schema: { repos: {} },
  upsertRepo: (_db: unknown, repo: { id: string }) => Promise.resolve({ id: repo.id }),
  D1Store: shared.D1Store,
}));
vi.mock('../lib/domain.ts', () => ({
  reportStarted: () => Promise.resolve({ ok: true }),
  reportProgress: () => Promise.resolve({ ok: true }),
  reportPause: () => Promise.resolve({ ok: true }),
  reportFinished: () => Promise.resolve({ ok: true }),
  reportFailed: () => Promise.resolve({ ok: true }),
}));
vi.mock('../lib/tokens.ts', () => ({
  ReauthRequiredError: class ReauthRequiredError extends Error {},
  useUserToken: () => Promise.reject(new Error('server token only')),
}));

const MINUTE = 60_000;
const order = (a: FakePr, b: Pick<FakePr, 'updatedAt' | 'number'>) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number;

/**
 * GitHub's pull request pages, newest `updatedAt` first, with cursors that
 * encode the last PR's sort key (as `FakeGithub` in core), sorted once per
 * change so a history deeper than the Workflow's page budget stays quick.
 */
class Github {
  readonly prs = new Map<number, FakePr>();
  readonly cursors: (string | null)[] = [];
  private sorted = new Map<string, FakePr[]>();

  static history(count: number, newest: number, step = MINUTE): Github {
    const github = new Github();
    for (let n = 1; n <= count; n++) {
      github.set(n, new Date(newest - (count - n) * step).toISOString());
    }
    return github;
  }

  set(number: number, updatedAt: string, state: PrState = 'MERGED'): void {
    this.prs.set(number, { number, updatedAt, state });
    this.sorted.clear();
  }

  private list(states: PrState[] | null): FakePr[] {
    const key = String(states);
    let list = this.sorted.get(key);
    if (list === undefined) {
      list = [...this.prs.values()]
        .filter((pr) => states === null || states.includes(pr.state))
        .toSorted(order);
      this.sorted.set(key, list);
    }
    return list;
  }

  readonly fetch: typeof globalThis.fetch = (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { cursor: string | null; page: number; states: PrState[] | null };
    };
    const rateLimit = { cost: 1, remaining: 5000, resetAt: '2999-01-01T00:00:00Z' };
    if (query === REPO_META_QUERY) {
      return Promise.resolve(
        Response.json({
          data: {
            repository: {
              id: 'R_repo',
              isPrivate: false,
              viewerPermission: 'READ',
              pullRequests: { totalCount: this.prs.size },
            },
            rateLimit,
          },
        }),
      );
    }
    this.cursors.push(variables.cursor);
    let after: Pick<FakePr, 'updatedAt' | 'number'> | null = null;
    try {
      after = variables.cursor === null ? null : JSON.parse(atob(variables.cursor));
    } catch {
      return Promise.resolve(new Response('Bad cursor', { status: 400 }));
    }
    const list = this.list(variables.states);
    const lo = after === null ? 0 : firstAfter(list, after);
    const nodes = list.slice(lo, lo + variables.page);
    const last = nodes.at(-1);
    return Promise.resolve(
      Response.json({
        data: {
          repository: {
            id: 'R_repo',
            pullRequests: {
              pageInfo: {
                hasNextPage: lo + nodes.length < list.length,
                endCursor:
                  last === undefined
                    ? null
                    : btoa(JSON.stringify({ updatedAt: last.updatedAt, number: last.number })),
              },
              nodes: nodes.map((pr) => prNode(pr.number, pr.updatedAt, pr.state)),
            },
          },
          rateLimit,
        },
      }),
    );
  };
}

/** The index of the first PR in `list` that sorts after `key`. */
function firstAfter(list: FakePr[], key: Pick<FakePr, 'updatedAt' | 'number'>): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (order(list[mid]!, key) > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

class Hibernate extends Error {}

/**
 * Workflow steps: each result is cached by name and serialized as Workflows
 * do, a failing step is retried up to its limit, and `hibernateAt` stops the
 * run before that step as an eviction would, so `run()` again replays it.
 */
class Steps {
  readonly results = new Map<string, unknown>();
  readonly executed: string[] = [];
  hibernateAt: string | null = null;
  failAt: string | null = null;

  do = async <T>(
    name: string,
    config: { retries?: { limit: number } } | (() => Promise<T>),
    callback?: () => Promise<T>,
  ): Promise<T> => {
    if (this.results.has(name)) return this.results.get(name) as T;
    if (name === this.hibernateAt) {
      this.hibernateAt = null;
      throw new Hibernate(name);
    }
    if (name === this.failAt) throw new Error(`step ${name} failed`);
    const fn = typeof config === 'function' ? config : callback!;
    const limit = typeof config === 'function' ? 0 : (config.retries?.limit ?? 0);
    for (let attempt = 0; ; attempt++) {
      try {
        this.executed.push(name);
        const result = (await fn()) ?? null;
        const stored = JSON.parse(JSON.stringify(result)) as T;
        this.results.set(name, stored);
        return stored;
      } catch (error) {
        if (attempt >= limit) throw error;
      }
    }
  };

  sleepUntil = () => Promise.resolve();
  sleep = () => Promise.resolve();
}

const env = {
  GITHUB_TOKEN: 'test',
  PAYLOADS: {
    put: (key: string) => {
      shared.published.push(key);
      return Promise.resolve(null);
    },
  },
};

let runs = 0;
async function run(
  steps: Steps,
  payload: Partial<SyncRepoParams> = {},
  instanceId = `job-${++runs}`,
): Promise<void> {
  const workflow = new SyncRepoWorkflow({} as ExecutionContext, env as unknown as Env);
  const event = {
    payload: {
      tokenSource: 'server',
      repoId: 'R_repo',
      owner: 'acme',
      name: 'widgets',
      mode: 'incremental',
      depth: 'all',
      ...payload,
    },
    instanceId,
    timestamp: new Date(),
  } as WorkflowEvent<SyncRepoParams>;
  await workflow.run(event, steps as unknown as WorkflowStep);
}

const view = (prs: Iterable<{ number: number; updatedAt: string; state: string }>) =>
  [...prs]
    .map(({ number, updatedAt, state }) => ({ number, updatedAt, state }))
    .toSorted((a, b) => a.number - b.number);

/** The store holds every PR exactly as GitHub has it. */
function expectCurrent(store: CheckpointStore, github: Github) {
  expect(view(store.prs.values())).toEqual(view(github.prs.values()));
}

let store: CheckpointStore;
beforeEach(() => {
  store = new CheckpointStore();
  shared.store = store;
  shared.published = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function useGithub(github: Github) {
  vi.stubGlobal('fetch', github.fetch);
}

/** Epoch ms well before any run in the test starts. */
const past = (days: number) => Date.now() - days * 24 * 60 * MINUTE;

describe('SyncRepoWorkflow across runs', () => {
  it('finishes a history deeper than the page budget on the next run', async () => {
    // 1,004 pages: the first run stops at its 1,000-page budget.
    const github = Github.history(25_100, past(1));
    useGithub(github);
    await run(new Steps());
    expect(github.cursors).toHaveLength(1000);
    expect(store.prs.size).toBe(25_000);
    expect(store.startedAt).not.toBeNull();
    const saved = store.checkpoints?.all;
    // The 25,000th newest PR is number 101; coverage claims nothing below it.
    expect(saved).toMatchObject({
      reached: github.prs.get(101)?.updatedAt,
      from: store.startedAt,
    });
    expect(store.coverageSince).toBe(
      new Date(Date.parse(github.prs.get(101)!.updatedAt) + 1).toISOString(),
    );

    // Between the runs: one PR the first run never reached is updated (it
    // moves to the top), one it walked closes, and one is opened.
    const at = new Date().toISOString();
    github.set(50, at);
    github.set(200, at, 'CLOSED');
    github.set(25_101, at, 'OPEN');

    const before = github.cursors.length;
    await run(new Steps());
    // The newest page re-checks what moved, then the walk goes on from where
    // the first run stopped: 99 PRs left in four pages.
    expect(github.cursors.slice(before)).toEqual([
      null,
      saved?.cursor,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    expectCurrent(store, github);
    expect(store.coverageSince).toBeNull();
    expect(store.startedAt).toBeNull();
    expect(store.reconciledAt).not.toBeNull();
    expect(store.checkpoints?.all).toBeNull();
  });

  it('replays to the same walk after hibernating, and saves the checkpoint once per page', async () => {
    const github = Github.history(200, past(1));
    useGithub(github);
    await run(new Steps(), { maxPrs: 50 });
    const saved = store.checkpoints?.all;
    expect(saved?.reached).toBe(github.prs.get(151)?.updatedAt);
    github.set(10, new Date().toISOString());

    const steps = new Steps();
    steps.hibernateAt = 'page-3';
    const saves = vi.spyOn(store, 'saveCheckpoints');
    await expect(run(steps, {}, 'job-replayed')).rejects.toThrow(Hibernate);
    const fetchedBeforeEviction = github.cursors.length;
    // Page 1 joined the first run's walk; page 2 went on from its cursor.
    expect(github.cursors.at(-2)).toBeNull();
    expect(github.cursors.at(-1)).toBe(saved?.cursor);
    expect(saves).toHaveBeenCalledTimes(2);

    // The replay takes pages 1 and 2 from their cached results: no request,
    // no save, and the loop goes on from where page 2 left it.
    await run(steps, {}, 'job-replayed');
    expect(steps.executed.filter((name) => name === 'page-1' || name === 'page-2')).toEqual([
      'page-1',
      'page-2',
    ]);
    expect(github.cursors.length - fetchedBeforeEviction).toBe(5);
    expect(saves).toHaveBeenCalledTimes(7);
    expectCurrent(store, github);
    expect(store.checkpoints?.all).toBeNull();
    expect(store.coverageSince).toBeNull();
  });

  it('claims coverage down to what both walks reached, and no further', async () => {
    const github = Github.history(200, past(1));
    useGithub(github);
    await run(new Steps(), { maxPrs: 75 });
    await run(new Steps(), { maxPrs: 50 });
    // The second run re-checked the newest page and walked one more from the
    // first run's cursor: 100 PRs between them, down to number 101.
    expect(store.prs.size).toBe(100);
    expect(store.checkpoints?.all?.reached).toBe(github.prs.get(101)?.updatedAt);
    expect(store.coverageSince).toBe(
      new Date(Date.parse(github.prs.get(101)!.updatedAt) + 1).toISOString(),
    );
  });

  it('publishes a staged first sync honestly after joining an earlier walk', async () => {
    // One PR every three hours: page 4 ends 12.5 days back, between the
    // interim 7-day bound and the 30-day depth.
    const github = Github.history(400, Date.now() - 60 * MINUTE, 180 * MINUTE);
    useGithub(github);
    const failed = new Steps();
    failed.failAt = 'page-5';
    await expect(run(failed)).rejects.toThrow(/page-5 failed/);
    expect(store.syncedAt).toBeNull();
    expect(store.checkpoints?.all?.reached).toBe(github.prs.get(301)?.updatedAt);
    const saved = store.checkpoints?.all;

    const since = new Date(Date.now() - 30 * 24 * 60 * MINUTE).toISOString();
    const before = github.cursors.length;
    const stamps = vi.spyOn(store, 'markSynced');
    await run(new Steps(), { depth: '30d', since });
    // The newest page joins the failed run's walk, already below the 7-day
    // bound: the interim payload claims that bound and no more, then the walk
    // goes on from the failed run's cursor to 30 days.
    expect(github.cursors.slice(before, before + 2)).toEqual([null, saved?.cursor]);
    expect(shared.published).toHaveLength(2);
    expect(stamps).toHaveBeenCalledTimes(2);
    const [interimAt, interimCoverage, , interimComplete] = stamps.mock.calls[0]!;
    expect(interimComplete).toBe(false);
    const sevenDays = Date.parse(interimAt) - 7 * 24 * 60 * MINUTE;
    expect(Math.abs(Date.parse(interimCoverage!) - sevenDays)).toBeLessThan(MINUTE);
    expect(stamps.mock.calls[1]?.slice(1)).toEqual([since, true, true]);
    expect(store.coverageSince).toBe(since);
    expect(store.startedAt).toBeNull();
    for (const pr of github.prs.values()) {
      if (pr.updatedAt >= since) expect(store.prs.get(pr.number)?.updatedAt).toBe(pr.updatedAt);
    }
  });

  it('stops at `since` as soon as the walk it joined reached below it', async () => {
    // One PR every three hours: 250 PRs reach 31 days back.
    const github = Github.history(400, Date.now() - 60 * MINUTE, 180 * MINUTE);
    useGithub(github);
    await run(new Steps(), { maxPrs: 250 });
    expect(store.checkpoints?.all?.reached).toBe(github.prs.get(151)?.updatedAt);

    const since = new Date(Date.now() - 30 * 24 * 60 * MINUTE).toISOString();
    const before = github.cursors.length;
    await run(new Steps(), { depth: '30d', since });
    // The newest page, then the open pass: nothing below the joined walk.
    expect(github.cursors.slice(before)).toEqual([null, null]);
    // Coverage keeps the deeper bound the first run already claimed.
    expect(store.coverageSince).toBe(
      new Date(Date.parse(github.prs.get(151)!.updatedAt) + 1).toISOString(),
    );
    expect(store.startedAt).toBeNull();
    expect(store.openPrsSyncedAt).not.toBeNull();
  });

  it('goes on with a cut-short open pass from where it stopped', async () => {
    // One PR every three hours; 75 open PRs well below the 30-day bound.
    const github = Github.history(400, Date.now() - 60 * MINUTE, 180 * MINUTE);
    for (let n = 2; n <= 150; n += 2) github.set(n, github.prs.get(n)!.updatedAt, 'OPEN');
    useGithub(github);
    const since = new Date(Date.now() - 30 * 24 * 60 * MINUTE).toISOString();
    // Ten main pages reach `since`; the open pass is cut after two pages.
    await run(new Steps(), { depth: '30d', since, maxPrs: 300 });
    expect(store.openPrsSyncedAt).toBeNull();
    expect(store.startedAt).not.toBeNull();
    const open = store.checkpoints?.open;
    expect(open?.reached).toBe(github.prs.get(52)?.updatedAt);

    const before = github.cursors.length;
    await run(new Steps(), { depth: '30d', since });
    // One main page joins the first run's main walk, already past `since`;
    // one open page joins its open walk, which then takes its last page.
    expect(github.cursors.slice(before)).toEqual([null, null, open?.cursor]);
    expect(store.openPrsSyncedAt).not.toBeNull();
    expect(store.startedAt).toBeNull();
    expect(store.checkpoints?.open).toBeNull();
    for (const pr of github.prs.values()) {
      if (pr.state === 'OPEN') expect(store.prs.get(pr.number)?.state).toBe('OPEN');
    }
  });

  it('forgets a saved cursor GitHub rejects, so the next run starts over', async () => {
    const github = Github.history(60, past(1));
    useGithub(github);
    await store.markStarted(new Date(past(1)).toISOString());
    store.checkpoints = {
      all: {
        cursor: 'not-a-cursor',
        reached: new Date(past(30)).toISOString(),
        from: new Date(past(1)).toISOString(),
      },
      open: null,
    };
    await expect(run(new Steps())).rejects.toThrow(/GitHub responded 400/);
    expect(store.checkpoints?.all).toBeNull();

    await run(new Steps());
    expectCurrent(store, github);
    expect(store.startedAt).toBeNull();
  });
});
