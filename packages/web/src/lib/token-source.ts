import { GithubClient, RepoNotFoundError } from '@bilan/core';

import { useUserToken } from './tokens.ts';

import type { TokenEnv } from './tokens.ts';
import type { GithubRepoMeta, RepoRef } from '@bilan/core';

/** Which token a sync or a first read of `ref` runs on, with what GitHub said about the repo. */
export type TokenSource =
  | { source: 'user'; userId: number; meta: GithubRepoMeta }
  | { source: 'server'; meta: GithubRepoMeta }
  /** A private repo the viewer cannot reach, or one that does not exist: indistinguishable by design. */
  | { source: 'not-found' }
  /** Signed out: nothing is read on anyone's token (the built-in examples are static, see `examples.ts`). */
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
   * Rejects with a plain `Error` when `GITHUB_TOKEN` is not configured.
   */
  serverRepoMeta(ref: RepoRef): Promise<GithubRepoMeta>;
}

export function tokenSourceDeps(env: TokenEnv & Pick<Env, 'GITHUB_TOKEN'>) {
  return {
    userRepoMeta: (userId, ref) =>
      useUserToken(
        env,
        userId,
        async (token) => (await new GithubClient({ token }).repoMeta(ref)).meta,
      ),
    serverRepoMeta: async (ref) =>
      (await new GithubClient({ token: serverToken(env) }).repoMeta(ref)).meta,
  } satisfies TokenSourceDeps;
}

/**
 * The optional server token (`GITHUB_TOKEN`). Nothing reads it at startup:
 * it is only resolved when the public-repo fallback below is actually taken,
 * so a deployment without it works until a signed-in viewer opens a public
 * repo their own token cannot reach.
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
 * | signed out | —                  | —                    | login-required |
 *
 * The server token's own private repos are never served: a private answer from
 * it is treated as not found, so the viewer's own access is the only gate.
 * Signed-out viewers never reach GitHub: the built-in examples are served
 * from static files before any token is considered (see `examples.ts`).
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
  let meta: GithubRepoMeta;
  try {
    meta = await deps.serverRepoMeta(ref);
  } catch (error) {
    if (!(error instanceof RepoNotFoundError)) throw error;
    return { source: 'not-found' };
  }
  if (meta.isPrivate) return { source: 'not-found' };
  return { source: 'server', meta };
}
