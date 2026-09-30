import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { FileStore } from '@bilan/store-file';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Take the lock that lets one fresh sync at a time build the staging cache
 * at `staging`. Returns a release.
 *
 * The lock is the directory `<staging>.lock` holding one entry named after
 * its holder: `<pid>.<uuid>.<host>`. Creating the directory, creating an
 * entry and removing an entry by its name each succeed for one process only,
 * so a run taking over a holder whose process is gone from this host removes
 * that very holder and nothing else: a run that decided to take over the
 * same holder later finds it gone and looks again. A run only holds the lock
 * once its entry is alone in the directory, and releasing removes its own
 * entry and never another's. Any other holder, from another host or not
 * named like ours, is refused, naming the process.
 */
export function lockStaging(staging: string): () => void {
  const lock = `${staging}.lock`;
  const self = `${process.pid}.${randomUUID()}.${encodeURIComponent(hostname())}`;
  const release = () => {
    rmSync(join(lock, self), { force: true });
    removeIfEmpty(lock);
  };
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 10; attempt++) {
    if (succeeds(() => mkdirSync(lock, { mode: 0o700 }), 'EEXIST')) {
      // ENOENT: taken for abandoned while still empty; start over.
      if (!succeeds(() => closeSync(openSync(join(lock, self), 'wx', 0o600)), 'ENOENT')) continue;
      let alone = false;
      try {
        alone = readdirSync(lock).every((name) => name === self);
      } finally {
        if (!alone) release();
      }
      if (alone) return release;
    }
    let names: string[];
    try {
      names = readdirSync(lock);
    } catch (error) {
      if (code(error) === 'ENOENT') continue; // Released in the meantime.
      if (code(error) === 'ENOTDIR') refuse(lock);
      throw error;
    }
    if (names.length === 0) {
      // Being created or taken over right now, or its creator was killed
      // before naming itself, which leaves it empty for good.
      let idle: number;
      try {
        idle = Date.now() - statSync(lock).mtimeMs;
      } catch (error) {
        if (code(error) === 'ENOENT') continue;
        throw error;
      }
      if (idle < MINUTE) refuse(lock);
      removeIfEmpty(lock);
      continue;
    }
    for (const name of names) {
      const holder = parseHolder(name);
      if (holder === undefined || !abandoned(holder)) refuse(lock, holder);
    }
    for (const name of names) rmSync(join(lock, name), { force: true });
    removeIfEmpty(lock);
  }
  refuse(lock);
}

interface Holder {
  pid: number;
  host: string;
}

function refuse(lock: string, holder?: Holder): never {
  throw new Error(
    `Another fresh sync of this repository is running (process ${holder === undefined ? 'unknown' : `${holder.pid} ${holder.host}`}). Wait for it, or remove "${lock}" if it is not running.`,
  );
}

function parseHolder(name: string): Holder | undefined {
  const match = /^(\d+)\.[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.(.+)$/.exec(name);
  if (match === null) return undefined;
  try {
    return { pid: Number(match[1]), host: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
}

/** Whether the process that holds a lock is gone. */
function abandoned({ pid, host }: Holder): boolean {
  if (host !== hostname()) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return code(error) === 'ESRCH';
  }
}

/** Remove `lock` unless another run has already removed it or named itself in it. */
function removeIfEmpty(lock: string): void {
  succeeds(() => rmdirSync(lock), 'ENOENT', 'ENOTEMPTY', 'EEXIST');
}

/** Whether `action` succeeded, or failed with one of the `tolerated` codes. */
function succeeds(action: () => void, ...tolerated: string[]): boolean {
  try {
    action();
    return true;
  } catch (error) {
    if (tolerated.includes(code(error) ?? '')) return false;
    throw error;
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * The staging cache of an unfinished fresh sync, to continue it; one that
 * cannot be read is discarded, since the next fresh sync rebuilds it anyway.
 */
export function openStaging(staging: string, repo: string): FileStore {
  try {
    return new FileStore(staging, repo);
  } catch {
    rmSync(staging, { force: true });
    rmSync(`${staging}.journal`, { force: true });
    return new FileStore(staging, repo);
  }
}

/**
 * Remove the staging earlier releases named `<cache>.<uuid>.fresh` (plus its
 * journal) and never cleaned up after an interrupted fresh sync. Those runs
 * held no lock, so a pair is only removed once neither file has changed for
 * an hour; a run still writing touches its journal with every page.
 */
export function removeAbandonedStaging(path: string, now = Date.now()): void {
  const directory = dirname(path);
  if (!existsSync(directory)) return;
  const prefix = `${basename(path)}.`;
  const names = readdirSync(directory);
  for (const name of names) {
    const uuid = name.startsWith(prefix) ? name.slice(prefix.length, -'.fresh'.length) : '';
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(uuid) || !name.endsWith('.fresh')) {
      continue;
    }
    const pair = [name, `${name}.journal`].filter((file) => names.includes(file));
    const touched = Math.max(...pair.map((file) => statSync(join(directory, file)).mtimeMs));
    if (now - touched > HOUR) {
      for (const file of pair) rmSync(join(directory, file), { force: true });
    }
  }
}
