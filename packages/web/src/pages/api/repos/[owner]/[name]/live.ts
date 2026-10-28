import { getRepoByName } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { accessDeps, checkRepoAccess } from '../../../../../lib/access.ts';
import { getDb } from '../../../../../lib/db.ts';
import { findExample } from '../../../../../lib/examples.ts';
import {
  githubUnavailable,
  json,
  loginRequired,
  unknownRepository,
} from '../../../../../lib/http.ts';

import type { APIRoute } from 'astro';

/**
 * The repository's sync status as Server-Sent Events, pushed by the sync
 * model on every change (bilan-domain's `GET /sync/watch`). The page uses
 * each event as a cue to read the job or payload again, instead of polling
 * on a timer (`lib/live-sync.ts`). Answered only after the same access check
 * as the payload; a built-in example never syncs, so it has no stream.
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, name } = params as { owner: string; name: string };
  if (findExample(owner, name)) return json({ message: 'examples do not sync' }, 404);

  const repo = await getRepoByName(getDb(env), owner, name);
  // An unknown name takes the same GitHub round trip as a private row the
  // viewer cannot see, so the answer (401, 503, or 404) never tells them apart.
  const access = await checkRepoAccess(accessDeps(env), locals.user, repo ?? { owner, name });
  if (access.kind === 'login-required') return loginRequired();
  if (access.kind === 'unavailable') return githubUnavailable();
  if (access.kind !== 'ok' || !repo) return unknownRepository();

  const upstream = await env.DOMAIN.fetch(
    `https://bilan-domain/sync/watch?repoId=${encodeURIComponent(repo.id)}`,
    { signal: request.signal },
  );
  if (!upstream.ok || !upstream.body) {
    return json({ message: 'live status is unavailable' }, 503);
  }
  return new Response(upstream.body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
};
