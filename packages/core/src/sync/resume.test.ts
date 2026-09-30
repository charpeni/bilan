import { describe, expect, it } from 'vitest';

import { FakeGithub } from '../testing/github.ts';
import { CheckpointStore, MemoryStore } from '../testing/memory-store.ts';
import { sync } from './engine.ts';

import type { SyncInput, SyncResult } from './engine.ts';

const repo = { owner: 'acme', name: 'widgets' };
const HOUR = 3_600_000;

/** A clock that stands still during a run; `advance` moves it between runs. */
function clock(start = '2026-06-02T00:00:00Z') {
  let at = Date.parse(start);
  return {
    now: () => new Date(at),
    at: (minutes: number) => new Date(at + minutes * 60_000).toISOString(),
    advance: (ms = HOUR) => {
      at += ms;
    },
  };
}

type Clock = ReturnType<typeof clock>;

interface WindowsOptions {
  /** Points in each rate-limit window; each request costs 1 against a reserve of 200. */
  points: number;
  input: Omit<SyncInput, 'client' | 'store' | 'repo' | 'now'>;
  /** Called between runs with the number of runs so far, after the clock moved on. */
  between?: (runs: number) => void;
  maxRuns?: number;
}

/** Run one sync per fresh rate-limit window until a run completes (or `maxRuns`). */
async function windows(
  github: FakeGithub,
  store: MemoryStore,
  time: Clock,
  { points, input, between, maxRuns = 20 }: WindowsOptions,
): Promise<{ results: SyncResult[]; requests: number[] }> {
  const results: SyncResult[] = [];
  const requests: number[] = [];
  for (let run = 0; run < maxRuns; run++) {
    if (run > 0) {
      time.advance();
      between?.(run);
    }
    github.newWindow(points);
    const before = github.calls.length;
    const result = await sync({ ...input, client: github.client(), store, repo, now: time.now });
    results.push(result);
    requests.push(github.calls.length - before);
    if (result.complete) break;
  }
  return { results, requests };
}

/** The store holds exactly what GitHub has, for the PRs `keep` selects. */
function expectCurrent(
  store: MemoryStore,
  github: FakeGithub,
  keep: (pr: { number: number; updatedAt: string; state: string }) => boolean = () => true,
) {
  const expected = [...github.prs.values()]
    .filter(keep)
    .map(({ number, updatedAt, state }) => ({ number, updatedAt, state }))
    .toSorted((a, b) => a.number - b.number);
  const actual = [...store.prs.values()]
    .filter((pr) => expected.some((e) => e.number === pr.number))
    .map(({ number, updatedAt, state }) => ({ number, updatedAt, state }))
    .toSorted((a, b) => a.number - b.number);
  expect(actual).toEqual(expected);
}

describe('sync across rate-limit windows', () => {
  it('finishes a full history larger than one window instead of restarting it', async () => {
    const github = FakeGithub.history(400);
    const store = new CheckpointStore();
    const { results, requests } = await windows(github, store, clock(), {
      points: 212,
      input: { mode: 'full' },
    });
    // 16 pages: 13 in the first window, then one page to confirm nothing
    // changed since and the three the first window did not reach.
    expect(requests).toEqual([13, 4]);
    expect(results.map((r) => r.stoppedBecause)).toEqual(['rate-limit', 'exhausted']);
    expect(results[1]).toMatchObject({ complete: true, coverageSince: null });
    expect(store.prs.size).toBe(400);
    expect(store.coverageSince).toBeNull();
    expect(store.reconciledAt).toBe('2026-06-02T00:00:00.000Z');
    expect(store.checkpoints).toEqual({ all: null, open: null });
  });

  it('restarts from the newest page every window when the store keeps no checkpoints', async () => {
    const github = FakeGithub.history(400);
    const store = new MemoryStore();
    const { results } = await windows(github, store, clock(), {
      points: 212,
      input: { mode: 'full' },
      maxRuns: 4,
    });
    expect(results.map((r) => r.complete)).toEqual([false, false, false, false]);
    expect(store.prs.size).toBe(325);
  });

  it('re-checks PRs created, updated or closed between windows before going on', async () => {
    const github = FakeGithub.history(400);
    const store = new CheckpointStore();
    const time = clock();
    const { results, requests } = await windows(github, store, time, {
      points: 212,
      input: { mode: 'full' },
      between: (runs) => {
        // Made after the previous run started and before this one.
        const at = time.at(-30);
        if (runs === 1) {
          // More than a page of them, so re-checking takes more than one page.
          for (let n = 1; n <= 30; n++) github.set(n, at); // not reached yet: they move up
          github.set(350, at, 'CLOSED'); // walked already: its cached copy is stale
          github.set(401, at, 'OPEN'); // new
        }
        if (runs === 2) github.set(120, at, 'CLOSED');
      },
      maxRuns: 3,
    });
    // Two pages re-check the 32 changed PRs, then two more finish the walk.
    expect(requests).toEqual([13, 4]);
    expect(results.at(-1)?.complete).toBe(true);
    expectCurrent(store, github);
  });

  it('catches up on a PR that moved above the walk while it ran', async () => {
    const github = FakeGithub.history(400);
    const store = new CheckpointStore();
    const time = clock();
    // During the second run, after it has joined the first run's walk, a PR
    // it has not reached yet is updated and moves above it.
    github.fail = (call) => {
      if (call === 15) github.set(20, time.at(5));
      return undefined;
    };
    const { results } = await windows(github, store, time, {
      points: 212,
      input: { mode: 'full' },
    });
    expect(results.at(-1)?.complete).toBe(true);
    expect(store.prs.get(20)?.updatedAt).not.toBe(github.prs.get(20)?.updatedAt);

    // The next run reaches back to the start of the first unfinished run.
    time.advance();
    github.newWindow(5000);
    const before = github.calls.length;
    const next = await sync({ client: github.client(), store, repo, now: time.now });
    expect(next.complete).toBe(true);
    expect(github.calls.length - before).toBeLessThanOrEqual(3);
    expectCurrent(store, github);
  });

  it('finishes a deep --since sync and its open pass across windows', async () => {
    const github = FakeGithub.history(400);
    // Old open PRs well below --since, so the open pass has pages of its own.
    for (let n = 3; n < 100; n += 2) github.set(n, github.prs.get(n)!.updatedAt, 'OPEN');
    const since = new Date(Date.parse('2026-06-01T00:00:00Z') - 300 * HOUR);
    const store = new CheckpointStore();
    const time = clock();
    const { results, requests } = await windows(github, store, time, {
      points: 206,
      input: { since },
      between: (runs) => {
        const at = time.at(-30);
        if (runs === 1) github.set(31, at, 'CLOSED'); // an old open PR closes
        if (runs === 2) github.set(31, at, 'OPEN'); // and reopens
        if (runs === 3) github.set(402, at, 'OPEN');
      },
    });
    const last = results.at(-1)!;
    expect(last).toMatchObject({
      complete: true,
      openPrsComplete: true,
      stoppedBecause: 'since',
      coverageSince: since.toISOString(),
    });
    // 13 main pages and 2 open pages, 6 requests a window, re-walking only
    // the newest page of each walk once per window.
    expect(requests.reduce((a, b) => a + b)).toBeLessThanOrEqual(15 + 2 * requests.length);
    expect(results.length).toBeLessThanOrEqual(5);
    expectCurrent(store, github, (pr) => pr.state === 'OPEN' || Date.parse(pr.updatedAt) >= +since);
    expect(store.openPrsSyncedAt).not.toBeNull();
    expect(store.checkpoints?.open).toBeNull();
  });

  it('keeps exact --max-prs budgets while it continues', async () => {
    const github = FakeGithub.history(100);
    const store = new CheckpointStore();
    const time = clock();
    const { results } = await windows(github, store, time, {
      points: 5000,
      input: { mode: 'full', maxPrs: 30 },
    });
    expect(results.every((r) => r.fetched <= 30)).toBe(true);
    const sizes = github.calls.map((c) => c.page);
    expect(sizes.slice(0, 4)).toEqual([25, 5, 25, 5]);
    expect(results.at(-1)).toMatchObject({ complete: true, stoppedBecause: 'exhausted' });
    expect(store.prs.size).toBe(100);
  });

  it('uses what an interrupted --full walk reached for a shallower run, then continues it', async () => {
    const github = FakeGithub.history(400, '2026-06-01T00:00:00Z', 24);
    const store = new CheckpointStore();
    const time = clock();
    const first = await windows(github, store, time, {
      points: 212,
      input: { mode: 'full' },
      maxRuns: 1,
    });
    expect(first.results[0]).toMatchObject({ complete: false, fetched: 325 });
    const saved = store.checkpoints?.all;
    expect(saved).toMatchObject({ from: '2026-06-02T00:00:00.000Z' });

    // The 30-day default is inside what the first walk reached: one page to
    // re-check the newest PRs, then the open pass.
    time.advance();
    github.newWindow(5000);
    const shallow = await sync({
      client: github.client(),
      store,
      repo,
      since: new Date('2026-05-03T00:00:00Z'),
      now: time.now,
    });
    expect(shallow).toMatchObject({ complete: true, stoppedBecause: 'since', pages: 2 });

    // --full then goes on from where the first walk stopped.
    time.advance();
    const before = github.calls.length;
    const full = await sync({ client: github.client(), store, repo, mode: 'full', now: time.now });
    expect(github.calls.slice(before).map((c) => c.cursor)).toEqual([
      null,
      saved?.cursor,
      expect.any(String),
      expect.any(String),
    ]);
    expect(full).toMatchObject({ complete: true, coverageSince: null });
    expect(store.prs.size).toBe(400);
  });

  it('forgets a saved cursor GitHub fails on, so the next run starts over', async () => {
    const github = FakeGithub.history(60);
    const store = new CheckpointStore();
    const time = clock();
    store.checkpoints = {
      all: { cursor: 'not-a-cursor', reached: '2026-05-30T00:00:00Z', from: time.at(-60) },
      open: null,
    };
    await expect(
      sync({ client: github.client(), store, repo, mode: 'full', now: time.now }),
    ).rejects.toThrow(/GitHub request failed/);
    expect(store.checkpoints?.all).toBeNull();
    time.advance();
    const result = await sync({
      client: github.client(),
      store,
      repo,
      mode: 'full',
      now: time.now,
    });
    expect(result).toMatchObject({ complete: true, fetched: 60 });
  });

  it('ignores a checkpoint from a run that started after this one', async () => {
    const github = FakeGithub.history(60);
    const store = new CheckpointStore();
    store.checkpoints = {
      all: { cursor: 'bogus', reached: '2020-01-01T00:00:00Z', from: '2999-01-01T00:00:00Z' },
      open: null,
    };
    const result = await sync({ client: github.client(), store, repo, mode: 'full' });
    expect(github.calls.map((c) => c.cursor).includes('bogus')).toBe(false);
    expect(result).toMatchObject({ complete: true, fetched: 60 });
  });
});
