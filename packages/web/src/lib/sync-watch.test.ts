import { describe, expect, it, vi } from 'vitest';

import { PRS_STORED_HEADER, SYNC_ACTIVE_HEADER, SYNCED_AT_HEADER } from './poll.ts';
import { STOPPED_MESSAGE, SyncWatchError, watchSync } from './sync-watch.ts';

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

describe('watchSync', () => {
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
      { phase: 'queued', prsStored: 0, startedAt: T1 },
      { phase: 'running', prsStored: 50, startedAt: T1 },
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
    expect(onProgress).toHaveBeenCalledWith({ phase: 'active', prsStored: 9, startedAt: null });
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
    expect((error as SyncWatchError).message).toBe('Sync failed: rate limited');
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
