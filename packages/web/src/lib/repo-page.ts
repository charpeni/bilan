import type { AccessDecision } from './access.ts';
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

/** A cross-site landing must not turn into an automatic, same-origin sync POST. */
export function allowAutoRefresh(request: Request): boolean {
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
