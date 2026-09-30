import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';

import { writePrivateFile } from '@bilan/store-file';

import type { RepoRef } from '@bilan/core';

/** Where synced data lives: `$BILAN_CACHE_DIR` or `~/.cache/bilan`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BILAN_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'bilan');
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
export function secureCacheDirectory(env: NodeJS.ProcessEnv = process.env): void {
  const directory = cacheDir(env);
  const marker = join(directory, '.bilan-cache');
  if (existsSync(directory)) {
    const canonical = realpathSync(directory);
    const shared = [
      process.cwd(),
      homedir(),
      parse(canonical).root,
      env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    ];
    const entries = readdirSync(directory, { withFileTypes: true });
    const legacyCache = entries.every(
      (entry) =>
        entry.isDirectory() &&
        /^[\w-]+$/.test(entry.name) &&
        readdirSync(join(directory, entry.name)).every((file) =>
          /^[\w.-]+\.json(?:\.journal)?$/.test(file),
        ),
    );
    if (
      shared.some((path) => existsSync(path) && realpathSync(path) === canonical) ||
      (entries.length > 0 && !existsSync(marker) && !legacyCache)
    ) {
      throw new Error(
        `Use a dedicated cache directory for BILAN_CACHE_DIR; refusing to change permissions on "${directory}".`,
      );
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (!existsSync(marker)) writePrivateFile(marker, 'bilan\n');
}
