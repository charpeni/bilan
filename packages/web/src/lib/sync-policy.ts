import { depthToSince } from './depth.ts';

import type { SyncDepth } from './depth.ts';

export const SYNC_LIMIT_TTL_S = 10 * 60;

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
