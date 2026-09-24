import { GithubError } from '@bilan/core';
import { getUserToken, schema, upsertUserToken } from '@bilan/store-d1';
import { OAuth2RequestError } from 'arctic';
import { and, eq } from 'drizzle-orm';

import { decryptToken, encryptToken, importTokenKey } from './crypto.ts';
import { getDb } from './db.ts';
import { githubProvider, tokenGrant } from './oauth.ts';

import type { Db } from './db.ts';
import type { TokenGrant } from './oauth.ts';
import type { UserToken } from '@bilan/store-d1';

/** Refresh an access token this close to (or past) its expiry, so a request never runs on a dying token. */
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;

/**
 * The viewer has no usable GitHub token any more (never stored, expired
 * without a refresh token, refresh refused, or GitHub rejected it). The
 * middleware turns this into a login redirect for pages and a 401 for APIs.
 */
export class ReauthRequiredError extends Error {
  readonly userId: number;
  constructor(userId: number, reason: string, options?: ErrorOptions) {
    super(`Sign in again: ${reason}`, options);
    this.name = 'ReauthRequiredError';
    this.userId = userId;
  }
}

/**
 * GitHub's token endpoint answered with an OAuth error (`bad_refresh_token`,
 * `invalid_grant`, ...): the stored grant is dead for good. Anything else a
 * refresh rejects with (network failure, 5xx, unreadable body) is transient
 * and must leave the stored grant alone.
 */
export class RefreshRejectedError extends Error {
  readonly code: string;
  constructor(code: string, description: string | null) {
    super(description === null ? code : `${code}: ${description}`);
    this.name = 'RefreshRejectedError';
    this.code = code;
  }
}

/**
 * GitHub could not be reached, or answered 5xx, while the viewer's token was
 * being refreshed. Nothing is decided about the viewer: the middleware turns
 * this into a 503 so the stored grant survives the outage.
 */
export class GithubUnavailableError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`GitHub is unavailable: ${reason}`, options);
    this.name = 'GithubUnavailableError';
  }
}

/**
 * A token set as the store holds it: the decrypted grant plus the ciphertexts
 * of the row, which a conditional delete matches on (see `TokenDeps.remove`).
 * Encryption uses a fresh IV per call, so the plaintext cannot be re-encrypted
 * to find the row; the ciphertexts read are the only handle on it.
 */
export interface StoredGrant extends TokenGrant {
  encrypted: { accessToken: string; refreshToken: string | null };
}

/** Which of the set's tokens a conditional delete must still find in the row. */
export type RemoveMatch = 'access' | 'refresh';

/** Everything the freshness logic touches, so it runs in plain vitest with a fake clock and refresher. */
export interface TokenDeps {
  /** Decrypted token set of a user, or null when none is stored. */
  load(userId: number): Promise<StoredGrant | null>;
  /** Persist a rotated set; returns it as stored, so it can be matched later. */
  save(userId: number, grant: TokenGrant): Promise<StoredGrant>;
  /**
   * Forget the set, but only while the row still holds the access token
   * (`'access'`) or refresh token (`'refresh'`) of `stored`: a single
   * conditional statement, never a read followed by a delete, so a set another
   * request rotated in meanwhile survives whatever this one decided.
   */
  remove(userId: number, stored: StoredGrant, match: RemoveMatch): Promise<void>;
  /**
   * `POST /login/oauth/access_token` with `grant_type=refresh_token`. Rejects
   * with `RefreshRejectedError` when GitHub refuses the grant, and with
   * anything else when the answer is inconclusive.
   */
  refresh(refreshToken: string): Promise<TokenGrant>;
  now(): number;
}

export function isExpiring(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return false;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at - now <= REFRESH_AHEAD_MS;
}

/**
 * A usable access token for `userId`: the stored one while it has more than
 * `REFRESH_AHEAD_MS` left, otherwise a rotated one from the refresh token
 * (persisted before it is returned). A grant GitHub definitively refuses is
 * forgotten and reported as `ReauthRequiredError`; an inconclusive refresh
 * (network, 5xx) is reported as `GithubUnavailableError` and the grant kept.
 */
export async function freshUserToken(deps: TokenDeps, userId: number): Promise<string> {
  return (await freshUserGrant(deps, userId)).accessToken;
}

/** `freshUserToken` with the whole stored set, so a later delete can be conditioned on it. */
export async function freshUserGrant(deps: TokenDeps, userId: number): Promise<StoredGrant> {
  const stored = await deps.load(userId);
  if (!stored) throw new ReauthRequiredError(userId, 'no GitHub token is stored');
  const now = deps.now();
  if (!isExpiring(stored.expiresAt, now)) return stored;

  if (stored.refreshToken === null) {
    await deps.remove(userId, stored, 'access');
    throw new ReauthRequiredError(userId, 'the GitHub token expired and cannot be refreshed');
  }
  if (stored.refreshExpiresAt !== null && Date.parse(stored.refreshExpiresAt) <= now) {
    await deps.remove(userId, stored, 'refresh');
    throw new ReauthRequiredError(userId, 'the GitHub refresh token expired');
  }

  let next: TokenGrant;
  try {
    next = await deps.refresh(stored.refreshToken);
  } catch (error) {
    // Refresh tokens are single-use: when a sync step and a page view refresh at
    // the same time, the loser is refused but the winner's rotated set is stored.
    const current = await deps.load(userId);
    if (current && current.refreshToken !== stored.refreshToken) {
      if (!isExpiring(current.expiresAt, deps.now())) return current;
      throw new ReauthRequiredError(userId, 'the GitHub token was rotated and expired again', {
        cause: error,
      });
    }
    if (!(error instanceof RefreshRejectedError)) {
      throw new GithubUnavailableError('the token could not be refreshed', { cause: error });
    }
    // Only the grant that was refused is forgotten: the delete matches the
    // refused refresh token, so a set rotated in since the read above survives.
    await deps.remove(userId, stored, 'refresh');
    throw new ReauthRequiredError(userId, 'GitHub refused to refresh the token', { cause: error });
  }
  return deps.save(userId, next);
}

/** GitHub's answer to a token it no longer honours (revoked, app uninstalled by the user, or rotated away). */
export function isBadCredentials(error: unknown): boolean {
  return error instanceof GithubError && error.status === 401;
}

/**
 * Run `fn` on a fresh token of `userId`. A 401 from GitHub means the token is
 * dead whatever its expiry says: forget it (only while it is still the stored
 * one, so a set rotated by a concurrent request survives) and ask for a new login.
 */
export async function withUserToken<T>(
  deps: TokenDeps,
  userId: number,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const grant = await freshUserGrant(deps, userId);
  try {
    return await fn(grant.accessToken);
  } catch (error) {
    if (!isBadCredentials(error)) throw error;
    await deps.remove(userId, grant, 'access');
    throw new ReauthRequiredError(userId, 'GitHub rejected the stored token', { cause: error });
  }
}

export type TokenEnv = Pick<
  Env,
  'DB' | 'TOKEN_ENCRYPTION_KEY' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'
>;

export function tokenKey(env: Pick<Env, 'TOKEN_ENCRYPTION_KEY'>): Promise<CryptoKey> {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  return importTokenKey(env.TOKEN_ENCRYPTION_KEY);
}

/** Encrypt and store a token set; shared by the login callback and the refresh path. */
export async function storeUserToken(
  env: Pick<Env, 'DB' | 'TOKEN_ENCRYPTION_KEY'>,
  userId: number,
  grant: TokenGrant,
  now: string = new Date().toISOString(),
): Promise<UserToken> {
  const key = await tokenKey(env);
  return upsertUserToken(getDb(env), {
    userId,
    encryptedToken: await encryptToken(key, grant.accessToken),
    encryptedRefreshToken:
      grant.refreshToken === null ? null : await encryptToken(key, grant.refreshToken),
    expiresAt: grant.expiresAt,
    refreshExpiresAt: grant.refreshExpiresAt,
    now,
  });
}

/**
 * `DELETE FROM user_tokens WHERE user_id = ? AND encrypted_token = ?` (or
 * `encrypted_refresh_token = ?`): one statement, so the row goes only while it
 * still holds the token `stored` was read with.
 */
export async function deleteStoredToken(
  db: Db,
  userId: number,
  stored: StoredGrant,
  match: RemoveMatch,
): Promise<void> {
  const { userTokens } = schema;
  let holds;
  if (match === 'access') {
    holds = eq(userTokens.encryptedToken, stored.encrypted.accessToken);
  } else {
    // No refresh token stored means no refusal can have been about this row.
    if (stored.encrypted.refreshToken === null) return;
    holds = eq(userTokens.encryptedRefreshToken, stored.encrypted.refreshToken);
  }
  await db.delete(userTokens).where(and(eq(userTokens.userId, userId), holds));
}

export function tokenDeps(env: TokenEnv): TokenDeps {
  return {
    load: async (userId) => {
      const row = await getUserToken(getDb(env), userId);
      if (!row) return null;
      const key = await tokenKey(env);
      return {
        accessToken: await decryptToken(key, row.encryptedToken),
        refreshToken:
          row.encryptedRefreshToken === null
            ? null
            : await decryptToken(key, row.encryptedRefreshToken),
        expiresAt: row.expiresAt,
        refreshExpiresAt: row.refreshExpiresAt,
        encrypted: { accessToken: row.encryptedToken, refreshToken: row.encryptedRefreshToken },
      };
    },
    save: async (userId, grant) => {
      const row = await storeUserToken(env, userId, grant);
      return {
        ...grant,
        encrypted: { accessToken: row.encryptedToken, refreshToken: row.encryptedRefreshToken },
      };
    },
    remove: (userId, stored, match) => deleteStoredToken(getDb(env), userId, stored, match),
    // The redirect URI is only used by the authorization-code exchange, not by a refresh.
    refresh: async (refreshToken) => {
      try {
        return tokenGrant(await githubProvider(env, null).refreshAccessToken(refreshToken));
      } catch (error) {
        // arctic: `OAuth2RequestError` is GitHub's own verdict; its fetch,
        // unexpected-status, and unreadable-body errors are all inconclusive.
        if (error instanceof OAuth2RequestError) {
          throw new RefreshRejectedError(error.code, error.description);
        }
        throw error;
      }
    },
    now: () => Date.now(),
  };
}

/** A usable GitHub token of the user, refreshed if needed; throws `ReauthRequiredError` otherwise. */
export function getFreshUserToken(env: TokenEnv, userId: number): Promise<string> {
  return freshUserToken(tokenDeps(env), userId);
}

/** `withUserToken` on the real store, key, and GitHub App. */
export function useUserToken<T>(
  env: TokenEnv,
  userId: number,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  return withUserToken(tokenDeps(env), userId, fn);
}
