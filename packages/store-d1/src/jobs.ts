import { and, eq, inArray, sql } from 'drizzle-orm';

import { syncJobs } from './schema.ts';

import type { Db } from './db.ts';

/** Every job has a bounded page budget; these limits bound admitted work as well. */
export const SYNC_CAPACITY = {
  userConcurrent: 2,
  userDaily: 20,
  globalConcurrent: 20,
  globalDaily: 200,
} as const;

export interface SyncAdmission {
  id: string;
  repoId: string;
  requestedBy: number;
  mode: 'incremental' | 'full';
  maxPrs: number | null;
  createdAt: string;
  /** Null permits a deeper sync; aggregate quotas still apply. */
  cooldownAfter: string | null;
}

/**
 * Reserve capacity and the repository in one SQLite write statement. A separate
 * read followed by INSERT races across Worker isolates, and KV is eventually
 * consistent. All job creation goes through this conditional insert.
 *
 * Terminal rows stop consuming concurrent capacity, but failed attempts still
 * count against the rolling 24-hour budget. Rows are retained longer than that
 * window by repository retention.
 */
export async function admitSyncJob(db: Db, job: SyncAdmission): Promise<boolean> {
  const dayStart = new Date(Date.parse(job.createdAt) - 24 * 3600e3).toISOString();
  const admitted = await db.get<{ id: string }>(sql`
    INSERT INTO sync_jobs (id, repo_id, requested_by, mode, max_prs, status, created_at)
    SELECT ${job.id}, ${job.repoId}, ${job.requestedBy}, ${job.mode}, ${job.maxPrs}, 'queued', ${job.createdAt}
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_jobs WHERE repo_id = ${job.repoId} AND status IN ('queued', 'running')
    )
    AND (SELECT count(*) FROM sync_jobs WHERE requested_by = ${job.requestedBy}
      AND status IN ('queued', 'running')) < ${SYNC_CAPACITY.userConcurrent}
    AND (SELECT count(*) FROM sync_jobs WHERE requested_by = ${job.requestedBy}
      AND created_at > ${dayStart}) < ${SYNC_CAPACITY.userDaily}
    AND (SELECT count(*) FROM sync_jobs WHERE status IN ('queued', 'running')) < ${SYNC_CAPACITY.globalConcurrent}
    AND (SELECT count(*) FROM sync_jobs WHERE created_at > ${dayStart}) < ${SYNC_CAPACITY.globalDaily}
    AND (${job.cooldownAfter} IS NULL OR NOT EXISTS (
      SELECT 1 FROM sync_jobs WHERE requested_by = ${job.requestedBy} AND repo_id = ${job.repoId}
        AND created_at > ${job.cooldownAfter}
    ))
    RETURNING id
  `);
  return admitted !== undefined;
}

/** Fence delayed workflow starts against a reservation that was already retired. */
export function beginSyncJob(db: Db, id: string, now: string) {
  return db
    .update(syncJobs)
    .set({ status: 'running', progressAt: now })
    .where(and(eq(syncJobs.id, id), inArray(syncJobs.status, ['queued', 'running'])))
    .returning()
    .get();
}
