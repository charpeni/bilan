export const STALE_AFTER_MS = 60 * 60 * 1000;

/** A payload is stale once its sync is older than an hour. */
export function isStale(syncedAt: string | null, now: number = Date.now()): boolean {
  if (syncedAt === null) return true;
  const at = Date.parse(syncedAt);
  return Number.isNaN(at) || now - at > STALE_AFTER_MS;
}

/**
 * Whether the page should kick off a background refresh: the payload is stale,
 * or the last run never completed (a budget-cut `partial` run, or one that
 * crashed) and so left the in-flight marker (`sync_started_at`) in place.
 * The refresh then reaches back to the last complete run (`reconciledAt`).
 */
export function needsRefresh(
  repo: { lastSyncedAt: string | null; syncStartedAt: string | null },
  now: number = Date.now(),
): boolean {
  return isStale(repo.lastSyncedAt, now) || repo.syncStartedAt !== null;
}
