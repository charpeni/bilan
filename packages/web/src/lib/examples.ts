import index from '../../public/examples/index.json';
import { json } from './http.ts';
import { SYNC_ACTIVE_HEADER, SYNCED_AT_HEADER } from './poll.ts';

import type { Headline } from '@bilan/core';

/**
 * One entry of `public/examples/index.json`, as `scripts/build-examples.mjs`
 * writes it: a full-history snapshot of a public repository, shipped with the
 * app as a static gzipped payload so the example dashboards work with no
 * token, no database row, no cron, and no login.
 */
export interface ExampleEntry {
  owner: string;
  name: string;
  /** `owner/name` as GitHub spells it. */
  repo: string;
  /** When the snapshot was taken; the payload's `syncedAt`. */
  snapshotAt: string;
  /** Number of PRs in the payload. */
  prs: number;
  /** Always null: examples cover the full history. */
  coverageSince: string | null;
  openPrsSyncedAt: string | null;
  /** The last-30-days headline, computed like the dashboard's default view. */
  preview: Headline;
  /** Size of the gzipped payload. */
  sizeBytes: number;
}

export interface Example extends ExampleEntry {
  blurb: string;
}

/** One line per example for the landing page; keyed by lower-cased `owner/name`. */
const BLURBS: Record<string, string> = {
  'withastro/astro':
    'The Astro web framework: a large monorepo with a core team and a long tail of community contributors.',
  'cloudflare/workers-sdk':
    'Wrangler and the Workers SDK: a busy monorepo where bots open a fair share of the pull requests.',
};

function withBlurb(entry: ExampleEntry): Example {
  return { ...entry, blurb: BLURBS[entry.repo.toLowerCase()] ?? '' };
}

export const EXAMPLES: readonly Example[] = (index as ExampleEntry[]).map(withBlurb);

/** The example at `owner/name` (case-insensitively), or undefined. */
export function findExample(
  owner: string,
  name: string,
  examples: readonly Example[] = EXAMPLES,
): Example | undefined {
  const wanted = `${owner}/${name}`.toLowerCase();
  return examples.find((example) => example.repo.toLowerCase() === wanted);
}

export function isExample(owner: string, name: string, examples?: readonly Example[]): boolean {
  return findExample(owner, name, examples) !== undefined;
}

/**
 * Path of the example's static payload under `public/`, spelled as the index
 * has it (the file name keeps the canonical casing); null when `owner/name`
 * is not an example.
 */
export function exampleAssetPath(
  owner: string,
  name: string,
  examples?: readonly Example[],
): string | null {
  const example = findExample(owner, name, examples);
  if (!example) return null;
  return `/examples/${encodeURIComponent(example.owner)}--${encodeURIComponent(example.name)}.json.gz`;
}

/**
 * The payload endpoint's answer for an example, wrapped around the static
 * asset: the same headers as a synced repository's payload, with the snapshot
 * instant as `x-bilan-synced-at`, never stale, never syncing. Public and
 * cacheable, since the bytes are the same for everyone. `HEAD` answers the
 * headers alone, so polling never downloads the payload.
 */
export function exampleResponse(
  example: Example,
  asset: Response,
  method: 'GET' | 'HEAD',
): Response {
  if (!asset.ok) {
    void asset.body?.cancel();
    return json({ message: 'example payload missing; rebuild the examples' }, 404, {
      'cache-control': 'no-store',
    });
  }
  const etag = asset.headers.get('etag');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
    'cache-control': 'public, max-age=3600',
    [SYNCED_AT_HEADER]: example.snapshotAt,
    'x-bilan-stale': '0',
    [SYNC_ACTIVE_HEADER]: '0',
    ...(etag === null ? {} : { etag }),
  };
  let body: ReadableStream | null = asset.body;
  if (method === 'HEAD') {
    void body?.cancel();
    body = null;
  }
  return new Response(body, { status: 200, encodeBody: 'manual', headers });
}

/**
 * Status of `POST /api/repos/:owner/:name/sync` for an example. Not 409: the
 * page reads a 409 as "someone's sync is running, watch the payload", and an
 * example never has one.
 */
export const EXAMPLE_SYNC_STATUS = 405;

export function exampleSyncRefused(): Response {
  return json({ message: 'built-in example; not synced live' }, EXAMPLE_SYNC_STATUS, {
    allow: 'GET, HEAD',
    'cache-control': 'no-store',
  });
}
