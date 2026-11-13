import type { AccessDecision } from './access.ts';
import type { RepoRef } from '@bilan/core';
import type { Repo } from '@bilan/store-d1';

export interface RepoPageState {
  view: 'ready' | 'syncing' | 'not-found' | 'unavailable' | 'sign-in';
  /** Only an authorized cached row may reach the layout or progress display. */
  repo: Repo | undefined;
}

/**
 * Opening a page decides what to display; importing a repo requires a POST.
 * Signed out, a public repo shows only once it has a payload: until then (or
 * for anything else) the sign-in card, since a signed-out viewer cannot sync.
 */
export function repoPageState(
  access: AccessDecision,
  cached: Repo | undefined,
  signedIn: boolean,
): RepoPageState {
  switch (access.kind) {
    case 'ok':
      if (!cached) throw new Error('an access decision of ok needs a cached row');
      if (cached.lastSyncedAt !== null) return { view: 'ready', repo: cached };
      return signedIn ? { view: 'syncing', repo: cached } : { view: 'sign-in', repo: undefined };
    case 'unknown':
    case 'replaced':
      return { view: 'syncing', repo: undefined };
    case 'login-required':
      return { view: 'sign-in', repo: undefined };
    default:
      return { view: access.kind, repo: undefined };
  }
}

/**
 * Where the dashboard of `requested` (the URL's `owner/name`) really lives,
 * when the URL spells it differently: another letter case, or the old name of
 * a renamed or transferred repo. `null` to stay on the page as asked.
 *
 * The canonical spelling is only ever revealed once the viewer has been shown
 * to see the repo: for `ok`, the row's spelling (written from GitHub's own on
 * every sync, and the one a later lookup finds the row by, so following the
 * redirect never bounces back); for `unknown` and `replaced`, the spelling
 * GitHub answered to the viewer's token, or to the server token for a public
 * repo. Every other decision answers alike whatever the name, so a private
 * repo the viewer cannot see still cannot be told from one that does not exist.
 */
export function canonicalPath(
  requested: RepoRef,
  access: AccessDecision,
  cached: Pick<Repo, 'owner' | 'name'> | undefined,
): string | null {
  let canonical: RepoRef;
  switch (access.kind) {
    case 'ok':
      if (!cached) return null;
      canonical = { owner: cached.owner, name: cached.name };
      break;
    case 'unknown':
    case 'replaced':
      canonical = { owner: access.source.meta.owner.login, name: access.source.meta.name };
      break;
    default:
      return null;
  }
  if (canonical.owner === requested.owner && canonical.name === requested.name) return null;
  return `/${encodeURIComponent(canonical.owner)}/${encodeURIComponent(canonical.name)}`;
}

/** A cross-site landing must not turn into an automatic, same-origin sync POST. */
export function allowAutoRefresh(request: Request): boolean {
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
