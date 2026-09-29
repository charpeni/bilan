import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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
});
