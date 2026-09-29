import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRepoById: vi.fn(),
  checkRepoAccess: vi.fn(),
  getJob: vi.fn(),
  countStoredPrs: vi.fn(),
  reconcileJob: vi.fn(),
  workflow: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: { SYNC_REPO: { get: mocks.workflow } } }));
vi.mock('@bilan/store-d1', () => ({ getRepoById: mocks.getRepoById }));
vi.mock('./db.ts', () => ({ getDb: () => ({}) }));
vi.mock('./access.ts', () => ({ accessDeps: () => ({}), checkRepoAccess: mocks.checkRepoAccess }));
vi.mock('./jobs.ts', () => ({
  getJob: mocks.getJob,
  countStoredPrs: mocks.countStoredPrs,
  reconcileJob: mocks.reconcileJob,
}));

import { GET } from '../pages/api/sync/[id].ts';

const request = (user: { id: number } | null = { id: 7 }) =>
  GET({ params: { id: 'old-job' }, locals: { user } } as unknown as Parameters<typeof GET>[0]);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getJob.mockResolvedValue({
    id: 'old-job',
    repoId: 'R_private',
    requestedBy: 7,
    status: 'complete',
    mode: 'incremental',
    createdAt: '2026-01-01T00:00:00Z',
  });
  mocks.getRepoById.mockResolvedValue({
    id: 'R_private',
    owner: 'acme',
    name: 'private',
    isPrivate: true,
    totalPrs: 1200,
    lastSyncedAt: '2026-09-29T00:00:00Z',
    syncStartedAt: null,
  });
  mocks.checkRepoAccess.mockResolvedValue({ kind: 'ok' });
  mocks.countStoredPrs.mockResolvedValue(1200);
  mocks.workflow.mockResolvedValue({ status: async () => ({ status: 'complete' }) });
});

describe('job progress authorization', () => {
  it('rechecks repository access for a completed job before reading live counts', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ prsStored: 1200 });
    expect(mocks.checkRepoAccess).toHaveBeenCalledWith(
      {},
      { id: 7 },
      expect.objectContaining({ id: 'R_private' }),
    );
  });

  it.each(['not-found', 'replaced', 'unknown'])(
    'hides an owned job when repo access is %s',
    async (kind) => {
      mocks.checkRepoAccess.mockResolvedValue({ kind });
      const response = await request();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: 'unknown job' });
      expect(mocks.countStoredPrs).not.toHaveBeenCalled();
      expect(mocks.workflow).not.toHaveBeenCalled();
      expect(mocks.reconcileJob).not.toHaveBeenCalled();
    },
  );

  it('fails closed when GitHub cannot check an owned job', async () => {
    mocks.checkRepoAccess.mockResolvedValue({ kind: 'unavailable' });
    expect((await request()).status).toBe(503);
    expect(mocks.countStoredPrs).not.toHaveBeenCalled();
  });

  it('does not probe repository access for another user or an unknown job', async () => {
    const other = await request({ id: 8 });
    mocks.getJob.mockResolvedValue(undefined);
    const absent = await request();
    expect(other.status).toBe(404);
    expect(await other.text()).toBe(await absent.text());
    expect(mocks.getRepoById).not.toHaveBeenCalled();
    expect(mocks.checkRepoAccess).not.toHaveBeenCalled();
  });

  it('requires a session before reading any job row', async () => {
    expect((await request(null)).status).toBe(401);
    expect(mocks.getJob).not.toHaveBeenCalled();
  });
});
