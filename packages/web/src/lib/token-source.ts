import { GithubClient, RepoNotFoundError } from '@bilan/core';

import { isExampleRepo } from './stale.ts';
import { useUserToken } from './tokens.ts';

import type { TokenEnv } from './tokens.ts';
import type { GithubRepoMeta, RepoRef } from '@bilan/core';

/** Which token a sync or a first read of `ref` runs on, with what GitHub said about the repo. */
export type TokenSource =
  | { source: 'user'; userId: number; meta: GithubRepoMeta }
  | { source: 'server'; meta: GithubRepoMeta }
  /** A private repo the viewer cannot reach, or one that does not exist: indistinguishable by design. */
  | { source: 'not-found' }
  /** Signed out and not the example repo. */
  | { source: 'login-required' };

/** A `TokenSource` GitHub actually answered on: what a first sync runs with. */
export type ResolvedTokenSource = Extract<TokenSource, { source: 'user' | 'server' }>;

/** Everything the decision touches, so the rule runs in plain vitest with fakes. */
export interface TokenSourceDeps {
  exampleRepo: string;
  /**
   * `GithubClient.repoMeta` on the viewer's fresh token; rejects with
   * `RepoNotFoundError` when the app is not installed there (or the repo does
   * not exist), and with `ReauthRequiredError` when the viewer must sign in again.
   */
  userRepoMeta(userId: number, ref: RepoRef): Promise<GithubRepoMeta>;
  /** The same on the server token (a no-scope PAT): sees public repos only. */
  serverRepoMeta(ref: RepoRef): Promise<GithubRepoMeta>;
}

export function tokenSourceDeps(env: TokenEnv & Pick<Env, 'EXAMPLE_REPO' | 'GITHUB_TOKEN'>) {
  return {
    exampleRepo: env.EXAMPLE_REPO,
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

export function serverToken(env: Pick<Env, 'GITHUB_TOKEN'>): string {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
  return env.GITHUB_TOKEN;
}

/**
 * A GitHub App user token reaches only the repos the app is installed on, so
 * public repos elsewhere are read on the server token instead.
 *
 * | viewer     | user token sees it | server token sees it | result         |
 * | ---------- | ------------------ | -------------------- | -------------- |
 * | signed in  | yes                | —                    | user           |
 * | signed in  | no                 | yes, public          | server         |
 * | signed in  | no                 | no, or private       | not-found      |
 * | signed out | —                  | example repo         | server         |
 * | signed out | —                  | anything else        | login-required |
 *
 * The server token's own private repos are never served: a private answer from
 * it is treated as not found, so the viewer's own access is the only gate.
 */
export async function resolveTokenSource(
  deps: TokenSourceDeps,
  user: { id: number } | null,
  ref: RepoRef,
): Promise<TokenSource> {
  if (user === null) {
    if (!isExampleRepo({ EXAMPLE_REPO: deps.exampleRepo }, ref.owner, ref.name)) {
      return { source: 'login-required' };
    }
    return serverSource(deps, ref);
  }
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
