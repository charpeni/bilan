import { GithubError, RepoNotFoundError } from '@bilan/core';
import { getRepoByName } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { accessDeps, checkRepoAccess } from '../../../../../lib/access.ts';
import { getDb } from '../../../../../lib/db.ts';
import { DEFAULT_DEPTH, isSyncDepth, SYNC_DEPTHS } from '../../../../../lib/depth.ts';
import { exampleSyncRefused, isExample } from '../../../../../lib/examples.ts';
import {
  githubUnavailable,
  json,
  loginRequired,
  unknownRepository,
} from '../../../../../lib/http.ts';
import {
  startSync,
  SyncAlreadyRunningError,
  SyncRateLimitedError,
} from '../../../../../lib/jobs.ts';
import { GithubUnavailableError, ReauthRequiredError } from '../../../../../lib/tokens.ts';

import type { SyncDepth } from '../../../../../lib/depth.ts';
import type { APIRoute } from 'astro';

/**
 * The optional JSON body is `{ depth?: '30d' | '90d' | '180d' | 'all' }`. An
 * empty or JSON-less body means the default depth; anything else invalid is a
 * 400 so a typo never silently triggers a shallow sync.
 */
async function readDepth(request: Request): Promise<SyncDepth | Response> {
  const text = (await request.text()).trim();
  if (text === '') return DEFAULT_DEPTH;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ message: 'body must be JSON' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ message: 'body must be a JSON object' }, 400);
  }
  const depth = (body as { depth?: unknown }).depth;
  if (depth === undefined) return DEFAULT_DEPTH;
  if (!isSyncDepth(depth)) {
    return json({ message: `depth must be one of ${SYNC_DEPTHS.join(', ')}` }, 400);
  }
  return depth;
}

/**
 * Signed-in viewers sync on their own token (rate limited per repo). The
 * built-in examples are static snapshots and are refused for everyone, before
 * the login check, so the answer is the same signed in or out.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const { owner, name } = params as { owner: string; name: string };
  if (isExample(owner, name)) return exampleSyncRefused();
  const user = locals.user;
  if (!user) return loginRequired();

  const depth = await readDepth(request);
  if (depth instanceof Response) return depth;

  // An unknown name and a private row the viewer cannot see take the same
  // GitHub round trip, so 401, 503, and 404 never tell them apart. A name
  // another repo took over (`replaced`) is synced as that new repo, which
  // parks the old row; its data is never served.
  const repo = await getRepoByName(getDb(env), owner, name);
  const access = await checkRepoAccess(accessDeps(env), user, repo ?? { owner, name });
  if (access.kind === 'login-required') return loginRequired();
  if (access.kind === 'unavailable') return githubUnavailable();
  if (access.kind === 'not-found') return unknownRepository();

  try {
    const { jobId, since } = await startSync(
      env,
      { owner, name },
      {
        mode: 'incremental',
        depth,
        requestedBy: user.id,
        ...(access.kind === 'ok' ? {} : { source: access.source }),
      },
    );
    return json({ jobId, depth, since: since ?? null }, 202);
  } catch (error) {
    // The middleware answers 401 for a viewer who has to sign in again, 503 when GitHub is down.
    if (error instanceof ReauthRequiredError || error instanceof GithubUnavailableError) {
      throw error;
    }
    if (error instanceof SyncAlreadyRunningError) {
      return json({ message: error.message }, 409);
    }
    if (error instanceof SyncRateLimitedError) {
      return json({ message: error.message, retryAfter: error.retryAfter }, 429, {
        'retry-after': String(error.retryAfter),
      });
    }
    // The viewer's token cannot see it: same answer as for a repo that does not exist.
    if (error instanceof RepoNotFoundError) return unknownRepository();
    // GitHub failed on the first read (outage or transport): nothing is decided.
    if (error instanceof GithubError) return githubUnavailable();
    return json({ message: error instanceof Error ? error.message : String(error) }, 500);
  }
};
