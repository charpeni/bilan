import { depthToSince } from './depth.ts';

import type { SyncDepth } from './depth.ts';

export const SYNC_LIMIT_TTL_S = 10 * 60;

export interface SyncLimitCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Per requester, per repo. Anonymous requests (example repo only) share one bucket. */
export function syncLimitKey(requester: number | 'anon', repoId: string): string {
  return `sync-limit:${requester}:${repoId}`;
}

export type SyncLimitDecision = { limited: false } | { limited: true; retryAfter: number };

/**
 * A repeat sync of the same repo by the same requester within the window is
 * refused, unless it reaches further back than what the store already covers:
 * deepening from 30d to 90d is real work, a second 30d click is not.
 */
export function syncLimitDecision(input: {
  /** Epoch ms when the limit lifts, or null when no limit is recorded. */
  limitedUntil: number | null;
  depth: SyncDepth;
  coverage: { syncedAt: string | null; coverageSince: string | null };
  now?: number;
}): SyncLimitDecision {
  const now = input.now ?? Date.now();
  if (input.limitedUntil === null || input.limitedUntil <= now) return { limited: false };
  if (isDeeperThanCoverage(input.depth, input.coverage, now)) return { limited: false };
  return { limited: true, retryAfter: Math.max(1, Math.ceil((input.limitedUntil - now) / 1000)) };
}

/**
 * Whether `depth` reaches earlier than the store's current coverage. A repo
 * that has never been synced covers nothing, so any depth is deeper; full
 * coverage (`coverageSince: null` after a sync) cannot be deepened.
 */
export function isDeeperThanCoverage(
  depth: SyncDepth,
  coverage: { syncedAt: string | null; coverageSince: string | null },
  now: number = Date.now(),
): boolean {
  if (coverage.syncedAt === null) return true;
  if (coverage.coverageSince === null) return false;
  const target = depthToSince(depth, new Date(now));
  if (target === undefined) return true;
  return target.getTime() < Date.parse(coverage.coverageSince);
}

/** Read the limit for a requester; `null` when none is recorded or it has lapsed. */
export async function readSyncLimit(
  cache: SyncLimitCache,
  requester: number | 'anon',
  repoId: string,
): Promise<number | null> {
  const value = await cache.get(syncLimitKey(requester, repoId));
  if (value === null) return null;
  const until = Number(value);
  return Number.isFinite(until) ? until : null;
}

export async function recordSyncLimit(
  cache: SyncLimitCache,
  requester: number | 'anon',
  repoId: string,
  now: number = Date.now(),
): Promise<void> {
  await cache.put(syncLimitKey(requester, repoId), String(now + SYNC_LIMIT_TTL_S * 1000), {
    expirationTtl: SYNC_LIMIT_TTL_S,
  });
}
