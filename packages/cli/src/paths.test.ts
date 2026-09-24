import { describe, expect, it } from 'vitest';

import { cacheDir, storePath } from './paths.ts';

describe('paths', () => {
  it('honours BILAN_CACHE_DIR', () => {
    expect(storePath({ owner: 'acme', name: 'widgets' }, { BILAN_CACHE_DIR: '/tmp/b' })).toBe(
      '/tmp/b/acme/widgets.json',
    );
  });

  it('falls back to XDG_CACHE_HOME', () => {
    expect(cacheDir({ XDG_CACHE_HOME: '/x' })).toBe('/x/bilan');
  });
});
