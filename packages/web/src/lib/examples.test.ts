import { describe, expect, it } from 'vitest';

import {
  EXAMPLE_SYNC_STATUS,
  EXAMPLES,
  exampleAssetPath,
  exampleResponse,
  exampleSyncRefused,
  findExample,
  isExample,
} from './examples.ts';
import { SYNC_ACTIVE_HEADER, SYNCED_AT_HEADER, watchAfterSyncResponse } from './poll.ts';

import type { Example } from './examples.ts';
import type { Headline } from '@bilan/core';

const preview: Headline = {
  opened: 10,
  authors: 4,
  merged: 8,
  mergedShare: 0.8,
  rejected: 2,
  stillOpen: 0,
  medMerge: null,
  p90Merge: null,
  medFirst: null,
  reviewedShare: null,
  medReady: null,
  draftShare: null,
  reviews: 0,
  reviewers: 0,
};

const astro: Example = {
  owner: 'withastro',
  name: 'astro',
  repo: 'withastro/astro',
  snapshotAt: '2026-09-28T12:00:00.000Z',
  prs: 11000,
  coverageSince: null,
  openPrsSyncedAt: '2026-09-28T12:00:00.000Z',
  preview,
  sizeBytes: 700_000,
  blurb: 'The Astro web framework.',
};
const examples: readonly Example[] = [astro];

describe('the shipped index', () => {
  it('lists withastro/astro and cloudflare/workers-sdk, each with a blurb and a full-history snapshot', () => {
    expect(EXAMPLES.map((e) => e.repo)).toEqual(['withastro/astro', 'cloudflare/workers-sdk']);
    for (const example of EXAMPLES) {
      expect(example.blurb).not.toBe('');
      expect(example.coverageSince).toBeNull();
      expect(Number.isNaN(Date.parse(example.snapshotAt))).toBe(false);
      expect(example.prs).toBeGreaterThan(0);
      expect(example.sizeBytes).toBeGreaterThan(0);
      expect(example.preview.opened).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('findExample / isExample', () => {
  it('matches case-insensitively', () => {
    expect(findExample('WithAstro', 'Astro', examples)).toBe(astro);
    expect(isExample('withastro', 'astro', examples)).toBe(true);
    expect(isExample('withastro', 'starlight', examples)).toBe(false);
    expect(isExample('acme', 'astro', examples)).toBe(false);
  });

  it('resolves the built-in examples by default', () => {
    expect(isExample('withastro', 'astro')).toBe(true);
    expect(isExample('CLOUDFLARE', 'Workers-SDK')).toBe(true);
    expect(isExample('acme', 'other')).toBe(false);
  });
});

describe('exampleAssetPath', () => {
  it('spells the file with the canonical casing, whatever the request used', () => {
    expect(exampleAssetPath('WithAstro', 'ASTRO', examples)).toBe(
      '/examples/withastro--astro.json.gz',
    );
    expect(exampleAssetPath('acme', 'other', examples)).toBeNull();
  });
});

/** What `env.ASSETS.fetch` answers for a shipped `.json.gz`. */
const asset = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'content-type': 'application/gzip', etag: '"abc"' },
  });

describe('exampleResponse', () => {
  it('serves the asset as a gzipped payload with the snapshot as synced-at, public and cacheable', async () => {
    const response = exampleResponse(astro, asset(), 'GET');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get(SYNCED_AT_HEADER)).toBe(astro.snapshotAt);
    expect(response.headers.get('x-bilan-stale')).toBe('0');
    expect(response.headers.get(SYNC_ACTIVE_HEADER)).toBe('0');
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('answers HEAD with the same headers and no body', async () => {
    const response = exampleResponse(astro, asset(), 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get(SYNCED_AT_HEADER)).toBe(astro.snapshotAt);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('is a 404 when the asset is missing', async () => {
    const response = exampleResponse(astro, new Response(null, { status: 404 }), 'GET');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: 'example payload missing; rebuild the examples',
    });
  });
});

describe('exampleSyncRefused', () => {
  it('refuses with a status the page never mistakes for a running sync', async () => {
    const response = exampleSyncRefused();
    expect(response.status).toBe(EXAMPLE_SYNC_STATUS);
    expect(response.status).not.toBe(409);
    const body = (await response.json()) as { message?: string; jobId?: string };
    expect(body).toEqual({ message: 'built-in example; not synced live' });
    expect(watchAfterSyncResponse(response.status, body, null)).toBeNull();
  });
});
