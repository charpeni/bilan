import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Oauth from './oauth.ts';

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  viewer: vi.fn(),
  createSession: vi.fn(),
  upsertUser: vi.fn(),
  tokenKey: vi.fn(),
  storeUserToken: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('@bilan/core', () => ({
  GithubClient: class {
    viewer = mocks.viewer;
  },
}));
vi.mock('@bilan/store-d1', () => ({
  createSession: mocks.createSession,
  upsertUser: mocks.upsertUser,
}));
vi.mock('./db.ts', () => ({ getDb: () => ({}) }));
vi.mock('./tokens.ts', () => ({ tokenKey: mocks.tokenKey, storeUserToken: mocks.storeUserToken }));
vi.mock('./oauth.ts', async (original) => ({
  ...(await original<typeof Oauth>()),
  githubProvider: () => ({ validateAuthorizationCode: mocks.exchange }),
}));

import { GET } from '../pages/auth/github/callback.ts';

function callback(query: string, stored?: { state: string; next: string }) {
  const cookies = {
    get: () => (stored ? { value: JSON.stringify(stored) } : undefined),
    delete: vi.fn(),
    set: vi.fn(),
  };
  const result = GET({
    url: new URL(`https://bilan.test/auth/github/callback?${query}`),
    cookies,
    redirect: (location: string, status: number) =>
      new Response(null, { status, headers: { location } }),
  } as unknown as Parameters<typeof GET>[0]);
  return { cookies, result };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.exchange.mockResolvedValue({ data: {}, accessToken: () => 'fixture-token' });
  mocks.viewer.mockResolvedValue({ databaseId: 7, login: 'viewer', avatarUrl: null });
});

describe('OAuth callback browser binding', () => {
  it.each([undefined, { state: 'victim-state', next: '/repositories' }])(
    'discards an attacker installation code without exchanging it or setting a session',
    async (stored) => {
      const { cookies, result } = callback(
        'code=attacker-code&setup_action=&installation_id=',
        stored,
      );
      const response = await result;
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/auth/github/start?next=%2Frepositories');
      expect(mocks.exchange).not.toHaveBeenCalled();
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(mocks.storeUserToken).not.toHaveBeenCalled();
      expect(cookies.set).not.toHaveBeenCalled();
    },
  );

  it('rejects a mismatched state even when installation flags are supplied', async () => {
    const { result, cookies } = callback(
      'code=attacker&state=wrong&setup_action=install&installation_id=1',
      {
        state: 'browser-state',
        next: '/repositories',
      },
    );
    expect((await result).status).toBe(400);
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('exchanges a browser-bound code and issues a new session', async () => {
    const { result, cookies } = callback('code=real-code&state=browser-state', {
      state: 'browser-state',
      next: '/acme/repo',
    });
    const response = await result;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/acme/repo');
    expect(mocks.exchange).toHaveBeenCalledWith('real-code');
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(cookies.set).toHaveBeenCalledWith(
      'bilan_session',
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    );
  });
});
