import { getRepoByName } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { accessDeps, checkRepoAccess } from '../../../../../lib/access.ts';
import { getDb } from '../../../../../lib/db.ts';
import {
  githubUnavailable,
  json,
  loginRequired,
  unknownRepository,
} from '../../../../../lib/http.ts';
import { findActiveJob } from '../../../../../lib/jobs.ts';
import { payloadKey } from '../../../../../lib/payload-key.ts';
import { SYNC_ACTIVE_HEADER, SYNCED_AT_HEADER } from '../../../../../lib/poll.ts';
import { isStale } from '../../../../../lib/stale.ts';

import type { SessionUser } from '../../../../../lib/session.ts';
import type { APIRoute } from 'astro';

/**
 * The payload, plus what the page needs to wait for a sync without a job id
 * it may not read (see `lib/poll.ts`): `x-bilan-synced-at` names the payload
 * on offer and `x-bilan-sync-active` says whether a job is queued or running.
 * Both are answered only once the viewer passed the same access check as the
 * payload itself. `HEAD` answers the same status and headers without the body,
 * so polling never re-downloads the payload.
 */
async function respond(
  method: 'GET' | 'HEAD',
  owner: string,
  name: string,
  user: SessionUser | null,
): Promise<Response> {
  const db = getDb(env);
  const repo = await getRepoByName(db, owner, name);
  // An unknown name takes the same GitHub round trip as a private row the
  // viewer cannot see, so the answer (401, 503, or 404) never tells them apart.
  const access = await checkRepoAccess(accessDeps(env), user, repo ?? { owner, name });
  if (access.kind === 'login-required') return loginRequired();
  if (access.kind === 'unavailable') return githubUnavailable();
  // `unknown` and `replaced` have no payload yet either: the page starts their first sync.
  if (access.kind !== 'ok' || !repo) return unknownRepository();

  const job = await findActiveJob(db, repo.id);
  const syncActive = { [SYNC_ACTIVE_HEADER]: job ? '1' : '0', 'cache-control': 'no-store' };

  if (repo.lastSyncedAt === null) {
    if (job) return json({ message: 'first sync in progress' }, 202, syncActive);
    return json({ message: 'repository has not been synced yet' }, 404, syncActive);
  }

  const key = payloadKey(repo.id, repo.lastSyncedAt);
  let object: R2Object | null;
  let body: ReadableStream | null = null;
  if (method === 'HEAD') {
    object = await env.PAYLOADS.head(key);
  } else {
    const got = await env.PAYLOADS.get(key);
    object = got;
    body = got?.body ?? null;
  }
  if (!object) return json({ message: 'payload missing; re-sync required' }, 404, syncActive);

  return new Response(body, {
    status: 200,
    encodeBody: 'manual',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'cache-control': 'private, max-age=60',
      etag: object.httpEtag,
      [SYNCED_AT_HEADER]: repo.lastSyncedAt,
      'x-bilan-stale': isStale(repo.lastSyncedAt) ? '1' : '0',
      [SYNC_ACTIVE_HEADER]: syncActive[SYNC_ACTIVE_HEADER],
    },
  });
}

export const GET: APIRoute = ({ params, locals }) => {
  const { owner, name } = params as { owner: string; name: string };
  return respond('GET', owner, name, locals.user);
};

export const HEAD: APIRoute = ({ params, locals }) => {
  const { owner, name } = params as { owner: string; name: string };
  return respond('HEAD', owner, name, locals.user);
};
