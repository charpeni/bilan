import { describe, expect, it, vi } from 'vitest';

import { PRS_STORED_HEADER, SYNC_ACTIVE_HEADER, SYNCED_AT_HEADER } from './poll.ts';
import {
  RETRY_LIMIT,
  STOPPED_MESSAGE,
  SyncWatchError,
  UNREACHABLE_MESSAGE,
  watchSync,
} from './sync-watch.ts';

const T1 = '2026-05-01T12:00:00.000Z';
const T2 = '2026-05-01T12:05:00.000Z';
const API = '/api/repos/acme/web';

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that answers each call from the queue and records what was asked. */
function fakeFetch(answers: Answer[]) {
  const calls: { url: string; method: string }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    });
  });
  return { fetch, calls };
}

const sleep = () => Promise.resolve();
const times = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

/** A staged first sync's job row, in stage `current` of two. */
const staged = (current: number) => ({
  status: 'running',
  settled: false,
  prsStored: 40,
  stage: { current, total: 2, label: 'Last 7 days published; reading up to 30 days' },
});

describe('watchSync', () => {
  it('hands over to the dashboard once a staged run has published its interim payload', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: staged(1) },
      { status: 200, body: staged(2) },
      { status: 200, headers: { [SYNCED_AT_HEADER]: T1, [SYNC_ACTIVE_HEADER]: '1' } },
    ]);
    const onProgress = vi.fn();
    await watchSync({ kind: 'job', jobId: 'j1' }, null, {
      apiBase: API,
      fetch,
      sleep,
      onProgress,
      untilFirstPayload: true,
    });
    expect(calls).toEqual([
      { url: '/api/sync/j1', method: 'GET' },
      { url: '/api/sync/j1', method: 'GET' },
      { url: `${API}/payload`, method: 'HEAD' },
    ]);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when the interim payload is not on offer yet', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: staged(2) },
      { status: 202, headers: { [SYNC_ACTIVE_HEADER]: '1' } },
      { status: 200, body: { status: 'complete', settled: true } },
    ]);
    await watchSync({ kind: 'job', jobId: 'j1' }, null, {
      apiBase: API,
      fetch,
      sleep,
      untilFirstPayload: true,
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'HEAD', 'GET']);
  });

  it('waits for the final payload when not asked to hand over early', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: staged(2) },
      { status: 200, body: { status: 'complete', settled: true } },
    ]);
    await watchSync({ kind: 'job', jobId: 'j1' }, null, { apiBase: API, fetch, sleep });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
  });

  it("follows the viewer's own job on its status endpoint, reporting progress", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { status: 'queued', settled: false, createdAt: T1, prsStored: 0 } },
      { status: 200, body: { status: 'running', settled: false, createdAt: T1, prsStored: 50 } },
      { status: 200, body: { status: 'complete', settled: true, prsStored: 80 } },
    ]);
    const onProgress = vi.fn();
    await watchSync({ kind: 'job', jobId: 'j1' }, null, { apiBase: API, fetch, sleep, onProgress });
    expect(calls.map((c) => c.url)).toEqual(['/api/sync/j1', '/api/sync/j1', '/api/sync/j1']);
    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
      {
        phase: 'queued',
        prsStored: 0,
        startedAt: T1,
        label: null,
        fraction: null,
        workflowStatus: null,
        stageLabel: null,
        interim: false,
      },
      {
        phase: 'running',
        prsStored: 50,
        startedAt: T1,
        label: null,
        fraction: null,
        workflowStatus: null,
        stageLabel: null,
        interim: false,
      },
    ]);
  });

  it("watches someone else's sync on the payload endpoint only", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        headers: { [SYNCED_AT_HEADER]: T1, [SYNC_ACTIVE_HEADER]: '1', [PRS_STORED_HEADER]: '9' },
      },
      { status: 200, headers: { [SYNCED_AT_HEADER]: T2, [SYNC_ACTIVE_HEADER]: '0' } },
    ]);
    const onProgress = vi.fn();
    await watchSync({ kind: 'payload', baseline: T1 }, T1, {
      apiBase: API,
      fetch,
      sleep,
      onProgress,
    });
    expect(calls).toEqual([
      { url: `${API}/payload`, method: 'HEAD' },
      { url: `${API}/payload`, method: 'HEAD' },
    ]);
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'active',
      prsStored: 9,
      startedAt: null,
      label: null,
      fraction: null,
      workflowStatus: null,
      stageLabel: null,
      interim: false,
    });
  });

  it('falls back to the payload when the job is not readable', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 404, body: { message: 'unknown job' } },
      { status: 202, headers: { [SYNC_ACTIVE_HEADER]: '1' } },
      { status: 200, headers: { [SYNCED_AT_HEADER]: T2, [SYNC_ACTIVE_HEADER]: '0' } },
    ]);
    await watchSync({ kind: 'job', jobId: 'theirs' }, null, { apiBase: API, fetch, sleep });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/sync/theirs',
      `HEAD ${API}/payload`,
      `HEAD ${API}/payload`,
    ]);
  });

  it('rejects with the job error when the sync failed', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { status: 'errored', settled: false, error: 'rate limited' } },
    ]);
    const error = await watchSync({ kind: 'job', jobId: 'j1' }, null, {
      apiBase: API,
      fetch,
      sleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncWatchError);
    expect((error as SyncWatchError).kind).toBe('failed');
    expect((error as SyncWatchError).message).toBe('The sync stopped: rate limited.');
  });

  it('rejects as stopped when nothing runs and nothing new was published', async () => {
    const { fetch } = fakeFetch([
      { status: 200, headers: { [SYNCED_AT_HEADER]: T1, [SYNC_ACTIVE_HEADER]: '0' } },
    ]);
    const error = await watchSync({ kind: 'payload', baseline: T1 }, T1, {
      apiBase: API,
      fetch,
      sleep,
    }).catch((e: unknown) => e);
    expect((error as SyncWatchError).kind).toBe('stopped');
    expect((error as SyncWatchError).message).toBe(STOPPED_MESSAGE);
  });
});

describe('watchSync through an outage', () => {
  const running = { status: 200, body: { status: 'running', settled: false } };
  const done = { status: 200, body: { status: 'complete', settled: true } };
  const down = { status: 503 };
  const job = { kind: 'job', jobId: 'j1' } as const;

  it('keeps following a sync while its status briefly cannot be read', async () => {
    const { fetch, calls } = fakeFetch([running, down, { status: 502 }, { status: 429 }, done]);
    await watchSync(job, null, { apiBase: API, fetch, sleep });
    expect(calls).toHaveLength(5);
  });

  it('does the same for the payload endpoint and for a request that never got an answer', async () => {
    const answers: Answer[] = [
      { status: 200, headers: { [SYNCED_AT_HEADER]: T1, [SYNC_ACTIVE_HEADER]: '1' } },
      down,
      { status: 200, headers: { [SYNCED_AT_HEADER]: T2, [SYNC_ACTIVE_HEADER]: '0' } },
    ];
    let offline = true;
    const fetch = vi.fn(async () => {
      // The first request is lost; the rest are answered from the queue.
      if (offline) {
        offline = false;
        throw new TypeError('Failed to fetch');
      }
      const next = answers.shift();
      if (!next) throw new Error('unexpected call');
      return new Response(null, { status: next.status, headers: next.headers ?? {} });
    });
    await watchSync({ kind: 'payload', baseline: T1 }, T1, { apiBase: API, fetch, sleep });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('gives up once the status has been unreadable for too long, saying which status', async () => {
    const { fetch, calls } = fakeFetch([running, ...times(RETRY_LIMIT + 1, down)]);
    const error = await watchSync(job, null, { apiBase: API, fetch, sleep }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SyncWatchError);
    expect((error as SyncWatchError).kind).toBe('failed');
    expect((error as SyncWatchError).message).toBe('Could not read job status (503).');
    expect(calls).toHaveLength(RETRY_LIMIT + 2);
  });

  it('says it lost contact when no request gets through', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await watchSync(job, null, { apiBase: API, fetch, sleep }).catch(
      (e: unknown) => e,
    );
    expect((error as SyncWatchError).message).toBe(UNREACHABLE_MESSAGE);
    expect(fetch).toHaveBeenCalledTimes(RETRY_LIMIT + 1);
  });

  it('counts only failures in a row: one good answer starts the count again', async () => {
    const { fetch } = fakeFetch([
      ...times(RETRY_LIMIT, down),
      running,
      ...times(RETRY_LIMIT, down),
      done,
    ]);
    await expect(watchSync(job, null, { apiBase: API, fetch, sleep })).resolves.toBeUndefined();
  });

  it('still fails at once on an answer that will not pass', async () => {
    const { fetch, calls } = fakeFetch([{ status: 401 }]);
    const error = await watchSync(job, null, { apiBase: API, fetch, sleep }).catch(
      (e: unknown) => e,
    );
    expect((error as SyncWatchError).message).toBe('Could not read job status (401).');
    expect(calls).toHaveLength(1);
  });
});

describe('watchSync following the live status', () => {
  it('probes again as soon as the model reports a change, and closes the stream after', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { status: 'running', settled: false, prsStored: 10 } },
      { status: 200, body: { status: 'complete', settled: true, prsStored: 40 } },
    ]);
    const listeners: Record<string, (() => void)[]> = {};
    let closed = false;
    const urls: string[] = [];
    // The timer never fires: only a live event can end the wait.
    const watching = watchSync({ kind: 'job', jobId: 'j1' }, null, {
      apiBase: API,
      fetch,
      live: {
        connect: (url) => {
          urls.push(url);
          return {
            addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
            close: () => {
              closed = true;
            },
          };
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
    });
    listeners.open?.forEach((l) => l());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    listeners.message?.forEach((l) => l());
    await watching;
    expect(urls).toEqual([`${API}/live`]);
    expect(calls).toHaveLength(2);
    expect(closed).toBe(true);
  });

  it('never opens the stream when a sleep is given', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { status: 'complete', settled: true } }]);
    const connect = vi.fn();
    await watchSync({ kind: 'job', jobId: 'j1' }, null, {
      apiBase: API,
      fetch,
      sleep,
      live: { connect },
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
