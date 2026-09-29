import { and, desc, eq, gte, max, ne, notExists, or, sql } from 'drizzle-orm';

import { STALE_OWNER } from './repos.ts';
import { pullRequests, repos, repoViews, syncJobs } from './schema.ts';

import type { Db } from './db.ts';

export interface RepoViewRow {
  repoId: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  lastViewedAt: string;
  lastSyncedAt: string | null;
  coverageSince: string | null;
  /** See `repos.sync_started_at`: set while a run is in flight (or was cut short). */
  syncStartedAt: string | null;
}

/** Record that `userId` opened `repoId` now. */
export async function touchRepoView(
  db: Db,
  view: { repoId: string; userId: number; now: string },
): Promise<void> {
  await db
    .insert(repoViews)
    .values({ repoId: view.repoId, userId: view.userId, lastViewedAt: view.now })
    .onConflictDoUpdate({
      target: [repoViews.repoId, repoViews.userId],
      set: { lastViewedAt: view.now },
    });
}

/**
 * Every repo a user has opened, most recent first. Rows parked under
 * `STALE_OWNER` are left out: their `owner/name` is a placeholder, so nothing
 * built from it would navigate anywhere.
 */
export async function listRepoViews(db: Db, userId: number): Promise<RepoViewRow[]> {
  return db
    .select({
      repoId: repoViews.repoId,
      owner: repos.owner,
      name: repos.name,
      isPrivate: repos.isPrivate,
      lastViewedAt: repoViews.lastViewedAt,
      lastSyncedAt: repos.lastSyncedAt,
      coverageSince: repos.coverageSince,
      syncStartedAt: repos.syncStartedAt,
    })
    .from(repoViews)
    .innerJoin(repos, eq(repoViews.repoId, repos.id))
    .where(and(eq(repoViews.userId, userId), ne(repos.owner, STALE_OWNER)))
    .orderBy(desc(repoViews.lastViewedAt))
    .all();
}

export interface RepoLastView {
  id: string;
  isPrivate: boolean;
  /** True for rows parked under `STALE_OWNER` after another repo took their name. */
  parked: boolean;
  /** Most recent `repo_views.last_viewed_at`, or null when nobody has opened it. */
  lastViewedAt: string | null;
}

/**
 * Every repo with the instant it was last opened by anyone; feeds the
 * retention cron. Parked rows (`STALE_OWNER`) are not listed.
 */
export async function listReposWithLastView(db: Db): Promise<RepoLastView[]> {
  return db
    .select({
      id: repos.id,
      isPrivate: repos.isPrivate,
      owner: repos.owner,
      lastViewedAt: max(repoViews.lastViewedAt),
    })
    .from(repos)
    .leftJoin(repoViews, eq(repoViews.repoId, repos.id))
    .groupBy(repos.id)
    .all()
    .then((rows) => rows.map(({ owner, ...row }) => ({ ...row, parked: owner === STALE_OWNER })));
}

/**
 * Remove a repo and everything hanging off it. The foreign keys cascade, but
 * the children are deleted explicitly so the outcome does not depend on D1's
 * `foreign_keys` pragma.
 */
export async function deleteRepo(db: Db, repoId: string): Promise<void> {
  await db.batch([
    db.delete(pullRequests).where(eq(pullRequests.repoId, repoId)),
    db.delete(syncJobs).where(eq(syncJobs.repoId, repoId)),
    db.delete(repoViews).where(eq(repoViews.repoId, repoId)),
    db.delete(repos).where(eq(repos.id, repoId)),
  ]);
}

/**
 * Remove a repo, but only while it is still expired: private (or parked under
 * `STALE_OWNER`) and not opened by anyone at or after `cutoff`. One
 * conditional statement on the parent row, never a read followed by a delete,
 * so a row that was restored or viewed between the retention scan and this
 * call survives. The children go in the same batch, each guarded on the
 * parent row being gone: a repo recreated under the same node id between the
 * statements keeps the rows its new sync wrote (they cascade when D1 enforces
 * foreign keys; deleted explicitly so the outcome does not depend on the
 * pragma). Returns whether the repo was deleted.
 */
/**
 * Is the repo still eligible for retention right now? Same predicate as
 * `deleteRepoIfExpired`; retention asks this immediately before touching R2 so
 * a repo restored or opened earlier in the sweep keeps its payloads.
 */
export async function repoExpired(db: Db, repoId: string, cutoff: string): Promise<boolean> {
  const viewedSinceCutoff = db
    .select({ one: sql`1` })
    .from(repoViews)
    .where(and(eq(repoViews.repoId, repoId), gte(repoViews.lastViewedAt, cutoff)));
  const row = await db
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(
        eq(repos.id, repoId),
        or(eq(repos.isPrivate, true), eq(repos.owner, STALE_OWNER)),
        notExists(viewedSinceCutoff),
      ),
    )
    .get();
  return row !== undefined;
}

export async function deleteRepoIfExpired(
  db: Db,
  repoId: string,
  cutoff: string,
): Promise<boolean> {
  const viewedSinceCutoff = db
    .select({ one: sql`1` })
    .from(repoViews)
    .where(and(eq(repoViews.repoId, repoId), gte(repoViews.lastViewedAt, cutoff)));
  const parentGone = notExists(
    db
      .select({ one: sql`1` })
      .from(repos)
      .where(eq(repos.id, repoId)),
  );
  const [parent] = await db.batch([
    db
      .delete(repos)
      .where(
        and(
          eq(repos.id, repoId),
          or(eq(repos.isPrivate, true), eq(repos.owner, STALE_OWNER)),
          notExists(viewedSinceCutoff),
        ),
      ),
    db.delete(pullRequests).where(and(eq(pullRequests.repoId, repoId), parentGone)),
    db.delete(syncJobs).where(and(eq(syncJobs.repoId, repoId), parentGone)),
    db.delete(repoViews).where(and(eq(repoViews.repoId, repoId), parentGone)),
  ]);
  return parent.meta.changes > 0;
}
