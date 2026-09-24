import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RepoRef } from '@bilan/core';

/** Where synced data lives: `$BILAN_CACHE_DIR` or `~/.cache/bilan`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BILAN_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'bilan');
}

export function storePath(repo: RepoRef, env?: NodeJS.ProcessEnv): string {
  return join(cacheDir(env), repo.owner, `${repo.name}.json`);
}
