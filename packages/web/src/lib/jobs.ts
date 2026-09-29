import { RepoNotFoundError, catchUpSince } from '@bilan/core';
import { admitSyncJob, schema, touchRepoView, upsertRepo } from '@bilan/store-d1';
import { and, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';

import { getDb } from './db.ts';
import { DEFAULT_DEPTH, depthToSince } from './depth.ts';
import { DISPATCH_GRACE_MS, reconcileJobStatus } from './job-reconcile.ts';
import { isDeeperThanCoverage, SYNC_LIMIT_TTL_S } from './sync-policy.ts';
import { resolveTokenSource, tokenSourceDeps } from './token-source.ts';

import type { SyncRepoParams } from '../workflows/sync-repo.ts';
import type { SyncDepth } from './depth.ts';
import type { InstanceStatus } from './job-reconcile.ts';
import type { ResolvedTokenSource } from './token-source.ts';
import type { RepoRef } from '@bilan/core';
import type { Db, SyncJob } from '@bilan/store-d1';

const ACTIVE_STATUSES = ['queued', 'running'] as const;

export class SyncAlreadyRunningError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super('A sync is already running');
    this.name = 'SyncAlreadyRunningError';
    this.jobId = jobId;
  }
}

export class SyncRateLimitedError extends Error {
  /** Seconds until the same requester may sync this repo again. */
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`Sync capacity or quota reached; try again in ${retryAfter}s`);
    this.name = 'SyncRateLimitedError';
    this.retryAfter = retryAfter;
  }
}

/**
 * The active job for a repo after checking the Workflow engine still has a
 * live instance for it; a lost job is marked errored and `undefined` is
 * returned so a new sync can start. See `reconcileJobStatus`.
 */
export async function findLiveJob(
  env: Pick<Env, 'SYNC_REPO'>,
  db: Db,
  repoId: string,
): Promise<SyncJob | undefined> {
  const job = await findActiveJob(db, repoId);
  if (!job) return undefined;
  return reconcileJob(env, db, job);
}

export async function instanceStatus(
  env: Pick<Env, 'SYNC_REPO'>,
  jobId: string,
): Promise<InstanceStatus> {
  try {
    const status = (await (await env.SYNC_REPO.get(jobId)).status()).status;
    return (INSTANCE_STATUSES as readonly string[]).includes(status)
      ? (status as InstanceStatus)
      : 'unknown';
  } catch (error) {
    // Only the engine's explicit absence error proves there is no instance.
    // Network/transport failures must not release an active reservation.
    return error instanceof Error && error.message.includes('instance.not_found')
      ? 'missing'
      : 'unknown';
  }
}

const INSTANCE_STATUSES = [
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingForPause',
  'errored',
  'terminated',
  'complete',
  'unknown',
] as const;

/** Apply `reconcileJobStatus` to a row; returns the row still considered active, or undefined. */
export async function reconcileJob(
  env: Pick<Env, 'SYNC_REPO'>,
  db: Db,
  job: SyncJob,
): Promise<SyncJob | undefined> {
  if (job.status !== 'queued' && job.status !== 'running') return undefined;
  const instance = await instanceStatus(env, job.id);
  const verdict = reconcileJobStatus({ job, instance });
  if (verdict.action === 'keep') return job;
  if (!['missing', 'errored', 'terminated', 'complete'].includes(instance)) {
    // Stop a stalled live instance before freeing its slot: it must not resume
    // writes after a replacement job starts. Failed termination keeps the lease.
    try {
      await (await env.SYNC_REPO.get(job.id)).terminate();
    } catch {
      return job;
    }
  }
  await db
    .update(schema.syncJobs)
    .set({ status: 'errored', error: verdict.error, finishedAt: new Date().toISOString() })
    .where(and(eq(schema.syncJobs.id, job.id), inArray(schema.syncJobs.status, ACTIVE_STATUSES)));
  return undefined;
}

/** Recover abandoned reservations across repos before applying aggregate caps. */
async function reconcileStaleJobs(env: Pick<Env, 'SYNC_REPO'>, db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - DISPATCH_GRACE_MS).toISOString();
  const candidates = await db
    .select()
    .from(schema.syncJobs)
    .where(
      and(
        inArray(schema.syncJobs.status, ACTIVE_STATUSES),
        lte(sql`coalesce(${schema.syncJobs.progressAt}, ${schema.syncJobs.createdAt})`, cutoff),
      ),
    )
    .limit(100)
    .all();
  await Promise.all(candidates.map((job) => reconcileJob(env, db, job)));
}

export function findActiveJob(db: Db, repoId: string): Promise<SyncJob | undefined> {
  return db
    .select()
    .from(schema.syncJobs)
    .where(
      and(eq(schema.syncJobs.repoId, repoId), inArray(schema.syncJobs.status, ACTIVE_STATUSES)),
    )
    .orderBy(desc(schema.syncJobs.createdAt))
    .get();
}

/** The most recent job for a repo, whatever its status; undefined when it never had one. */
export function findLastJob(db: Db, repoId: string): Promise<SyncJob | undefined> {
  return db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.repoId, repoId))
    .orderBy(desc(schema.syncJobs.createdAt))
    .get();
}

/**
 * Pull requests stored for a repo: while a job runs, how far it got (each
 * page's rows are written as the page lands), which the page shows as
 * progress. Never used to decide anything.
 */
export async function countStoredPrs(db: Db, repoId: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.repoId, repoId))
    .get();
  return row?.n ?? 0;
}

export function getJob(db: Db, id: string): Promise<SyncJob | undefined> {
  return db.select().from(schema.syncJobs).where(eq(schema.syncJobs.id, id)).get();
}

export interface StartSyncOptions {
  mode?: SyncRepoParams['mode'];
  /** How far back to guarantee activity; defaults to `'30d'`. Open PRs are always included. */
  depth?: SyncDepth;
  maxPrs?: number;
  /**
   * The signed-in user asking for the sync: the job runs on their token when
   * it sees the repo (else on the server token for a public one, see
   * `resolveTokenSource`) and consumes both repository and aggregate capacity.
   */
  requestedBy: number;
  /**
   * The token source `checkRepoAccess` already resolved for this request
   * (`unknown` or `replaced`), so GitHub is not asked twice. Omit to resolve
   * here; a source resolved for another viewer must never be passed.
   */
  source?: ResolvedTokenSource;
}

export interface StartedSync {
  jobId: string;
  repoId: string;
  depth: SyncDepth;
  /** ISO bound the job will walk back to; undefined for `all`. */
  since?: string;
}

/**
 * Pick the token the job will run on and resolve the repo on it (so the
 * `repos` row exists for the job's foreign key, and an invisible repo fails
 * here as `RepoNotFoundError`; a GitHub failure on this first read is thrown
 * as `GithubError` for the caller to answer 503), refuse if a job is already
 * active or the requester is over their limit, then start the workflow.
 * The row is keyed by the id GitHub answered with, so syncing a name another
 * repo took over parks the old row (`upsertRepo`) and starts the newcomer's.
 */
export async function startSync(
  env: Env,
  ref: RepoRef,
  options: StartSyncOptions,
): Promise<StartedSync> {
  const userId = options.requestedBy;
  const source =
    options.source ?? (await resolveTokenSource(tokenSourceDeps(env), { id: userId }, ref));
  if (source.source === 'not-found') throw new RepoNotFoundError(ref);
  if (source.source === 'login-required') {
    throw new Error('A sync needs a signed-in user');
  }
  const { meta } = source;

  const db = getDb(env);
  await reconcileStaleJobs(env, db);
  const repo = await upsertRepo(db, {
    id: meta.id,
    owner: ref.owner,
    name: ref.name,
    isPrivate: meta.isPrivate,
    totalPrs: meta.pullRequests.totalCount,
  });

  const active = await findLiveJob(env, db, repo.id);
  if (active) throw new SyncAlreadyRunningError(active.id);

  const mode = options.mode ?? 'incremental';
  const depth = options.depth ?? DEFAULT_DEPTH;

  // Walk back at least to the start of the last complete run so nothing
  // updated since it (including during a partial run cut by the budget) is
  // skipped by a shallower cutoff (see core's `effectiveSince`). A row with no
  // complete run yet only has the start of the run still in flight
  // (`syncStartedAt`, kept from the first unfinished run); without either, the
  // depth alone bounds the walk. A row synced by older code (neither stamp)
  // reconciles once back to its coverage boundary; see core's `catchUpSince`.
  const since = catchUpSince(depthToSince(depth), {
    reconciledAt: repo.reconciledAt,
    syncStartedAt: repo.syncStartedAt,
    syncedAt: repo.lastSyncedAt,
    coverageSince: repo.coverageSince,
  })?.toISOString();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const admitted = await admitSyncJob(db, {
    id: jobId,
    repoId: repo.id,
    requestedBy: userId,
    mode,
    maxPrs: options.maxPrs ?? null,
    createdAt: new Date(now).toISOString(),
    cooldownAfter: isDeeperThanCoverage(
      depth,
      {
        syncedAt: repo.lastSyncedAt,
        coverageSince: repo.coverageSince,
      },
      now,
    )
      ? null
      : new Date(now - SYNC_LIMIT_TTL_S * 1000).toISOString(),
  });
  if (!admitted) {
    const existing = await findActiveJob(db, repo.id);
    if (existing) throw new SyncAlreadyRunningError(existing.id);
    throw new SyncRateLimitedError(60);
  }
  // Preserve the explicit import intent even if dispatch fails. Otherwise a
  // never-viewed private repo can be swept with its recent quota history.
  await touchRepoView(db, { repoId: repo.id, userId, now: new Date(now).toISOString() });

  const params: SyncRepoParams = {
    owner: ref.owner,
    name: ref.name,
    ...(source.source === 'server'
      ? { tokenSource: 'server' }
      : { tokenSource: 'user', userId: source.userId }),
    mode,
    depth,
    ...(since === undefined ? {} : { since }),
    ...(options.maxPrs === undefined ? {} : { maxPrs: options.maxPrs }),
  };
  // A failed response does not prove the engine rejected creation. Keep the
  // reservation until reconciliation can establish the instance's state.
  await env.SYNC_REPO.create({ id: jobId, params });
  return { jobId, repoId: repo.id, depth, ...(since === undefined ? {} : { since }) };
}
