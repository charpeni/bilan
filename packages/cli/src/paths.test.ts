import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cacheDir, secureCacheDirectory, storePath } from './paths.ts';

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

  it.each([
    { owner: '..', name: 'victim' },
    { owner: '.', name: 'victim' },
    { owner: 'acme', name: '../../victim' },
    { owner: '/tmp', name: 'victim' },
  ])('rejects unsafe store references before accessing files: %j', (repo) => {
    expect(() => storePath(repo, { BILAN_CACHE_DIR: '/tmp/cache' })).toThrow();
  });
});
