import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStore } from '@bilan/store-file';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rawPr } from '../../core/src/testing/fixtures.ts';
import { FakeGithub } from '../../core/src/testing/github.ts';
import { timelineGithub } from '../../core/src/testing/timeline.ts';
import { main } from './cli.ts';

vi.mock('./report.ts', () => ({ renderReport: (payload: unknown) => JSON.stringify(payload) }));

/** GitHub's GraphQL rate-limit answer, with a reset half an hour away. */
const rateLimited = () =>
  new Response(
    JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }),
    {
      headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) },
    },
  );

/** A secondary rate limit on the second request: the first review-request follow-up. */
const secondaryLimit = (call: number) =>
  call === 2
    ? new Response('{"message":"You have exceeded a secondary rate limit"}', {
        status: 403,
        headers: { 'retry-after': '1800' },
      })
    : undefined;

/** A complete cache of PRs 1..60 as a full walk left it, one page still in the journal. */
async function completeCache(path: string): Promise<void> {
  const store = new FileStore(path, 'acme/widgets');
  await store.markStarted('2026-01-01T00:00:00Z');
  await store.upsert(Array.from({ length: 50 }, (_, i) => rawPr({ number: i + 1 })));
  await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
  await store.markStarted('2026-01-03T00:00:00Z');
  await store.upsert(Array.from({ length: 10 }, (_, i) => rawPr({ number: i + 51 })));
  await store.markSynced('2026-01-04T00:00:00Z', null, true, true);
  await store.markStarted('2026-01-05T00:00:00Z');
  await store.upsert([rawPr({ number: 60, title: 'journaled' })]);
}

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

  it('renders a cache written under another spelling of the repository', async () => {
    // A case-insensitive filesystem opens `microsoft/typescript.json` for
    // either spelling; emulate that by writing the other spelling there.
    const store = new FileStore(join(cache, 'microsoft/typescript.json'), 'microsoft/TypeScript');
    await store.markStarted('2026-01-01T00:00:00Z');
    await store.upsert([rawPr()]);
    await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
    expect(await main(['microsoft/typescript', '--offline', '--out', out])).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
      repo: 'microsoft/typescript',
      prs: [expect.anything()],
    });
  });

  it.each(['1', '2026-02-30', '2999-01-01', 'not-a-date'])(
    'rejects invalid since date %s even offline',
    async (since) => {
      await expect(
        main(['acme/widgets', '--offline', '--since', since, '--out', out]),
      ).rejects.toThrow(/--since/);
      expect(existsSync(cache)).toBe(false);
    },
  );

  it('rejects conflicting history options', async () => {
    await expect(
      main(['acme/widgets', '--offline', '--full', '--since', '2025-01-01']),
    ).rejects.toThrow(/--full.*--since/);
    expect(existsSync(cache)).toBe(false);
  });

  it.each([['--full'], ['--since', '2025-01-01'], ['--max-prs', '5'], ['--token', 'test-token']])(
    'rejects the sync option %s offline before touching the cache',
    async (...option) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(main(['acme/widgets', '--offline', ...option, '--out', out])).rejects.toThrow(
        `--offline does not sync, so it cannot be combined with ${option[0]}.`,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(cache)).toBe(false);
      expect(existsSync(out)).toBe(false);
    },
  );

  it('ignores environment tokens offline', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'env-token');
    const store = new FileStore(join(cache, 'acme/widgets.json'), 'acme/widgets');
    await store.markStarted('2026-01-01T00:00:00Z');
    await store.upsert([rawPr()]);
    await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
    expect(await main(['acme/widgets', '--offline', '--out', out])).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).prs).toHaveLength(1);
  });

  it('reports the points of a page interrupted while following review requests', async () => {
    const path = join(cache, 'acme/widgets.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markStarted('2026-01-01T00:00:00Z');
    await store.upsert([rawPr({ number: 7 })]);
    await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
    const { fetch } = timelineGithub({
      events: 305,
      fail: (call) =>
        call === 3
          ? new Response('{"message":"You have exceeded a secondary rate limit"}', {
              status: 403,
              headers: { 'retry-after': '600' },
            })
          : undefined,
    });
    vi.stubGlobal('fetch', fetch);
    expect(await main(['acme/widgets', '--full', '--token', 'test-token', '--out', out])).toBe(0);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringMatching(/^rate limit low, resets at .* · 2 points spent\n$/),
    );
    expect(new FileStore(path, 'acme/widgets').size).toBe(1);
  });

  describe('a first sync that stores nothing', () => {
    it.each([
      ['on the first page', vi.fn(async () => rateLimited())],
      [
        "while following the first page's review requests",
        timelineGithub({ events: 205, fail: secondaryLimit }).fetch,
      ],
    ])('fails with the reset time and leaves no cache when limited %s', async (_, fetch) => {
      vi.stubGlobal('fetch', fetch);
      await expect(main(['acme/widgets', '--token', 'test-token', '--out', out])).rejects.toThrow(
        /^Sync stopped before fetching any pull requests; GitHub's rate limit resets at \d{4}-/,
      );
      expect(existsSync(join(cache, 'acme'))).toBe(false);
      expect(existsSync(out)).toBe(false);
    });

    it('also removes a cache an earlier run created without ever finishing', async () => {
      const path = join(cache, 'acme/widgets.json');
      await new FileStore(path, 'acme/widgets').markStarted('2026-01-01T00:00:00Z');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => rateLimited()),
      );
      await expect(main(['acme/widgets', '--token', 'test-token', '--out', out])).rejects.toThrow(
        /stopped before fetching any pull requests/,
      );
      expect(existsSync(path)).toBe(false);
    });

    it('keeps and reports an existing cache instead', async () => {
      const path = join(cache, 'acme/widgets.json');
      const store = new FileStore(path, 'acme/widgets');
      await store.markStarted('2026-01-01T00:00:00Z');
      await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => rateLimited()),
      );
      expect(await main(['acme/widgets', '--token', 'test-token', '--out', out])).toBe(0);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ interrupted: true, prs: [] });
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringMatching(/partial run; run again to finish/),
      );
    });
  });

  it.each(['missing', 'directory', 'empty'])(
    'rejects an invalid output path before syncing: %s',
    async (kind) => {
      const target =
        kind === 'missing' ? join(dir, 'missing/report.html') : kind === 'directory' ? dir : '';
      const fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
      vi.stubGlobal('fetch', fetch);
      await expect(
        main(['acme/widgets', '--token', 'test-token', '--out', target]),
      ).rejects.toThrow(/--out/);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(cache)).toBe(false);
    },
  );

  it('removes an empty newly created cache when the repository is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { repository: null },
              errors: [{ type: 'NOT_FOUND', message: 'Not found' }],
            }),
          ),
      ),
    );
    await expect(main(['acme/missing', '--token', 'test-token', '--out', out])).rejects.toThrow(
      /not found/i,
    );
    expect(existsSync(join(cache, 'acme/missing.json'))).toBe(false);
    expect(existsSync(join(cache, 'acme'))).toBe(false);
  });

  it.each([null, {}, { known: 'src' }, { known: [42] }, { known: ['src/lib'] }, { known: [''] }])(
    'rejects malformed area rules before syncing: %j',
    async (rules) => {
      const path = join(dir, 'areas.json');
      writeFileSync(path, JSON.stringify(rules));
      const fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
      vi.stubGlobal('fetch', fetch);
      await expect(
        main(['acme/widgets', '--token', 'test-token', '--areas', path, '--out', out]),
      ).rejects.toThrow(/--areas.*areas\.json/);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(cache)).toBe(false);
    },
  );

  it('exports a successfully synced empty repository, including offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
                rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-09-30T00:00:00Z' },
              },
            }),
          ),
      ),
    );
    expect(await main(['acme/empty', '--token', 'test-token', '--out', out])).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).prs).toEqual([]);
    expect(await main(['acme/empty', '--offline', '--out', out])).toBe(0);
  });

  it.each([401, 429])(
    'keeps the old snapshot and journal when a fresh sync fails with HTTP %i',
    async (status) => {
      const path = join(cache, 'acme/widgets.json');
      const store = new FileStore(path, 'acme/widgets');
      await store.markStarted('2026-01-01T00:00:00Z');
      await store.upsert([rawPr()]);
      const snapshot = readFileSync(path, 'utf8');
      const journal = readFileSync(`${path}.journal`, 'utf8');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{"message":"Bad credentials"}', { status })),
      );
      await expect(
        main(['acme/widgets', '--no-cache', '--token', 'rejected-token', '--out', out]),
      ).rejects.toThrow(/401|Bad credentials|rate limit/);
      expect(readFileSync(path, 'utf8')).toBe(snapshot);
      expect(readFileSync(`${path}.journal`, 'utf8')).toBe(journal);
      expect(new FileStore(path, 'acme/widgets').size).toBe(1);
      expect(readdirSync(join(cache, 'acme'))).toHaveLength(2);
    },
  );

  describe('a fresh sync that does not finish', () => {
    it.each([
      ['rate limited', [] as string[], /rate limit/],
      ['cut by --max-prs', ['--max-prs', '10'], /--max-prs/],
    ])('keeps the existing snapshot and journal when %s', async (_, flags, reason) => {
      const path = join(cache, 'acme/widgets.json');
      await completeCache(path);
      const snapshot = readFileSync(path, 'utf8');
      const journal = readFileSync(`${path}.journal`, 'utf8');
      const github = FakeGithub.history(60);
      github.fail = (call) =>
        call === 2
          ? new Response('{"message":"You have exceeded a secondary rate limit"}', {
              status: 403,
              headers: { 'retry-after': '600' },
            })
          : undefined;
      vi.stubGlobal('fetch', github.fetch);
      const args = ['acme/widgets', '--no-cache', '--full', '--token', 'test-token'];
      expect(await main([...args, ...flags, '--out', out])).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(snapshot);
      expect(readFileSync(`${path}.journal`, 'utf8')).toBe(journal);
      const report = JSON.parse(readFileSync(out, 'utf8'));
      expect(report.prs).toHaveLength(60);
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `fresh sync did not finish \\([^)]*${reason.source}.*kept the existing cache of 60 PRs`,
          ),
        ),
      );
    });

    it('replaces a cache that cannot be read with what it fetched', async () => {
      const path = join(cache, 'acme/widgets.json');
      mkdirSync(join(cache, 'acme'), { recursive: true });
      writeFileSync(join(cache, '.bilan-cache'), 'bilan\n');
      writeFileSync(path, '{');
      const github = FakeGithub.history(60);
      github.fail = (call) => (call === 2 ? rateLimited() : undefined);
      vi.stubGlobal('fetch', github.fetch);
      expect(
        await main(['acme/widgets', '--no-cache', '--full', '--token', 'test-token', '--out', out]),
      ).toBe(0);
      expect(new FileStore(path, 'acme/widgets').size).toBe(25);
    });
  });

  it('replaces the snapshot and discards the old journal after a successful fresh sync', async () => {
    const path = join(cache, 'acme/empty.json');
    const store = new FileStore(path, 'acme/empty');
    await store.markStarted('2026-01-01T00:00:00Z');
    await store.upsert([rawPr()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
                rateLimit: { cost: 1, remaining: 5000, resetAt: '2026-09-30T00:00:00Z' },
              },
            }),
          ),
      ),
    );
    expect(await main(['acme/empty', '--no-cache', '--token', 'test-token', '--out', out])).toBe(0);
    expect(new FileStore(path, 'acme/empty').size).toBe(0);
    expect(existsSync(`${path}.journal`)).toBe(false);
  });
});
