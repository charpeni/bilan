import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lockStaging, openStaging, removeAbandonedStaging } from './staging.ts';

import type * as NodeFs from 'node:fs';

// Lets a test run code at the moment the lock is read.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

/** The pid of a process that has already exited. */
function exitedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!;
}

describe('fresh sync staging', () => {
  let dir: string;
  let staging: string;
  let lock: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bilan-staging-'));
    staging = join(dir, 'acme/widgets.json.fresh');
    lock = `${staging}.lock`;
  });
  afterEach(() => {
    vi.mocked(readdirSync).mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Record `pid` on `host` as the holder of the lock, as its process would. */
  function holdAs(pid: number, host = hostname()): string {
    const entry = join(lock, `${pid}.${randomUUID()}.${encodeURIComponent(host)}`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(entry, '');
    return entry;
  }

  it('lets one fresh sync at a time hold the lock', () => {
    const release = lockStaging(staging);
    expect(readdirSync(lock)).toEqual([
      expect.stringMatching(new RegExp(`^${process.pid}\\.[\\da-f-]{36}\\.`)),
    ]);
    expect(() => lockStaging(staging)).toThrow(
      new RegExp(`Another fresh sync of this repository is running \\(process ${process.pid} `),
    );
    release();
    expect(existsSync(lock)).toBe(false);
    lockStaging(staging)();
  });

  it('takes over a lock whose process is gone', () => {
    const dead = holdAs(exitedPid());
    const release = lockStaging(staging);
    expect(existsSync(dead)).toBe(false);
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over the lock once its holder is killed, and not before', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      holdAs(child.pid!);
      expect(() => lockStaging(staging)).toThrow(`(process ${child.pid} ${hostname()})`);
    } finally {
      child.kill('SIGKILL');
    }
    await exited;
    const release = lockStaging(staging);
    expect(readdirSync(lock)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}\\.`))]);
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it('lets only one of two runs take over the same abandoned lock', () => {
    holdAs(exitedPid());
    let first: (() => void) | undefined;
    // The second run reads the dead holder, then the first run takes it
    // over before the second one acts on what it read.
    vi.mocked(readdirSync).mockImplementationOnce(((path: string) => {
      const seen = readdirSync(path);
      first = lockStaging(staging);
      return seen;
    }) as typeof readdirSync);
    expect(() => lockStaging(staging)).toThrow(`(process ${process.pid} ${hostname()})`);
    expect(first).toBeDefined();
    const [holder] = readdirSync(lock);
    expect(readdirSync(lock)).toEqual([holder]);
    expect(() => lockStaging(staging)).toThrow(/is running/);
    first!();
    expect(existsSync(lock)).toBe(false);
  });

  it('backs off when another run names itself in the lock at the same time', () => {
    // Another run still alive, e.g. one that created the directory before
    // it was taken for abandoned, names itself right after this one.
    let other = '';
    vi.mocked(readdirSync).mockImplementationOnce(((path: string) => {
      other = holdAs(process.ppid);
      return readdirSync(path);
    }) as typeof readdirSync);
    expect(() => lockStaging(staging)).toThrow(`(process ${process.ppid} ${hostname()})`);
    expect(readdirSync(lock)).toEqual([other.slice(lock.length + 1)]);
  });

  it('releases only its own hold on the lock', () => {
    const release = lockStaging(staging);
    // Taken over as if this process had been reported gone.
    rmSync(lock, { recursive: true });
    const other = holdAs(process.ppid);
    release();
    expect(existsSync(other)).toBe(true);
    expect(() => lockStaging(staging)).toThrow(/is running/);
  });

  it('does not take over a lock from another host, one it did not write, or a fresh empty one', () => {
    const foreign = holdAs(exitedPid(), 'elsewhere.example');
    expect(() => lockStaging(staging)).toThrow(
      /is running \(process \d+ elsewhere\.example\)\. .*remove ".*widgets\.json\.fresh\.lock"/,
    );
    expect(existsSync(foreign)).toBe(true);
    rmSync(lock, { recursive: true });

    mkdirSync(lock);
    writeFileSync(join(lock, 'notes.txt'), '');
    expect(() => lockStaging(staging)).toThrow(/is running \(process unknown\)/);
    expect(existsSync(join(lock, 'notes.txt'))).toBe(true);
    rmSync(lock, { recursive: true });

    // Its creator was killed before naming itself.
    mkdirSync(lock);
    expect(() => lockStaging(staging)).toThrow(/is running \(process unknown\)/);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    lockStaging(staging)();
    expect(existsSync(lock)).toBe(false);
  });

  it('reports a lock it cannot read instead of taking it for released', () => {
    mkdirSync(lock, { recursive: true });
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    expect(() => lockStaging(staging)).toThrow(/EACCES/);
    expect(existsSync(lock)).toBe(true);
  });

  it('discards staging that cannot be read', () => {
    mkdirSync(join(dir, 'acme'));
    writeFileSync(staging, '{');
    writeFileSync(`${staging}.journal`, 'x');
    expect(openStaging(staging, 'acme/widgets').size).toBe(0);
    expect(existsSync(staging)).toBe(false);
  });

  it('removes staging older releases left behind once it has been idle for an hour', () => {
    const owner = join(dir, 'acme');
    mkdirSync(owner);
    const idle = 'widgets.json.0f8fad5b-d9cb-469f-a165-70867728950e.fresh';
    const active = 'widgets.json.7c9e6679-7425-40de-944b-e07fc1f90ae7.fresh';
    const keep = [
      'widgets.json',
      'widgets.json.journal',
      'widgets.json.fresh',
      'other.json.0f8fad5b-d9cb-469f-a165-70867728950e.fresh',
      active,
      `${active}.journal`,
    ];
    for (const name of [...keep, idle, `${idle}.journal`]) writeFileSync(join(owner, name), '');
    const now = Date.now();
    const old = new Date(now - 2 * 3_600_000);
    for (const name of [idle, `${idle}.journal`, active, ...keep]) {
      utimesSync(join(owner, name), old, old);
    }
    // A writer still appending pages keeps its journal fresh.
    utimesSync(join(owner, `${active}.journal`), new Date(now), new Date(now));
    removeAbandonedStaging(join(owner, 'widgets.json'), now);
    expect(readdirSync(owner).toSorted()).toEqual(keep.toSorted());
  });
});
