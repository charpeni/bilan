import { GithubClient, GithubError, RepoNotFoundError } from '@bilan/core';

import { useUserToken } from './tokens.ts';

import type { TokenEnv } from './tokens.ts';
import type { GithubRepoMeta, RepoRef } from '@bilan/core';

/** Which token a sync or a first read of `ref` runs on, with what GitHub said about the repo. */
export type TokenSource =
  | { source: 'user'; userId: number; meta: GithubRepoMeta }
  | { source: 'server'; meta: GithubRepoMeta }
  /** A private repo the viewer cannot reach, or one that does not exist: indistinguishable by design. */
  | { source: 'not-found' }
  /** Signed out: no sync or first read runs on anyone's token. */
  | { source: 'login-required' };

/** A `TokenSource` GitHub actually answered on: what a first sync runs with. */
export type ResolvedTokenSource = Extract<TokenSource, { source: 'user' | 'server' }>;

/** Everything the decision touches, so the rule runs in plain vitest with fakes. */
export interface TokenSourceDeps {
  /**
   * `GithubClient.repoMeta` on the viewer's fresh token; rejects with
   * `RepoNotFoundError` when the app is not installed there (or the repo does
   * not exist), and with `ReauthRequiredError` when the viewer must sign in again.
   */
  userRepoMeta(userId: number, ref: RepoRef): Promise<GithubRepoMeta>;
  /**
   * The same on the server token (a no-scope PAT): sees public repos only.
   * `null` when `GITHUB_TOKEN` is not configured.
   */
  serverRepoMeta: ((ref: RepoRef) => Promise<GithubRepoMeta>) | null;
}

export function tokenSourceDeps(env: TokenEnv & Pick<Env, 'GITHUB_TOKEN'>) {
  return {
    userRepoMeta: (userId, ref) =>
      useUserToken(
        env,
        userId,
        async (token) => (await new GithubClient({ token }).repoMeta(ref)).meta,
      ),
    serverRepoMeta: env.GITHUB_TOKEN
      ? async (ref: RepoRef) =>
          (await new GithubClient({ token: serverToken(env) }).repoMeta(ref)).meta
      : null,
  } satisfies TokenSourceDeps;
}

/**
 * The optional server token (`GITHUB_TOKEN`). Without it the public-repo
 * fallback below is never taken: a repo the viewer's own token cannot reach
 * is simply not found.
 */
export function serverToken(env: Pick<Env, 'GITHUB_TOKEN'>): string {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
  return env.GITHUB_TOKEN;
}

/**
 * Which token a signed-in viewer's sync or first read runs on. The viewer's
 * own token is tried first; the server token is a safety net for public repos
 * it cannot reach. (Checked on 2026-09-28: a GitHub App user token does read
 * public repos the app is not installed on, so the fallback rarely triggers.)
 *
 * | viewer     | user token sees it | server token sees it | result         |
 * | ---------- | ------------------ | -------------------- | -------------- |
 * | signed in  | yes                | —                    | user           |
 * | signed in  | no                 | yes, public          | server         |
 * | signed in  | no                 | no, or private       | not-found      |
 * | signed in  | no                 | (no server token)    | not-found      |
 * | signed out | —                  | —                    | login-required |
 *
 * The server token's own private repos are never served: a private answer from
 * it is treated as not found, so the viewer's own access is the only gate. A
 * server token GitHub rejects (expired, revoked) counts as none configured.
 * Signed-out viewers never get a source: they cannot sync, and only see the
 * built-in examples or a public repo bilan already holds (see `checkRepoAccess`).
 */
export async function resolveTokenSource(
  deps: TokenSourceDeps,
  user: { id: number } | null,
  ref: RepoRef,
): Promise<TokenSource> {
  if (user === null) return { source: 'login-required' };
  try {
    return { source: 'user', userId: user.id, meta: await deps.userRepoMeta(user.id, ref) };
  } catch (error) {
    if (!(error instanceof RepoNotFoundError)) throw error;
  }
  return serverSource(deps, ref);
}

async function serverSource(deps: TokenSourceDeps, ref: RepoRef): Promise<TokenSource> {
  if (!deps.serverRepoMeta) return { source: 'not-found' };
  let meta: GithubRepoMeta | 'rejected';
  try {
    meta = await askServer(deps.serverRepoMeta, ref);
  } catch (error) {
    if (!(error instanceof RepoNotFoundError)) throw error;
    return { source: 'not-found' };
  }
  if (meta === 'rejected' || meta.isPrivate) return { source: 'not-found' };
  return { source: 'server', meta };
}

/**
 * `serverRepoMeta`, with GitHub refusing the server token itself (a 401: it
 * expired or was revoked) answered as `rejected` and logged. Callers then go on
 * as if no server token were configured, rather than answering 503 for every
 * public repo until the token is replaced.
 */
export async function askServer(
  serverRepoMeta: NonNullable<TokenSourceDeps['serverRepoMeta']>,
  ref: RepoRef,
): Promise<GithubRepoMeta | 'rejected'> {
  try {
    return await serverRepoMeta(ref);
  } catch (error) {
    if (!(error instanceof GithubError) || error.status !== 401) throw error;
    console.error('GITHUB_TOKEN was rejected by GitHub; replace it', error);
    return 'rejected';
  }
}
