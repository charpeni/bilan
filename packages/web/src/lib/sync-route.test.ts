import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ startSync: vi.fn(), checkRepoAccess: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('@bilan/store-d1', () => ({ getRepoByName: () => Promise.resolve(undefined) }));
vi.mock('./db.ts', () => ({ getDb: () => ({}) }));
vi.mock('./access.ts', () => ({ accessDeps: () => ({}), checkRepoAccess: mocks.checkRepoAccess }));
vi.mock('./jobs.ts', () => ({
  startSync: mocks.startSync,
  SyncAlreadyRunningError: class extends Error {},
  SyncRateLimitedError: class extends Error {},
}));

import { POST } from '../pages/api/repos/[owner]/[name]/sync.ts';

function post(): Promise<Response> {
  return Promise.resolve(
    POST({
      params: { owner: 'acme', name: 'widgets' },
      request: new Request('https://bilan.test/api/repos/acme/widgets/sync', { method: 'POST' }),
      locals: { user: { id: 7, login: 'viewer', avatarUrl: null } },
    } as unknown as Parameters<typeof POST>[0]),
  );
}

describe('POST /api/repos/:owner/:name/sync', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkRepoAccess.mockResolvedValue({ kind: 'unknown', source: { source: 'server' } });
  });

  it('answers 202 with the job it started', async () => {
    mocks.startSync.mockResolvedValue({ jobId: 'job-1', repoId: 'R_1', depth: '30d' });
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: 'job-1', depth: '30d', since: null });
  });

  it('logs an unexpected failure and tells the client nothing of it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('bilan-domain /sync/request answered 500: SQLITE_ERROR near "R_kgDO"');
    mocks.startSync.mockRejectedValue(cause);
    const response = await post();
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      message: 'The sync could not start. Try again in a moment.',
    });
    expect(text).not.toMatch(/bilan-domain|SQLITE|R_kgDO/);
    expect(logged).toHaveBeenCalledWith(expect.any(String), cause);
    logged.mockRestore();
  });
});
