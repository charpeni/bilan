import { beforeEach, expect, it, vi } from 'vitest';

import { SWITCHER_LIMIT } from './repo-switcher.ts';

const mocks = vi.hoisted(() => ({
  listRepoViews: vi.fn(),
  checkRepoAccess: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('@bilan/store-d1', () => ({ listRepoViews: mocks.listRepoViews }));
vi.mock('./db.ts', () => ({ getDb: () => ({}) }));
vi.mock('./access.ts', () => ({ accessDeps: () => ({}), checkRepoAccess: mocks.checkRepoAccess }));

import { GET } from '../pages/api/repositories.ts';

const request = (user: { id: number } | null = { id: 7 }) =>
  GET({ locals: { user } } as unknown as Parameters<typeof GET>[0]);

const view = (n: number, isPrivate = false) => ({
  repoId: `R_${n}`,
  owner: 'acme',
  name: `repo-${n}`,
  isPrivate,
  lastViewedAt: `2026-09-${String(30 - n).padStart(2, '0')}T00:00:00Z`,
  lastSyncedAt: '2026-09-01T00:00:00Z',
  coverageSince: null,
  syncStartedAt: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkRepoAccess.mockResolvedValue({ kind: 'ok' });
});

it('asks a signed-out viewer to sign in without reading anything', async () => {
  const response = await request(null);
  expect(response.status).toBe(401);
  expect(mocks.listRepoViews).not.toHaveBeenCalled();
});

it('lists the repositories the viewer may still see, most recent first', async () => {
  mocks.listRepoViews.mockResolvedValue([view(1), view(2, true), view(3)]);
  mocks.checkRepoAccess.mockImplementation(async (_deps, _user, repo: { id: string }) =>
    repo.id === 'R_3' ? { kind: 'not-found' } : { kind: 'ok' },
  );
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    repositories: [
      { owner: 'acme', name: 'repo-1', isPrivate: false, lastViewedAt: '2026-09-29T00:00:00Z' },
      { owner: 'acme', name: 'repo-2', isPrivate: true, lastViewedAt: '2026-09-28T00:00:00Z' },
    ],
  });
  expect(mocks.listRepoViews).toHaveBeenCalledWith({}, 7);
  expect(mocks.checkRepoAccess).toHaveBeenCalledWith(
    {},
    { id: 7 },
    { id: 'R_2', owner: 'acme', name: 'repo-2', isPrivate: true },
  );
});

it(`checks only the ${SWITCHER_LIMIT} most recent repositories`, async () => {
  mocks.listRepoViews.mockResolvedValue(
    Array.from({ length: SWITCHER_LIMIT + 5 }, (_, i) => view(i + 1)),
  );
  const body = (await (await request()).json()) as { repositories: unknown[] };
  expect(body.repositories).toHaveLength(SWITCHER_LIMIT);
  expect(mocks.checkRepoAccess).toHaveBeenCalledTimes(SWITCHER_LIMIT);
});
