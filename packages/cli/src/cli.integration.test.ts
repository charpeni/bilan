import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStore } from '@bilan/store-file';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rawPr } from '../../core/src/testing/fixtures.ts';
import { main } from './cli.ts';

vi.mock('./report.ts', () => ({ renderReport: (payload: unknown) => JSON.stringify(payload) }));

describe('CLI cache and report lifecycle', () => {
  let dir: string;
  let cache: string;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bilan-cli-test-'));
    cache = join(dir, 'cache');
    out = join(dir, 'report.html');
    vi.stubEnv('BILAN_CACHE_DIR', cache);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns when rendering an interrupted cache offline', async () => {
    const store = new FileStore(join(cache, 'acme/widgets.json'), 'acme/widgets');
    await store.markStarted('2026-01-01T00:00:00Z');
    await store.upsert([rawPr()]);
    await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
    await store.markStarted('2026-02-01T00:00:00Z');
    expect(await main(['acme/widgets', '--offline', '--out', out])).toBe(0);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringMatching(/Partial sync:.*stale/),
    );
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
      interrupted: true,
      reconciledAt: '2026-01-01T00:00:00Z',
    });
  });
});
