import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Store from '@bilan/store-d1';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  touch: vi.fn(),
  upsert: vi.fn(),
  active: vi.fn(),
  domain: vi.fn(),
}));

vi.mock('@bilan/store-d1', async (original) => ({
  ...(await original<typeof Store>()),
  admitSyncJob: mocks.admit,
  touchRepoView: mocks.touch,
  upsertRepo: mocks.upsert,
}));
vi.mock('./db.ts', () => ({ getDb: () => fakeDb() }));

import { startSync, SyncAlreadyRunningError, SyncRateLimitedError } from './jobs.ts';

import type { StartSyncOptions } from './jobs.ts';
import type { Db } from '@bilan/store-d1';

function fakeDb(): Db {
  return {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ get: mocks.active }) }) }),
    }),
  } as unknown as Db;
}

/** bilan-domain behind the `DOMAIN` binding: answers each path with `replies[path]`, else ok. */
function domain(replies: Record<string, { status: number; body: unknown }> = {}) {
  mocks.domain.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    const reply = replies[path] ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
}
/** The paths bilan-domain was called on, in order, with their bodies. */
const domainCalls = () =>
  mocks.domain.mock.calls.map((call) => {
    const [url, init] = call as [string, RequestInit];
    return {
      path: new URL(url).pathname,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    };
  });
const paths = () => domainCalls().map((call) => call.path);

const env = { DOMAIN: { fetch: mocks.domain } } as unknown as Env;
const ref = { owner: 'acme', name: 'private' };
const options: StartSyncOptions = {
  requestedBy: 7,
  source: {
    source: 'user',
    userId: 7,
    meta: {
      id: 'R_private',
      isPrivate: true,
      viewerPermission: 'READ',
      pullRequests: { totalCount: 1 },
    },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  domain();
  mocks.active.mockResolvedValue(undefined);
  mocks.admit.mockResolvedValue(true);
  mocks.upsert.mockResolvedValue({ id: 'R_private', lastSyncedAt: null, coverageSince: null });
});

describe('starting a sync', () => {
  it('asks the model, admits against the quotas, then has the model start the run', async () => {
    const started = await startSync(env, ref, options);
    expect(paths()).toEqual(['/sync/request', '/sync/admit']);
    const [request, admitted] = domainCalls().map((call) => call.body);
    expect(request).toEqual({
      repoId: 'R_private',
      jobId: started.jobId,
      requestedBy: 7,
      // No name: the model's history outlives the repository's retention.
      run: {
        mode: 'incremental',
        depth: '30d',
        since: started.since,
        maxPrs: null,
        tokenSource: { _tag: 'User', userId: 7 },
      },
    });
    expect(admitted).toEqual({ repoId: 'R_private', jobId: started.jobId });
    expect(mocks.admit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: started.jobId, repoId: 'R_private', requestedBy: 7 }),
    );
    // Admission is checked in D1 between the two calls.
    expect(mocks.admit.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.domain.mock.invocationCallOrder[0]!,
    );
    expect(mocks.admit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.domain.mock.invocationCallOrder[1]!,
    );
  });

  it('reports the run the model says is current, without touching the quotas', async () => {
    domain({
      '/sync/request': {
        status: 409,
        body: { ok: false, rejected: 'SyncAlreadyRunning', jobId: 'running-job' },
      },
    });
    const error = await startSync(env, ref, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncAlreadyRunningError);
    expect((error as SyncAlreadyRunningError).jobId).toBe('running-job');
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(paths()).toEqual(['/sync/request']);
  });

  it('releases the repository when the quotas refuse, and never starts the run', async () => {
    mocks.admit.mockResolvedValue(false);
    await expect(startSync(env, ref, options)).rejects.toBeInstanceOf(SyncRateLimitedError);
    const [request, release] = domainCalls();
    expect(release?.path).toBe('/sync/release');
    expect(release?.body).toEqual({
      repoId: 'R_private',
      jobId: request?.body.jobId,
      reason: 'quota',
    });
    expect(domainCalls()).toHaveLength(2);
  });

  it('reports a run sync_jobs still lists as active after releasing', async () => {
    mocks.admit.mockResolvedValue(false);
    mocks.active.mockResolvedValue({ id: 'ending-job' });
    await expect(startSync(env, ref, options)).rejects.toMatchObject({ jobId: 'ending-job' });
    expect(paths()).toEqual(['/sync/request', '/sync/release']);
  });

  it('runs on the server token when that is the source', async () => {
    const server = { ...options.source, source: 'server' } as NonNullable<
      StartSyncOptions['source']
    >;
    await startSync(env, ref, { requestedBy: 7, source: server });
    expect(domainCalls()[0]?.body).toMatchObject({ run: { tokenSource: { _tag: 'Server' } } });
  });

  it('fails without admitting when the model cannot be reached', async () => {
    domain({ '/sync/request': { status: 500, body: { error: 'down' } } });
    await expect(startSync(env, ref, options)).rejects.toThrow(/bilan-domain \/sync\/request/);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it('fails when the request expired before it could be admitted', async () => {
    domain({
      '/sync/admit': { status: 409, body: { ok: false, rejected: 'NotCurrentJob', current: null } },
    });
    await expect(startSync(env, ref, options)).rejects.toThrow(/expired/);
  });
});
