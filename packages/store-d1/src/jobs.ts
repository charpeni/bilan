import { sql } from 'drizzle-orm';

import type { Db } from './db.ts';
import type { D1Database } from '@cloudflare/workers-types';

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
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  return admitted !== undefined;
}

/**
 * A change the sync model makes to one `sync_jobs` row (the domain's
 * `SyncJobUpdate`). Every field is an absolute value, so applying it twice
 * leaves the row as applying it once.
 */
export interface SyncJobChange {
  readonly jobId: string;
  readonly status?: 'running' | 'complete' | 'partial' | 'errored';
  readonly progressAt?: string;
  readonly pointsSpent?: number;
  readonly error?: string;
  readonly finishedAt?: string;
  /**
   * Insert the row first, ended, if admission has not: the late admission of
   * a request that expired then finds the id taken (`admitSyncJob`).
   */
  readonly orInsert?: {
    readonly repoId: string;
    readonly requestedBy: number;
    readonly mode: 'incremental' | 'full';
    readonly createdAt: string;
  };
}

/**
 * Apply the sync model's changes to `sync_jobs` in one batch, which D1 runs
 * as a transaction. An update sets only the fields it carries (`COALESCE`
 * keeps the others) and changes nothing for a row that does not exist,
 * unless it carries `orInsert`. That insert skips a repository retention
 * deleted, and leaves `requested_by` null for a deleted user, so a batch
 * never fails on a foreign key and stalls the model's projection.
 */
export async function applySyncJobChanges(
  d1: D1Database,
  changes: ReadonlyArray<SyncJobChange>,
): Promise<void> {
  const statements = changes.flatMap((c) => [
    ...(c.orInsert
      ? [
          d1
            .prepare(
              `INSERT INTO sync_jobs (id, repo_id, requested_by, mode, status, created_at)
               SELECT ?, ?, (SELECT id FROM users WHERE id = ?), ?, 'errored', ?
               WHERE EXISTS (SELECT 1 FROM repos WHERE id = ?)
               ON CONFLICT (id) DO NOTHING`,
            )
            .bind(
              c.jobId,
              c.orInsert.repoId,
              c.orInsert.requestedBy,
              c.orInsert.mode,
              c.orInsert.createdAt,
              c.orInsert.repoId,
            ),
        ]
      : []),
    d1
      .prepare(
        `UPDATE sync_jobs SET
           status = COALESCE(?, status),
           progress_at = COALESCE(?, progress_at),
           points_spent = COALESCE(?, points_spent),
           error = COALESCE(?, error),
           finished_at = COALESCE(?, finished_at)
         WHERE id = ?`,
      )
      .bind(
        c.status ?? null,
        c.progressAt ?? null,
        c.pointsSpent ?? null,
        c.error ?? null,
        c.finishedAt ?? null,
        c.jobId,
      ),
  ]);
  if (statements.length > 0) await d1.batch(statements);
}
