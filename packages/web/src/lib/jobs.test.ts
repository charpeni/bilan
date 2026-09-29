import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Store from '@bilan/store-d1';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  touch: vi.fn(),
  upsert: vi.fn(),
  active: vi.fn(),
  stale: vi.fn(),
  update: vi.fn(),
  status: vi.fn(),
  terminate: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@bilan/store-d1', async (original) => ({
  ...(await original<typeof Store>()),
  admitSyncJob: mocks.admit,
  touchRepoView: mocks.touch,
  upsertRepo: mocks.upsert,
}));
vi.mock('./db.ts', () => ({ getDb: () => fakeDb() }));

import { DISPATCH_GRACE_MS, STALL_AFTER_MS } from './job-reconcile.ts';
import {
  instanceStatus,
  reconcileJob,
  startSync,
  SyncAlreadyRunningError,
  SyncRateLimitedError,
} from './jobs.ts';

import type { StartSyncOptions } from './jobs.ts';
import type { Db, SyncJob } from '@bilan/store-d1';

function fakeDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ get: mocks.active }),
          limit: () => ({ all: mocks.stale }),
        }),
      }),
    }),
    update: () => ({ set: (values: unknown) => ({ where: () => mocks.update(values) }) }),
  } as unknown as Db;
}
const env = {
  SYNC_REPO: {
    get: async () => ({ status: mocks.status, terminate: mocks.terminate }),
    create: mocks.create,
  },
} as unknown as Env;
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
const job = (age: number, status = 'queued'): SyncJob => ({
  id: 'reserved-job',
  repoId: 'R_private',
  requestedBy: 7,
  mode: 'incremental',
  maxPrs: null,
  status,
  pointsSpent: 0,
  error: null,
  createdAt: new Date(Date.now() - age).toISOString(),
  progressAt: null,
  finishedAt: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.stale.mockResolvedValue([]);
  mocks.active.mockResolvedValue(undefined);
  mocks.admit.mockResolvedValue(true);
  mocks.upsert.mockResolvedValue({ id: 'R_private', lastSyncedAt: null, coverageSince: null });
  mocks.status.mockResolvedValue({ status: 'running' });
});

describe('sync reservation and dispatch', () => {
  it('does not dispatch a workflow if the atomic reservation is refused', async () => {
    mocks.admit.mockResolvedValue(false);
    await expect(startSync(env, ref, options)).rejects.toBeInstanceOf(SyncRateLimitedError);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('reports a concurrent reservation as already running without dispatching again', async () => {
    mocks.admit.mockResolvedValue(false);
    mocks.active.mockResolvedValueOnce(undefined).mockResolvedValueOnce(job(0));
    await expect(startSync(env, ref, options)).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps a reservation when the workflow creation response is lost', async () => {
    mocks.create.mockRejectedValue(new Error('response lost'));
    await expect(startSync(env, ref, options)).rejects.toThrow('response lost');
    expect(mocks.admit).toHaveBeenCalledOnce();
    expect(mocks.touch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repoId: 'R_private',
        userId: 7,
      }),
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not release a new reservation before dispatch reaches the engine', async () => {
    mocks.active.mockResolvedValue(job(0));
    mocks.status.mockRejectedValue(new Error('(instance.not_found) Instance does not exist'));
    await expect(startSync(env, ref, options)).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('recovers a failed dispatch after the grace period', async () => {
    mocks.status.mockRejectedValue(new Error('(instance.not_found) Instance does not exist'));
    expect(await reconcileJob(env, fakeDb(), job(DISPATCH_GRACE_MS + 1000))).toBeUndefined();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'errored' }));
  });

  it('keeps the lease when workflow status cannot be read', async () => {
    mocks.status.mockRejectedValue(new Error('temporary network failure'));
    expect(await instanceStatus(env, 'reserved-job')).toBe('unknown');
    const reserved = job(STALL_AFTER_MS * 2);
    expect(await reconcileJob(env, fakeDb(), reserved)).toBe(reserved);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('terminates a stalled instance before releasing its reservation', async () => {
    await reconcileJob(env, fakeDb(), job(STALL_AFTER_MS + 1000, 'running'));
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.update.mock.invocationCallOrder[0]!,
    );
  });

  it('retains a stalled reservation if the engine cannot stop it', async () => {
    mocks.terminate.mockRejectedValue(new Error('cannot terminate'));
    const reserved = job(STALL_AFTER_MS + 1000, 'running');
    expect(await reconcileJob(env, fakeDb(), reserved)).toBe(reserved);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
