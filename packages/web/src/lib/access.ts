import { GithubError, RepoNotFoundError } from '@bilan/core';
import { schema } from '@bilan/store-d1';
import { eq } from 'drizzle-orm';

import { getDb } from './db.ts';
import { resolveTokenSource, tokenSourceDeps } from './token-source.ts';

import type { SessionUser } from './session.ts';
import type { ResolvedTokenSource, TokenSource, TokenSourceDeps } from './token-source.ts';
import type { RepoRef } from '@bilan/core';
import type { Repo } from '@bilan/store-d1';

/**
 * What a viewer may do with the repo at a name.
 *
 * - `unavailable`: GitHub could not answer the question, so nothing is decided;
 *   callers answer 503 rather than showing or hiding the repo.
 * - `unknown`: bilan has no row for the name but GitHub sees the repo on
 *   `source`; the caller starts its first sync there.
 * - `replaced`: bilan has a row for the name but GitHub now reports a
 *   different repo there (the old one was renamed or deleted). The old row is
 *   never served; the caller starts the newcomer's first sync on `source`,
 *   which parks the old row (`upsertRepo`).
 */
export type AccessDecision =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'login-required' }
  | { kind: 'unavailable' }
  | { kind: 'unknown'; source: ResolvedTokenSource }
  | { kind: 'replaced'; source: ResolvedTokenSource };

/** Only the columns the decision reads, so tests and callers can pass partial rows. */
export type AccessRepo = Pick<Repo, 'id' | 'owner' | 'name' | 'isPrivate'>;

export const ACCESS_CACHE_TTL_S = 15 * 60;
export const VISIBILITY_CACHE_TTL_S = 15 * 60;
const READ_PERMISSIONS = new Set(['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']);

/** Only an allow is cached; any other value (including a legacy `denied`) is ignored. */
type CachedAccess = 'allowed';
type CachedVisibility = 'public' | 'private';

const OK: AccessDecision = { kind: 'ok' };
const NOT_FOUND: AccessDecision = { kind: 'not-found' };
const LOGIN_REQUIRED: AccessDecision = { kind: 'login-required' };
const UNAVAILABLE: AccessDecision = { kind: 'unavailable' };

export interface AccessCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Everything `checkRepoAccess` touches, so the logic runs in plain vitest with fakes. */
export interface AccessDeps extends TokenSourceDeps {
  cache: AccessCache;
  /** Record in `repos` that GitHub now reports the repo as private. */
  markPrivate(repoId: string): Promise<void>;
}

export function accessDeps(
  env: Pick<
    Env,
    | 'CACHE'
    | 'DB'
    | 'TOKEN_ENCRYPTION_KEY'
    | 'GITHUB_CLIENT_ID'
    | 'GITHUB_CLIENT_SECRET'
    | 'GITHUB_TOKEN'
  >,
): AccessDeps {
  return {
    ...tokenSourceDeps(env),
    cache: env.CACHE,
    markPrivate: async (repoId) => {
      await getDb(env)
        .update(schema.repos)
        .set({ isPrivate: true })
        .where(eq(schema.repos.id, repoId));
    },
  };
}

export function accessCacheKey(userId: number, repoId: string): string {
  return `repo_access:${userId}:${repoId}`;
}

export function visibilityCacheKey(repoId: string): string {
  return `repo_visibility:${repoId}`;
}

/**
 * Decide whether `user` may see the repo at a name. `target` is the cached
 * row when bilan has one, else just the `owner/name` asked for.
 *
 * | target           | viewer                              | result                     |
 * | ---------------- | ----------------------------------- | -------------------------- |
 * | anything         | signed out                          | login-required             |
 * | unknown          | GitHub sees it (user, else server)  | unknown (with the source)  |
 * | unknown          | neither token sees it               | not-found                  |
 * | public (still)   | signed in                           | ok                         |
 * | public → private | anyone                              | as private, row updated    |
 * | private          | signed in, cached allowed           | ok                         |
 * | private          | signed in, GitHub sees it (read+)   | ok (cached allowed)        |
 * | private          | signed in, GitHub 404 or no read    | not-found (never cached)   |
 * | any row          | a different repo at that name       | replaced (with the source) |
 * | any              | GitHub down while probing           | unavailable                |
 *
 * A public row is never trusted for long: every 15 minutes the server token
 * re-reads the repo (`repo_visibility:{id}`); anything but "the same repo,
 * still public" is handled as private. From there, and for an unknown name,
 * GitHub is asked through `resolveTokenSource` (the viewer's token, then the
 * server's for a public repo), so an unknown name, a private repo the viewer
 * cannot see, and a name nobody can see all take the same path and answer
 * alike: `not-found` once GitHub said so, `unavailable` while it cannot say.
 * Only an allow is ever cached: a cached denial would answer `not-found`
 * without asking GitHub, while an unknown name always asks, so the two would
 * come apart the moment GitHub cannot answer (503 for one, 404 for the other).
 * Signed-out viewers get the same answer whether or not the row exists, so the
 * cache never leaks either; the built-in examples are served from static
 * files before this check is reached (see `examples.ts`). A viewer whose
 * token is gone gets a `ReauthRequiredError` from `userRepoMeta`, which the
 * middleware turns into a login redirect (pages) or a 401 (APIs).
 */
export async function checkRepoAccess(
  deps: AccessDeps,
  user: SessionUser | null,
  target: AccessRepo | RepoRef,
): Promise<AccessDecision> {
  const ref: RepoRef = { owner: target.owner, name: target.name };
  if (!user) return LOGIN_REQUIRED;
  if (!isKnown(target)) {
    const source = await probe(deps, user, ref);
    if (source === 'unavailable') return UNAVAILABLE;
    if (source.source === 'not-found') return NOT_FOUND;
    return { kind: 'unknown', source };
  }
  const repo = target;

  let isPrivate = repo.isPrivate;
  if (!isPrivate) {
    const visibility = await currentVisibility(deps, user, repo);
    if (visibility === 'unavailable') return UNAVAILABLE;
    if (visibility === 'public') return OK;
    isPrivate = true;
  }

  const key = accessCacheKey(user.id, repo.id);
  const cached = (await deps.cache.get(key)) as CachedAccess | null;
  if (cached === 'allowed') return OK;

  // Every non-allowed answer is asked of GitHub again, exactly as for an
  // unknown name: a denial is never cached (see the table above).
  const source = await probe(deps, user, ref);
  if (source === 'unavailable') return UNAVAILABLE;
  if (source.source === 'not-found') return NOT_FOUND;
  // The name now belongs to another repo: the cached row is not what the
  // viewer asked for, so it is never served, whatever they may see of it.
  if (source.meta.id !== repo.id) return { kind: 'replaced', source };

  // Same repo, public again after all (the server token sees it), or readable
  // by the viewer's own token.
  const permission = source.meta.viewerPermission;
  const allowed =
    source.source === 'server' || (permission !== null && READ_PERMISSIONS.has(permission));
  if (!allowed) return NOT_FOUND;
  await deps.cache.put(key, 'allowed', { expirationTtl: ACCESS_CACHE_TTL_S });
  return OK;
}

function isKnown(target: AccessRepo | RepoRef): target is AccessRepo {
  return 'id' in target;
}

/** `resolveTokenSource`, with a GitHub failure reported as `unavailable` instead of thrown. */
async function probe(
  deps: TokenSourceDeps,
  user: { id: number } | null,
  ref: RepoRef,
): Promise<ResolvedTokenSource | { source: 'not-found' } | 'unavailable'> {
  let source: TokenSource;
  try {
    source = await resolveTokenSource(deps, user, ref);
  } catch (error) {
    if (error instanceof RepoNotFoundError) return { source: 'not-found' };
    if (error instanceof GithubError) return 'unavailable';
    throw error;
  }
  // Signed-out viewers were sent to login above, so this never happens; the
  // narrowing is for the type only.
  if (source.source === 'login-required') return { source: 'not-found' };
  return source;
}

/**
 * Is a row that says public still the same public repo? Answered from the
 * `repo_visibility` cache, else by a `repoMeta` on the server token (which
 * sees public repos only), or on the viewer's own token when no server token
 * is configured (a GitHub App user token reads public repos without an
 * install). "Private" covers everything the token cannot confirm: an actual
 * private repo, a repo it cannot see at all, or a different repo now living at
 * that name; the row is updated so the private rules apply from here on (the
 * next sync writes GitHub's answer back).
 */
async function currentVisibility(
  deps: AccessDeps,
  user: SessionUser,
  repo: AccessRepo,
): Promise<CachedVisibility | 'unavailable'> {
  const key = visibilityCacheKey(repo.id);
  const cached = (await deps.cache.get(key)) as CachedVisibility | null;
  if (cached === 'public' || cached === 'private') return cached;

  const ref: RepoRef = { owner: repo.owner, name: repo.name };
  let visibility: CachedVisibility;
  try {
    const meta = deps.serverRepoMeta
      ? await deps.serverRepoMeta(ref)
      : await deps.userRepoMeta(user.id, ref);
    visibility = meta.id === repo.id && !meta.isPrivate ? 'public' : 'private';
  } catch (error) {
    if (error instanceof RepoNotFoundError) visibility = 'private';
    else if (error instanceof GithubError) return 'unavailable';
    else throw error;
  }
  if (visibility === 'private') await deps.markPrivate(repo.id);
  await deps.cache.put(key, visibility, { expirationTtl: VISIBILITY_CACHE_TTL_S });
  return visibility;
}
