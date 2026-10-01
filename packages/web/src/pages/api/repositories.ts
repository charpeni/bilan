import { listRepoViews } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { accessDeps, checkRepoAccess } from '../../lib/access.ts';
import { getDb } from '../../lib/db.ts';
import { json, loginRequired } from '../../lib/http.ts';
import { SWITCHER_LIMIT } from '../../lib/repo-switcher.ts';
import { filterVisibleViews } from '../../lib/views.ts';

import type { SwitcherRepo } from '../../lib/repo-switcher.ts';
import type { APIRoute } from 'astro';

/**
 * The viewer's most recently opened repositories, most recent first, for the
 * header's repository switcher. Only the latest `SWITCHER_LIMIT` are checked,
 * each with the same access check as `/repositories` (cached for 15 minutes),
 * so a repository the viewer may no longer see drops off here too.
 */
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return loginRequired();
  const deps = accessDeps(env);
  const recent = (await listRepoViews(getDb(env), user.id)).slice(0, SWITCHER_LIMIT);
  const views = await filterVisibleViews(recent, (view) =>
    checkRepoAccess(deps, user, {
      id: view.repoId,
      owner: view.owner,
      name: view.name,
      isPrivate: view.isPrivate,
    }),
  );
  const repositories: SwitcherRepo[] = views.map(({ owner, name, isPrivate, lastViewedAt }) => ({
    owner,
    name,
    isPrivate,
    lastViewedAt,
  }));
  return json({ repositories }, 200, { 'cache-control': 'no-store' });
};
