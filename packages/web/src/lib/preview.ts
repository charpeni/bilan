import {
  createFilterState,
  derive,
  headline,
  lastActivity,
  parseRepo,
  scope,
  windowed,
} from '@bilan/core';
import { getRepoByName } from '@bilan/store-d1';

import { getDb } from './db.ts';
import { dur, pct } from './format.ts';
import { gunzip } from './gzip.ts';
import { payloadKey } from './payload-key.ts';

import type { Payload } from '@bilan/core';

export interface PreviewTile {
  k: string;
  v: string;
  d: string;
}

export interface Preview {
  repo: string;
  syncedAt: string;
  tiles: PreviewTile[];
}

/** The tile labels the landing page shows while the example is not synced yet. */
export const PREVIEW_LABELS: readonly string[] = [
  'PRs opened',
  'Merged',
  'Median time to merge',
  'Median time to first review',
];

/** The last-30-days headline tiles of a payload, formatted like the dashboard's. */
export function previewTiles(payload: Payload): PreviewTile[] {
  const prs = derive(payload.prs);
  const last = lastActivity(prs);
  // The dashboard's default view: the last 30 days, bots excluded.
  const state = { ...createFilterState(), range: '30' };
  const w = windowed(scope(prs, new Set(payload.bots), state, last), last);
  const h = headline(w);
  return [
    { k: 'PRs opened', v: h.opened.toLocaleString(), d: `${h.authors} authors` },
    { k: 'Merged', v: h.merged.toLocaleString(), d: `${pct(h.mergedShare)} of resolved` },
    { k: 'Median time to merge', v: dur(h.medMerge), d: `p90 ${dur(h.p90Merge)} · from ready` },
    {
      k: 'Median time to first review',
      v: dur(h.medFirst),
      d: `${pct(h.reviewedShare)} ever reviewed`,
    },
  ];
}

/**
 * The example repo's headline, read from its published payload; null when it
 * is private, not synced yet, or anything on the way fails (the landing page
 * then shows skeleton tiles rather than an error).
 */
export async function examplePreview(
  env: Pick<Env, 'DB' | 'PAYLOADS' | 'EXAMPLE_REPO'>,
): Promise<Preview | null> {
  try {
    const ref = parseRepo(env.EXAMPLE_REPO);
    const repo = await getRepoByName(getDb(env), ref.owner, ref.name);
    if (!repo || repo.isPrivate || repo.lastSyncedAt === null) return null;
    const object = await env.PAYLOADS.get(payloadKey(repo.id, repo.lastSyncedAt));
    if (!object) return null;
    const payload = JSON.parse(await gunzip(await object.arrayBuffer())) as Payload;
    return { repo: payload.repo, syncedAt: repo.lastSyncedAt, tiles: previewTiles(payload) };
  } catch {
    return null;
  }
}
