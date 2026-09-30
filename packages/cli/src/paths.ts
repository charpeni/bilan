import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';

import { sameRepo, writePrivateFile } from '@bilan/store-file';

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
    if (
      shared.some((path) => existsSync(path) && realpathSync(path) === canonical) ||
      (entries.length > 0 && !existsSync(marker) && !isLegacyCache(directory))
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

/**
 * Whether an unmarked directory holds a cache written before the marker
 * existed: owner directories of `<name>.json` snapshots for that very
 * repository, plus their journals. File names alone are not enough; any JSON
 * configuration tree would match them.
 */
function isLegacyCache(directory: string): boolean {
  let snapshots = 0;
  for (const owner of readdirSync(directory, { withFileTypes: true })) {
    if (!owner.isDirectory() || !/^[\w-]+$/.test(owner.name)) return false;
    const files = readdirSync(join(directory, owner.name), { withFileTypes: true });
    for (const file of files) {
      const name = /^([\w.-]+)\.json(\.journal)?$/.exec(file.name)?.[1];
      if (!file.isFile() || name === undefined) return false;
      if (file.name.endsWith('.journal')) {
        if (!files.some((other) => other.name === `${name}.json`)) return false;
      } else if (!isSnapshotOf(join(directory, owner.name, file.name), `${owner.name}/${name}`)) {
        return false;
      }
      snapshots += file.name.endsWith('.journal') ? 0 : 1;
    }
  }
  return snapshots > 0;
}

function isSnapshotOf(path: string, repo: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return (
      value !== null &&
      typeof value === 'object' &&
      'repo' in value &&
      sameRepo(value.repo, repo) &&
      'syncedAt' in value &&
      (value.syncedAt === null || typeof value.syncedAt === 'string') &&
      'prs' in value &&
      value.prs !== null &&
      typeof value.prs === 'object' &&
      !Array.isArray(value.prs)
    );
  } catch {
    return false;
  }
}
