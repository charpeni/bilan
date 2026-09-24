import { GithubError, RepoNotFoundError } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import {
  freshUserGrant,
  freshUserToken,
  GithubUnavailableError,
  isBadCredentials,
  isExpiring,
  ReauthRequiredError,
  REFRESH_AHEAD_MS,
  RefreshRejectedError,
  withUserToken,
} from './tokens.ts';

import type { TokenGrant } from './oauth.ts';
import type { RemoveMatch, StoredGrant, TokenDeps } from './tokens.ts';

const T0 = Date.parse('2026-05-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;

/** The fake store "encrypts" with the identity, so the ciphertexts are the tokens themselves. */
const asStored = (grant: TokenGrant): StoredGrant => ({
  ...grant,
  encrypted: { accessToken: grant.accessToken, refreshToken: grant.refreshToken },
});

interface Fake extends TokenDeps {
  rows: Map<number, TokenGrant>;
  refreshCalls: string[];
  loads: number;
  /** Every conditional delete asked for, whether or not it matched a row. */
  removes: { match: RemoveMatch; token: string | null }[];
  clock: { now: number };
  /** Runs right after a `load` returns, before the caller acts on it. */
  afterLoad?: () => void;
}

function setup(options: {
  stored?: TokenGrant | null;
  refresh?: TokenGrant | Error | ((refreshToken: string) => Promise<TokenGrant>);
  now?: number;
}): Fake {
  const rows = new Map<number, TokenGrant>();
  if (options.stored) rows.set(7, options.stored);
  const clock = { now: options.now ?? T0 };
  const refreshCalls: string[] = [];
  const fake: Fake = {
    rows,
    refreshCalls,
    loads: 0,
    removes: [],
    clock,
    load: async (userId) => {
      fake.loads++;
      const row = rows.get(userId);
      const stored = row === undefined ? null : asStored(row);
      fake.afterLoad?.();
      return stored;
    },
    save: async (userId, grant) => {
      rows.set(userId, grant);
      return asStored(grant);
    },
    // `DELETE ... WHERE user_id = ? AND encrypted_token = ?`: the row goes only
    // while it still holds the token the caller read.
    remove: async (userId, stored, match) => {
      const token =
        match === 'access' ? stored.encrypted.accessToken : stored.encrypted.refreshToken;
      fake.removes.push({ match, token });
      const current = rows.get(userId);
      if (current === undefined) return;
      const held = match === 'access' ? current.accessToken : current.refreshToken;
      if (held === token) rows.delete(userId);
    },
    refresh: async (refreshToken) => {
      refreshCalls.push(refreshToken);
      const r = options.refresh;
      if (r === undefined) throw new Error('refresh not expected');
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(refreshToken);
      return r;
    },
    now: () => clock.now,
  };
  return fake;
}

const live: TokenGrant = {
  accessToken: 'ghu_live',
  refreshToken: 'ghr_1',
  expiresAt: iso(T0 + 8 * HOUR),
  refreshExpiresAt: iso(T0 + 180 * 24 * HOUR),
};
const rotated: TokenGrant = {
  accessToken: 'ghu_new',
  refreshToken: 'ghr_2',
  expiresAt: iso(T0 + 16 * HOUR),
  refreshExpiresAt: iso(T0 + 360 * 24 * HOUR),
};

describe('isExpiring', () => {
  it('is never true without an expiry, and true within the refresh window', () => {
    expect(isExpiring(null, T0)).toBe(false);
    expect(isExpiring(iso(T0 + HOUR), T0)).toBe(false);
    expect(isExpiring(iso(T0 + REFRESH_AHEAD_MS), T0)).toBe(true);
    expect(isExpiring(iso(T0 + REFRESH_AHEAD_MS + 1), T0)).toBe(false);
    expect(isExpiring(iso(T0 - 1), T0)).toBe(true);
    expect(isExpiring('garbage', T0)).toBe(true);
  });
});

describe('freshUserToken', () => {
  it('returns the stored token while it has more than five minutes left', async () => {
    const deps = setup({ stored: live });
    expect(await freshUserToken(deps, 7)).toBe('ghu_live');
    deps.clock.now = T0 + 8 * HOUR - REFRESH_AHEAD_MS - 1;
    expect(await freshUserToken(deps, 7)).toBe('ghu_live');
    expect(deps.refreshCalls).toEqual([]);
  });

  it('never refreshes a token without an expiry (app has expiry disabled)', async () => {
    const deps = setup({
      stored: { accessToken: 'ghu_x', refreshToken: null, expiresAt: null, refreshExpiresAt: null },
      now: T0 + 400 * 24 * HOUR,
    });
    expect(await freshUserToken(deps, 7)).toBe('ghu_x');
    expect(deps.refreshCalls).toEqual([]);
  });

  it('rotates the whole set through the refresh token when within five minutes of expiry', async () => {
    const deps = setup({ stored: live, refresh: rotated, now: T0 + 8 * HOUR - REFRESH_AHEAD_MS });
    expect(await freshUserToken(deps, 7)).toBe('ghu_new');
    expect(deps.refreshCalls).toEqual(['ghr_1']);
    expect(deps.rows.get(7)).toEqual(rotated);
    // The rotated set is what the next call sees; no second refresh.
    expect(await freshUserToken(deps, 7)).toBe('ghu_new');
    expect(deps.refreshCalls).toHaveLength(1);
  });

  it('also rotates when the token is already past its expiry', async () => {
    const deps = setup({ stored: live, refresh: rotated, now: T0 + 9 * HOUR });
    expect(await freshUserToken(deps, 7)).toBe('ghu_new');
  });

  it('asks for a new login when nothing is stored', async () => {
    const deps = setup({ stored: null });
    await expect(freshUserToken(deps, 7)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it('forgets an expired token that has no refresh token', async () => {
    const deps = setup({
      stored: { ...live, refreshToken: null, refreshExpiresAt: null },
      now: T0 + 9 * HOUR,
    });
    await expect(freshUserToken(deps, 7)).rejects.toThrow(/cannot be refreshed/);
    expect(deps.rows.has(7)).toBe(false);
    expect(deps.removes).toEqual([{ match: 'access', token: 'ghu_live' }]);
    expect(deps.refreshCalls).toEqual([]);
  });

  it('keeps a set that replaced the expired one between the read and the delete', async () => {
    const deps = setup({
      stored: { ...live, refreshToken: null, refreshExpiresAt: null },
      now: T0 + 9 * HOUR,
    });
    deps.afterLoad = () => deps.rows.set(7, rotated);
    await expect(freshUserToken(deps, 7)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(deps.rows.get(7)).toEqual(rotated);
  });

  it('forgets the set when the refresh token itself has expired, without calling GitHub', async () => {
    const deps = setup({ stored: live, refresh: rotated, now: T0 + 181 * 24 * HOUR });
    await expect(freshUserToken(deps, 7)).rejects.toThrow(/refresh token expired/);
    expect(deps.rows.has(7)).toBe(false);
    expect(deps.removes).toEqual([{ match: 'refresh', token: 'ghr_1' }]);
    expect(deps.refreshCalls).toEqual([]);
  });

  it('forgets the set and asks for a new login when GitHub refuses the refresh', async () => {
    const refusal = new RefreshRejectedError(
      'bad_refresh_token',
      'The refresh token passed is incorrect or expired.',
    );
    const deps = setup({ stored: live, refresh: refusal, now: T0 + 9 * HOUR });
    const error = await freshUserToken(deps, 7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect((error as ReauthRequiredError).userId).toBe(7);
    expect((error as Error).cause).toBe(refusal);
    expect(deps.rows.has(7)).toBe(false);
    // The delete is conditioned on the refused refresh token, not on a re-read.
    expect(deps.removes).toEqual([{ match: 'refresh', token: 'ghr_1' }]);
  });

  it('keeps a set rotated in between the re-read after a refusal and the delete', async () => {
    const deps = setup({
      stored: live,
      now: T0 + 9 * HOUR,
      refresh: async () => {
        throw new RefreshRejectedError('bad_refresh_token', null);
      },
    });
    // The re-read after the refusal still sees the refused set, so this request
    // decides to forget it; another request saves a rotated set right after.
    deps.afterLoad = () => {
      if (deps.loads === 2) deps.rows.set(7, rotated);
    };
    await expect(freshUserToken(deps, 7)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(deps.removes).toEqual([{ match: 'refresh', token: 'ghr_1' }]);
    expect(deps.rows.get(7)).toEqual(rotated);
  });

  it('keeps the set and reports GitHub unavailable when the refresh is inconclusive', async () => {
    for (const failure of [
      new Error('fetch failed'),
      Object.assign(new Error('unexpected status'), { status: 502 }),
      new TypeError('Failed to fetch'),
    ]) {
      const deps = setup({ stored: live, refresh: failure, now: T0 + 9 * HOUR });
      const error = await freshUserToken(deps, 7).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GithubUnavailableError);
      expect(error).not.toBeInstanceOf(ReauthRequiredError);
      expect((error as Error).cause).toBe(failure);
      expect(deps.rows.get(7)).toEqual(live);
      expect(deps.refreshCalls).toEqual(['ghr_1']);
    }
  });

  it('uses the set a concurrent refresh stored when its own refresh loses the race', async () => {
    const deps = setup({
      stored: live,
      now: T0 + 9 * HOUR,
      refresh: async () => {
        // Someone else rotated while this call was in flight; GitHub refuses the used refresh token.
        deps.rows.set(7, { ...rotated, expiresAt: iso(T0 + 17 * HOUR) });
        throw new RefreshRejectedError('bad_refresh_token', null);
      },
    });
    expect(await freshUserToken(deps, 7)).toBe('ghu_new');
    expect(deps.rows.get(7)?.refreshToken).toBe('ghr_2');
  });

  it('never deletes a set another request rotated in, even when it is unusable', async () => {
    const stale = { ...rotated, expiresAt: iso(T0 + 9 * HOUR - 1) };
    const deps = setup({
      stored: live,
      now: T0 + 9 * HOUR,
      refresh: async () => {
        deps.rows.set(7, stale);
        throw new RefreshRejectedError('bad_refresh_token', null);
      },
    });
    await expect(freshUserToken(deps, 7)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(deps.rows.get(7)).toEqual(stale);
  });

  it('does not delete when the row is already gone after a refusal', async () => {
    const deps = setup({
      stored: live,
      now: T0 + 9 * HOUR,
      refresh: async () => {
        deps.rows.delete(7);
        throw new RefreshRejectedError('bad_refresh_token', null);
      },
    });
    await expect(freshUserToken(deps, 7)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(deps.rows.has(7)).toBe(false);
  });

  it('hands back the rotated set as stored, so it can be matched by a later delete', async () => {
    const deps = setup({ stored: live, refresh: rotated, now: T0 + 9 * HOUR });
    expect(await freshUserGrant(deps, 7)).toEqual(asStored(rotated));
  });
});

describe('withUserToken', () => {
  it('hands the fresh token to the callback and passes its result through', async () => {
    const deps = setup({ stored: live });
    expect(await withUserToken(deps, 7, async (token) => `used ${token}`)).toBe('used ghu_live');
  });

  it('treats a 401 from GitHub as a dead token: forgets it and asks for a new login', async () => {
    const deps = setup({ stored: live });
    const unauthorized = new GithubError('GitHub responded 401: Bad credentials', 401, false);
    await expect(
      withUserToken(deps, 7, async () => {
        throw unauthorized;
      }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(deps.rows.has(7)).toBe(false);
    expect(deps.removes).toEqual([{ match: 'access', token: 'ghu_live' }]);
  });

  it('keeps a set that was rotated while the rejected token was in use, without re-reading', async () => {
    const deps = setup({ stored: live });
    const unauthorized = new GithubError('GitHub responded 401: Bad credentials', 401, false);
    await expect(
      withUserToken(deps, 7, async (token) => {
        expect(token).toBe('ghu_live');
        deps.rows.set(7, rotated);
        throw unauthorized;
      }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(deps.rows.get(7)).toEqual(rotated);
    // One read to get the token; the delete carries its own condition.
    expect(deps.loads).toBe(1);
    expect(deps.removes).toEqual([{ match: 'access', token: 'ghu_live' }]);
  });

  it('deletes the rotated set it ran on when GitHub rejects that one', async () => {
    const deps = setup({ stored: live, refresh: rotated, now: T0 + 9 * HOUR });
    const unauthorized = new GithubError('GitHub responded 401: Bad credentials', 401, false);
    await expect(
      withUserToken(deps, 7, async (token) => {
        expect(token).toBe('ghu_new');
        throw unauthorized;
      }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(deps.removes).toEqual([{ match: 'access', token: 'ghu_new' }]);
    expect(deps.rows.has(7)).toBe(false);
  });

  it('leaves transient GitHub failures alone and keeps the set', async () => {
    const deps = setup({ stored: live });
    const outage = new GithubError('GitHub responded 502', 502, true);
    await expect(
      withUserToken(deps, 7, async () => {
        throw outage;
      }),
    ).rejects.toBe(outage);
    expect(deps.rows.get(7)).toEqual(live);
  });

  it('lets every other failure through untouched', async () => {
    const deps = setup({ stored: live });
    const notFound = new RepoNotFoundError({ owner: 'acme', name: 'x' });
    await expect(
      withUserToken(deps, 7, async () => {
        throw notFound;
      }),
    ).rejects.toBe(notFound);
    expect(deps.rows.has(7)).toBe(true);
    expect(isBadCredentials(notFound)).toBe(false);
    expect(isBadCredentials(new GithubError('boom', 502, true))).toBe(false);
    expect(isBadCredentials(new GithubError('nope', 401, false))).toBe(true);
  });
});
