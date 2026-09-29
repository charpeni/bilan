import type { AccessDecision } from './access.ts';
import type { Repo } from '@bilan/store-d1';

export interface RepoPageState {
  view: 'ready' | 'syncing' | 'not-found' | 'unavailable' | 'sign-in';
  /** Only an authorized cached row may reach the layout or progress display. */
  repo: Repo | undefined;
}

/** Opening a page decides what to display; importing a repo requires a POST. */
export function repoPageState(access: AccessDecision, cached: Repo | undefined): RepoPageState {
  switch (access.kind) {
    case 'ok':
      if (!cached) throw new Error('an access decision of ok needs a cached row');
      return { view: cached.lastSyncedAt === null ? 'syncing' : 'ready', repo: cached };
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
