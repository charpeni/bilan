import { RepoNotFoundError, catchUpSince } from '@bilan/core';
import { admitSyncJob, schema, touchRepoView, upsertRepo } from '@bilan/store-d1';
import { and, count, desc, eq, inArray } from 'drizzle-orm';

import { getDb } from './db.ts';
import { DEFAULT_DEPTH, depthToSince } from './depth.ts';
import { admitSync, releaseSync, requestSync } from './domain.ts';
import { isDeeperThanCoverage, SYNC_LIMIT_TTL_S } from './sync-policy.ts';
import { resolveTokenSource, tokenSourceDeps } from './token-source.ts';

import type { SyncRepoParams } from '../workflows/sync-repo.ts';
import type { SyncDepth } from './depth.ts';
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
 * as `GithubError` for the caller to answer 503), then ask the sync model:
 * it refuses while another run of the repo is current, admission checks the
 * requester's and the global quotas in D1, and the model starts the run.
 * The row is keyed by the id GitHub answered with, so syncing a name another
 * repo took over parks the old row (`upsertRepo`) and starts the newcomer's.
 *
 * If this request dies between asking and admitting, the model gives up on
 * the request after two minutes and frees the repo (`ExpireAdmission`).
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
  const repo = await upsertRepo(db, {
    id: meta.id,
    owner: ref.owner,
    name: ref.name,
    isPrivate: meta.isPrivate,
    totalPrs: meta.pullRequests.totalCount,
  });

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
  const job = { repoId: repo.id, jobId };

  const requested = await requestSync(env, {
    ...job,
    requestedBy: userId,
    run: {
      owner: ref.owner,
      name: ref.name,
      mode,
      depth,
      since: since ?? null,
      maxPrs: options.maxPrs ?? null,
      tokenSource:
        source.source === 'server' ? { _tag: 'Server' } : { _tag: 'User', userId: source.userId },
    },
  });
  if (!requested.ok) {
    if (requested.rejected === 'SyncAlreadyRunning') {
      throw new SyncAlreadyRunningError(requested.jobId);
    }
    throw new Error(`The sync model refused the request: ${requested.rejected}`);
  }

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
    await releaseSync(env, { ...job, reason: 'quota' });
    // `sync_jobs` may still list a run the model just saw end (its update is
    // on the way): report it like a run in progress, which ends shortly.
    const existing = await findActiveJob(db, repo.id);
    if (existing) throw new SyncAlreadyRunningError(existing.id);
    throw new SyncRateLimitedError(60);
  }
  // Preserve the explicit import intent even if dispatch fails. Otherwise a
  // never-viewed private repo can be swept with its recent quota history.
  await touchRepoView(db, { repoId: repo.id, userId, now: new Date(now).toISOString() });

  // The model starts the Workflow once it records the admission (`StartSyncRun`).
  const started = await admitSync(env, job);
  if (!started.ok) {
    throw new Error('The sync request expired before it was admitted; try again');
  }
  return { jobId, repoId: repo.id, depth, ...(since === undefined ? {} : { since }) };
}
