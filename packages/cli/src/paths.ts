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

/**
 * Tighten an existing cache root too, without changing shared ancestors or
 * adopting a directory that holds anything but an older bilan cache.
 */
export function secureCacheDirectory(env: NodeJS.ProcessEnv = process.env): void {
  const directory = cacheDir(env);
  const custom = Boolean(env.BILAN_CACHE_DIR);
  const marker = join(directory, '.bilan-cache');
  if (existsSync(directory)) {
    const canonical = realpathSync(directory);
    const shared = [
      process.cwd(),
      homedir(),
      parse(canonical).root,
      env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    ];
    const problem = shared.some((path) => existsSync(path) && realpathSync(path) === canonical)
      ? 'is a shared directory'
      : existsSync(marker)
        ? undefined
        : legacyCacheProblem(directory, custom);
    if (problem !== undefined) {
      throw new Error(
        custom
          ? `BILAN_CACHE_DIR "${directory}" ${problem}; use a dedicated cache directory. Refusing to change its permissions.`
          : `The cache directory "${directory}" ${problem}. Move that out of the way or set BILAN_CACHE_DIR to a dedicated cache directory; refusing to change its permissions.`,
      );
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (!existsSync(marker)) writePrivateFile(marker, 'bilan\n');
}

const unrelated = (path: string) => `contains "${path}", which bilan did not write`;

/** Finder metadata, which can appear in any directory a user browsed. */
const DESKTOP_METADATA = '.DS_Store';

/**
 * Files older releases leave next to `<name>.json` when interrupted: atomic
 * write temporaries (`<name>.json.tmp`, `.<name>.json.<uuid>.tmp`) and fresh
 * sync staging (`<name>.json.<uuid>.fresh`, plus its journal).
 */
const LEFTOVER =
  /^(?:[\w.-]+\.json\.tmp|\.[\w.-]+\.json\.[\da-f-]{36}\.tmp|[\w.-]+\.json\.[\da-f-]{36}\.fresh(?:\.journal)?)$/;

/**
 * Why an unmarked, non-empty directory is not a cache written before the
 * marker existed, or `undefined` when it is one: owner directories of
 * `<name>.json` snapshots for that very repository, their journals, and
 * harmless leftovers. File names alone are not enough; any JSON configuration
 * tree would match them. A directory the user picked must also hold at least
 * one snapshot; the default location is bilan's by name.
 */
function legacyCacheProblem(directory: string, requireSnapshot: boolean): string | undefined {
  const owners = readdirSync(directory, { withFileTypes: true });
  let snapshots = 0;
  for (const owner of owners) {
    if (owner.name === DESKTOP_METADATA && owner.isFile()) continue;
    if (!owner.isDirectory() || !/^[\w-]+$/.test(owner.name)) return unrelated(owner.name);
    const files = readdirSync(join(directory, owner.name), { withFileTypes: true });
    for (const file of files) {
      const path = `${owner.name}/${file.name}`;
      if (!file.isFile()) return unrelated(path);
      if (file.name === DESKTOP_METADATA || LEFTOVER.test(file.name)) continue;
      const [, name, journal] = /^([\w.-]+)\.json(\.journal)?$/.exec(file.name) ?? [];
      if (name === undefined) return unrelated(path);
      if (journal) {
        if (!files.some((other) => other.name === `${name}.json`)) return unrelated(path);
      } else if (isSnapshotOf(join(directory, path), `${owner.name}/${name}`)) {
        snapshots++;
      } else {
        return unrelated(path);
      }
    }
  }
  return owners.length > 0 && snapshots === 0 && requireSnapshot
    ? 'is not empty and holds no bilan cache'
    : undefined;
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
