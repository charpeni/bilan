import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import type { RepoRef } from '@bilan/core';

/** Where synced data lives: `$BILAN_CACHE_DIR` or `~/.cache/bilan`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BILAN_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'bilan');
}

export function storePath(repo: RepoRef, env?: NodeJS.ProcessEnv): string {
  if (
    [repo.owner, repo.name].some((part) => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('Invalid repository cache path');
  }
  const root = resolve(cacheDir(env));
  const target = resolve(root, repo.owner, `${repo.name}.json`);
  const child = relative(root, target);
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Repository cache path must stay inside the cache directory');
  }
  return target;
}

/** Tighten an existing cache root too, without changing shared ancestors. */
export function secureCacheDirectory(env?: NodeJS.ProcessEnv): void {
  const directory = cacheDir(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}
