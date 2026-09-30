import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cacheDir, secureCacheDirectory, storePath } from './paths.ts';

const legacy = (repo = 'acme/widgets') =>
  JSON.stringify({ repo, syncedAt: '2026-01-01T00:00:00Z', prs: {} });

/** A 0775 directory holding `files`, keyed by relative path. */
function setup(files: Record<string, string>): string {
  const parent = mkdtempSync(join(tmpdir(), 'bilan-legacy-'));
  chmodSync(parent, 0o775);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(parent, path, '..'), { recursive: true });
    writeFileSync(join(parent, path), contents);
  }
  return parent;
}

describe('paths', () => {
  it.skipIf(process.platform === 'win32')(
    'tightens an existing cache root without changing its parent',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'bilan-cache-'));
      const directory = join(parent, 'cache');
      try {
        chmodSync(parent, 0o755);
        secureCacheDirectory({ BILAN_CACHE_DIR: directory });
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        chmodSync(directory, 0o755);
        secureCacheDirectory({ BILAN_CACHE_DIR: directory });
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(parent).mode & 0o777).toBe(0o755);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
  it('honours BILAN_CACHE_DIR', () => {
    expect(storePath({ owner: 'acme', name: 'widgets' }, { BILAN_CACHE_DIR: '/tmp/b' })).toBe(
      '/tmp/b/acme/widgets.json',
    );
  });

  it('falls back to XDG_CACHE_HOME', () => {
    expect(cacheDir({ XDG_CACHE_HOME: '/x' })).toBe('/x/bilan');
  });

  it('treats empty cache environment values as unset', () => {
    expect(cacheDir({ BILAN_CACHE_DIR: '', XDG_CACHE_HOME: '/x' })).toBe('/x/bilan');
    expect(cacheDir({ BILAN_CACHE_DIR: '', XDG_CACHE_HOME: '' })).toBe(cacheDir({}));
  });

  it.skipIf(process.platform === 'win32')(
    'leaves an unrelated existing directory and its permissions alone',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'bilan-shared-'));
      try {
        chmodSync(parent, 0o775);
        writeFileSync(join(parent, 'important.txt'), 'keep');
        expect(() => secureCacheDirectory({ BILAN_CACHE_DIR: parent })).toThrow(
          /dedicated cache directory/,
        );
        expect(statSync(parent).mode & 0o777).toBe(0o775);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  describe('caches written before the ownership marker', () => {
    it.skipIf(process.platform === 'win32')('adopts a directory of bilan snapshots', () => {
      const parent = setup({
        'acme/widgets.json': legacy(),
        'acme/widgets.json.journal': '',
        'Other/Thing.json': legacy('other/thing'),
      });
      try {
        secureCacheDirectory({ BILAN_CACHE_DIR: parent });
        expect(statSync(parent).mode & 0o777).toBe(0o700);
        expect(existsSync(join(parent, '.bilan-cache'))).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it
      .skipIf(process.platform === 'win32')
      .each([
        { 'project/settings.json': '{"important":true}' },
        { 'project/settings.json': legacy('someone/else') },
        { 'acme/widgets.json': legacy(), 'project/settings.json': '{"repo":"project/settings"}' },
        { 'acme/widgets.json': 'not json' },
        { 'acme/widgets.json.journal': '' },
        { 'acme/empty/.keep': '' },
      ])('refuses unrelated JSON before changing permissions: %j', (files) => {
      const parent = setup(files);
      try {
        expect(() => secureCacheDirectory({ BILAN_CACHE_DIR: parent })).toThrow(
          /dedicated cache directory/,
        );
        expect(statSync(parent).mode & 0o777).toBe(0o775);
        expect(existsSync(join(parent, '.bilan-cache'))).toBe(false);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  it.each([
    { owner: '..', name: 'victim' },
    { owner: '.', name: 'victim' },
    { owner: 'acme', name: '../../victim' },
    { owner: '/tmp', name: 'victim' },
  ])('rejects unsafe store references before accessing files: %j', (repo) => {
    expect(() => storePath(repo, { BILAN_CACHE_DIR: '/tmp/cache' })).toThrow();
  });
});
