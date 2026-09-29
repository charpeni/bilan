import { buildPayload, GithubClient, RepoNotFoundError, syncPage } from '@bilan/core';
import { D1Store, schema, upsertRepo } from '@bilan/store-d1';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { eq } from 'drizzle-orm';

import { getDb } from '../lib/db.ts';
import {
  coverageAfterRun,
  coverageAfterSync,
  openPrsComplete,
  runComplete,
  trustUnchangedFrom,
  trustUnchangedFromOpen,
} from '../lib/depth.ts';
import { gzip } from '../lib/gzip.ts';
import { payloadKey } from '../lib/payload-key.ts';
import { serverToken } from '../lib/token-source.ts';
import { ReauthRequiredError, useUserToken } from '../lib/tokens.ts';

import type { OpenWalkStop, PriorCoverage, WalkStop } from '../lib/depth.ts';
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
    const { owner, name, mode } = event.payload;
    const jobId = event.instanceId;
    const repoLabel = `${owner}/${name}`;
    const env = this.env;
    const db = getDb(env);

    /** Run `fn` on a client for the job's token, fresh for this step; the token itself never leaves the closure. */
    const withClient = <T>(fn: (client: GithubClient) => Promise<T>): Promise<T> =>
      withClientFor(env, event.payload, fn);

    try {
      const { repoId, prior, startedAt } = await step.do('resolve-repo', PAGE_RETRIES, async () => {
        const { meta } = await withClient((client) => client.repoMeta({ owner, name }));
        const repo = await upsertRepo(db, {
          id: meta.id,
          owner,
          name,
          isPrivate: meta.isPrivate,
          totalPrs: meta.pullRequests.totalCount,
        });
        await db
          .update(schema.syncJobs)
          .set({ status: 'running', progressAt: new Date().toISOString() })
          .where(eq(schema.syncJobs.id, jobId));
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
        return { repoId: repo.id, prior: priorCoverage, startedAt: runStartedAt };
      });

      const store = new D1Store(db, repoId, repoLabel);
      const { since, maxPrs } = event.payload;
      const sinceMs = since === undefined ? undefined : Date.parse(since);
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
      /** GitHub's window resets on the hour; park the instance until then before the next page. */
      const parkIfLow = async (label: string, result: PageStepResult): Promise<void> => {
        if (result.remaining < RATE_LIMIT_RESERVE) {
          await step.sleepUntil(`rate-limit-${label}`, new Date(result.resetAt));
        }
      };

      // Main pass: every PR by updatedAt desc, until `since` (or one of the other stops).
      let cursor: string | null = null;
      let unchangedStreak = 0;
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
        if (sinceMs !== undefined && (result.oldestUpdatedAt ?? -Infinity) < sinceMs) {
          stop = 'since';
          break;
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
        const body = await gzip(JSON.stringify(payload));
        await env.PAYLOADS.put(payloadKey(repoId, syncedAt), body, {
          httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
        });
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
        .where(eq(schema.syncJobs.id, jobId));
      throw error;
    }
  }
}

/**
 * A user token is fetched (and refreshed when within five minutes of expiry)
 * for each step, so a sync longer than the token's remaining life keeps going.
 * A token that cannot be refreshed, or that GitHub rejects, fails the job at
 * once: retrying would not bring it back. Nor would it bring back a repo
 * GitHub says does not exist (or that this token cannot see).
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
    if (error instanceof ReauthRequiredError || error instanceof RepoNotFoundError) {
      throw new NonRetryableError(error.message);
    }
    throw error;
  }
}
