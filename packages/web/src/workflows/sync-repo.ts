import {
  buildPayload,
  GithubClient,
  RepoChangedError,
  RepoNotFoundError,
  syncPage,
} from '@bilan/core';
import { beginSyncJob, D1Store, schema, upsertRepo } from '@bilan/store-d1';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { and, eq, inArray } from 'drizzle-orm';

import { getDb } from '../lib/db.ts';
import {
  coverageAfterRun,
  coverageAfterSync,
  interimCoverage,
  openPrsComplete,
  runComplete,
  syncStages,
  trustUnchangedFrom,
  trustUnchangedFromOpen,
} from '../lib/depth.ts';
import { gzip } from '../lib/gzip.ts';
import { payloadKey } from '../lib/payload-key.ts';
import { serverToken } from '../lib/token-source.ts';
import { ReauthRequiredError, useUserToken } from '../lib/tokens.ts';

import type { OpenWalkStop, PriorCoverage, SyncDepth, SyncStage, WalkStop } from '../lib/depth.ts';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

/**
 * Which GitHub token the job runs on: the server's (cron, example repo, public
 * repos the app is not installed on) or a signed-in user's. A user token is
 * resolved again inside every step, since GitHub App tokens live 8 hours and a
 * deep sync can outlast that; see `withClient`.
 */
export type SyncTokenSource = { tokenSource: 'server' } | { tokenSource: 'user'; userId: number };

export type SyncRepoParams = SyncTokenSource & {
  owner: string;
  name: string;
  mode: 'incremental' | 'full';
  /** How far back the job was asked to guarantee activity; `since` is its bound, caught up. */
  depth: SyncDepth;
  /**
   * ISO instant. Stop walking once a page is older than this, then fetch every
   * open PR so the backlog is complete whatever the depth. Omit for full history.
   */
  since?: string;
  maxPrs?: number;
};

/** What one page step persists. Never the PR data: step results are capped at 1 MiB. */
interface PageStepResult {
  nextCursor: string | null;
  fetched: number;
  changed: number;
  cost: number;
  remaining: number;
  resetAt: string;
  /** Epoch ms; null for an empty page. */
  oldestUpdatedAt: number | null;
}

/** An interim stage: one with a bound to publish at. */
type InterimStage = SyncStage & { since: string };

const PAGE_SIZE = 25;
const RATE_LIMIT_RESERVE = 200;
const UNCHANGED_PAGES_TO_STOP = 2;
/** Workflows allow 1024 steps per instance; leave room for the bookkeeping steps. */
const MAX_PAGES = 1000;

const PAGE_RETRIES = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
} as const;

export class SyncRepoWorkflow extends WorkflowEntrypoint<Env, SyncRepoParams> {
  override async run(event: Readonly<WorkflowEvent<SyncRepoParams>>, step: WorkflowStep) {
    const { owner, name, mode, depth, since, maxPrs } = event.payload;
    const jobId = event.instanceId;
    const repoLabel = `${owner}/${name}`;
    const env = this.env;
    const db = getDb(env);

    /** Run `fn` on a client for the job's token, fresh for this step; the token itself never leaves the closure. */
    const withClient = <T>(fn: (client: GithubClient) => Promise<T>): Promise<T> =>
      withClientFor(env, event.payload, fn);

    try {
      const { repoId, prior, startedAt, stages } = await step.do(
        'resolve-repo',
        PAGE_RETRIES,
        async () => {
          const reservation = await beginSyncJob(db, jobId, new Date().toISOString());
          if (!reservation) {
            throw new NonRetryableError('This sync reservation is no longer active');
          }
          const { meta } = await withClient((client) => client.repoMeta({ owner, name }));
          if (meta.id !== reservation.repoId) {
            throw new NonRetryableError('The repository changed; start a new sync');
          }
          const repo = await upsertRepo(db, {
            id: meta.id,
            owner,
            name,
            isPrivate: meta.isPrivate,
            totalPrs: meta.pullRequests.totalCount,
          });
          // Read the prior state before stamping this run as started: `interrupted`
          // must reflect the previous run, not this one. The marker keeps the
          // earliest unfinished start (`markStarted` only sets it when null), so
          // that is the instant this run reconciles from and what `reconciledAt`
          // becomes once it completes.
          const repoStore = new D1Store(db, repo.id, repoLabel);
          const stored = await repoStore.meta();
          const runStartedAt = stored.syncStartedAt ?? new Date().toISOString();
          await repoStore.markStarted(runStartedAt);
          const priorCoverage: PriorCoverage = {
            syncedAt: stored.syncedAt,
            coverageSince: stored.coverageSince,
            openPrsSyncedAt: stored.openPrsSyncedAt,
            interrupted: stored.interrupted,
            reconciledAt: stored.reconciledAt,
          };
          // A first sync at the default depth publishes an interim payload on the
          // way (`syncStages`); the bounds are fixed here so retries see the same.
          const runStages = syncStages(priorCoverage, depth, new Date(), since);
          return {
            repoId: repo.id,
            prior: priorCoverage,
            startedAt: runStartedAt,
            stages: runStages,
          };
        },
      );

      const store = new D1Store(db, repoId, repoLabel);
      const sinceMs = since === undefined ? undefined : Date.parse(since);
      // Every stage but the last publishes an interim payload; the last stops the walk at `since`.
      const interimStages: InterimStage[] = stages
        .slice(0, -1)
        .flatMap((stage) => (stage.since === undefined ? [] : [{ ...stage, since: stage.since }]));
      // Unchanged pages only count toward the incremental stop below these
      // bounds, as in core's `sync()`: never while deepening beyond what the
      // store already covers, never after an interrupted run (its rows look
      // unchanged above pages it never reached), only once the page is older
      // than the last complete run's start (`reconciledAt`: rows above it may
      // be that run's or a partial one's own writes), and in the open pass only
      // once some run has walked every open PR (see `trustUnchangedFrom` and
      // `trustUnchangedFromOpen`).
      const trustFrom = mode === 'incremental' ? trustUnchangedFrom(prior, since) : -Infinity;
      const trustFromOpen =
        mode === 'incremental' ? trustUnchangedFromOpen(prior, since) : -Infinity;

      let fetched = 0;
      let pointsSpent = 0;
      let pagesUsed = 0;
      let oldestReached: number | null = null;
      let stop: WalkStop = 'max-pages';

      const fetchPage = async (
        label: string,
        pageCursor: string | null,
        states?: ['OPEN'],
      ): Promise<PageStepResult> => {
        const result = await step.do(label, PAGE_RETRIES, async (): Promise<PageStepResult> => {
          const r = await withClient((client) =>
            syncPage({
              client,
              store,
              repo: { owner, name },
              // Pages look the repo up by name; only ever store the repo resolved above.
              repoId,
              cursor: pageCursor,
              pageSize: PAGE_SIZE,
              ...(states === undefined ? {} : { states }),
            }),
          );
          return {
            nextCursor: r.nextCursor,
            fetched: r.fetched,
            changed: r.changed,
            cost: r.rateLimit.cost,
            remaining: r.rateLimit.remaining,
            resetAt: r.rateLimit.resetAt,
            oldestUpdatedAt: Number.isFinite(r.oldestUpdatedAt) ? r.oldestUpdatedAt : null,
          };
        });
        pagesUsed++;
        fetched += result.fetched;
        pointsSpent += result.cost;
        // Heartbeat for the status endpoint and the lost-job check: a run that
        // stops beating while the engine still calls it "running" is treated as lost.
        await db
          .update(schema.syncJobs)
          .set({ progressAt: new Date().toISOString(), pointsSpent })
          .where(eq(schema.syncJobs.id, jobId));
        return result;
      };
      /** Gzip the payload to R2 under the key `GET /payload` reads for `syncedAt`. */
      const publish = async (syncedAt: string, payload: ReturnType<typeof buildPayload>) => {
        const body = await gzip(JSON.stringify(payload));
        await env.PAYLOADS.put(payloadKey(repoId, syncedAt), body, {
          httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
        });
      };
      /**
       * Interim publish for a staged first sync: the payload so far, served by
       * `GET /payload` as soon as `last_synced_at` is set, stamped as a partial
       * run (`complete: false`) so the in-flight marker stays, `reconciledAt`
       * and the open set are untouched, and coverage claims only this stage's
       * bound. The step key is fixed per stage, so a retry publishes again under
       * a later `syncedAt` and the final publish supersedes it either way.
       */
      const publishInterim = async (index: number, stage: InterimStage): Promise<void> => {
        await step.do(`build-payload-${index + 1}`, PAGE_RETRIES, async () => {
          const syncedAt = new Date().toISOString();
          const coverage = interimCoverage(stage, oldestReached, syncedAt);
          const payload = buildPayload(
            {
              repo: repoLabel,
              syncedAt,
              coverageSince: coverageAfterRun(prior, coverage),
              openPrsSyncedAt: prior.openPrsSyncedAt,
              reconciledAt: prior.reconciledAt,
              interrupted: true,
              syncStartedAt: startedAt,
            },
            await store.all(),
          );
          await publish(syncedAt, payload);
          await store.markSynced(syncedAt, coverage, false, false);
          // The status endpoint tells the stage from the rows (`syncStage`); keep the heartbeat beating.
          await db
            .update(schema.syncJobs)
            .set({ progressAt: new Date().toISOString(), pointsSpent })
            .where(eq(schema.syncJobs.id, jobId));
          return {
            syncedAt,
            prs: payload.prs.length,
            coverage,
            stage: index + 1,
            stages: stages.length,
          };
        });
      };
      /** GitHub's window resets on the hour; park the instance until then before the next page. */
      const parkIfLow = async (label: string, result: PageStepResult): Promise<void> => {
        if (result.remaining < RATE_LIMIT_RESERVE) {
          await step.sleepUntil(`rate-limit-${label}`, new Date(result.resetAt));
        }
      };

      // Main pass: every PR by updatedAt desc, until `since` (or one of the
      // other stops). A staged first sync publishes an interim payload once a
      // page dips below each interim bound and walks on from the same cursor.
      let cursor: string | null = null;
      let unchangedStreak = 0;
      let nextInterim = 0;
      for (let page = 1; ; page++) {
        if (pagesUsed >= MAX_PAGES) break;
        const result = await fetchPage(`page-${page}`, cursor);
        if (result.oldestUpdatedAt !== null) {
          oldestReached = Math.min(oldestReached ?? Infinity, result.oldestUpdatedAt);
        }

        if (result.nextCursor === null) {
          stop = 'exhausted';
          break;
        }
        if ((result.oldestUpdatedAt ?? -Infinity) < trustFrom) {
          unchangedStreak = result.changed === 0 ? unchangedStreak + 1 : 0;
          if (unchangedStreak >= UNCHANGED_PAGES_TO_STOP) {
            stop = 'already-synced';
            break;
          }
        }
        if (maxPrs !== undefined && fetched >= maxPrs) {
          stop = 'max-prs';
          break;
        }
        // Pages are ordered by updatedAt desc: once one dips below `since`, so does the rest.
        const oldest = result.oldestUpdatedAt ?? -Infinity;
        if (sinceMs !== undefined && oldest < sinceMs) {
          stop = 'since';
          break;
        }
        // Below an interim bound too: publish, then walk on from this page's cursor.
        while (nextInterim < interimStages.length) {
          const stage = interimStages[nextInterim];
          if (stage === undefined || oldest >= Date.parse(stage.since)) break;
          await publishInterim(nextInterim, stage);
          nextInterim++;
        }
        await parkIfLow(`page-${page}`, result);
        cursor = result.nextCursor;
      }

      // Open-PR pass: a bounded walk leaves older open PRs behind, and the
      // backlog cards need all of them. Skipped when the main pass already
      // walked everything or used up the budget. Only a pass that reached its
      // end (or proved the rest unchanged) lets the store claim a complete open
      // set; see `openPrsComplete`.
      let openStop: OpenWalkStop | null = null;
      if (sinceMs !== undefined && stop !== 'exhausted' && stop !== 'max-prs') {
        let openCursor: string | null = null;
        let openStreak = 0;
        openStop = 'max-pages';
        for (let page = 1; ; page++) {
          if (pagesUsed >= MAX_PAGES) break;
          const result = await fetchPage(`open-${page}`, openCursor, ['OPEN']);
          if (result.nextCursor === null) {
            openStop = 'exhausted';
            break;
          }
          if ((result.oldestUpdatedAt ?? -Infinity) < trustFromOpen) {
            openStreak = result.changed === 0 ? openStreak + 1 : 0;
            if (openStreak >= UNCHANGED_PAGES_TO_STOP) {
              openStop = 'already-synced';
              break;
            }
          }
          if (maxPrs !== undefined && fetched >= maxPrs) {
            openStop = 'max-prs';
            break;
          }
          await parkIfLow(`open-${page}`, result);
          openCursor = result.nextCursor;
        }
      }

      // A run cut by the page budget (`max-prs`, `max-pages`) is published as
      // `partial`: the payload and `syncedAt` move, coverage widens by what was
      // reached, but `reconciledAt` stays and the in-flight marker is kept, so
      // the next run reaches back to the last complete one and never stops on
      // this run's half-written pages (see `runComplete`).
      const complete = runComplete({ stop, openStop, since });
      await step.do('build-payload', PAGE_RETRIES, async () => {
        const syncedAt = new Date().toISOString();
        const coverage = coverageAfterSync({ stop, since, oldestReached, syncedAt });
        // The store only stamps the open set on a complete run (`markSynced`).
        const openComplete = complete && openPrsComplete(stop, openStop);
        const payload = buildPayload(
          {
            repo: repoLabel,
            syncedAt,
            coverageSince: coverageAfterRun(prior, coverage),
            openPrsSyncedAt: openComplete ? syncedAt : prior.openPrsSyncedAt,
            reconciledAt: complete ? startedAt : prior.reconciledAt,
            // An incomplete run leaves its in-flight marker for the next run to see.
            interrupted: !complete,
            syncStartedAt: complete ? null : startedAt,
          },
          await store.all(),
        );
        await publish(syncedAt, payload);
        await store.markSynced(syncedAt, coverage, openComplete, complete);
        if (mode === 'full' && complete) {
          await db
            .update(schema.repos)
            .set({ lastFullSyncAt: syncedAt })
            .where(eq(schema.repos.id, repoId));
        }
        await db
          .update(schema.syncJobs)
          .set({ status: complete ? 'complete' : 'partial', pointsSpent, finishedAt: syncedAt })
          .where(eq(schema.syncJobs.id, jobId));
        return {
          syncedAt,
          prs: payload.prs.length,
          coverage,
          stop,
          openStop,
          openComplete,
          complete,
        };
      });
    } catch (error) {
      await db
        .update(schema.syncJobs)
        .set({
          status: 'errored',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.syncJobs.id, jobId),
            inArray(schema.syncJobs.status, ['queued', 'running']),
          ),
        );
      throw error;
    }
  }
}

/**
 * A user token is fetched (and refreshed when within five minutes of expiry)
 * for each step, so a sync longer than the token's remaining life keeps going.
 * A token that cannot be refreshed, or that GitHub rejects, fails the job at
 * once: retrying would not bring it back. Nor would it bring back a repo
 * GitHub says does not exist (or that this token cannot see), or a name that
 * now resolves to a different repo.
 */
async function withClientFor<T>(
  env: Env,
  source: SyncTokenSource,
  fn: (client: GithubClient) => Promise<T>,
): Promise<T> {
  try {
    if (source.tokenSource === 'server') {
      return await fn(new GithubClient({ token: serverToken(env) }));
    }
    return await useUserToken(env, source.userId, (token) => fn(new GithubClient({ token })));
  } catch (error) {
    if (
      error instanceof ReauthRequiredError ||
      error instanceof RepoNotFoundError ||
      error instanceof RepoChangedError
    ) {
      throw new NonRetryableError(error.message);
    }
    throw error;
  }
}
