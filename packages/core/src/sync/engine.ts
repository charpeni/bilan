import { compact } from '../github/compact.ts';
import { DAY } from '../metrics/time.ts';

import type { GithubClient } from '../github/client.ts';
import type { RateLimit } from '../github/query.ts';
import type { PrState, RepoMeta, RepoRef } from '../types.ts';
import type { SyncStore } from './store.ts';

/** How far back a default sync reaches. */
export const DEFAULT_COVERAGE_DAYS = 30;

/** The default `since` bound: `DEFAULT_COVERAGE_DAYS` before `now`. */
export function defaultSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - DEFAULT_COVERAGE_DAYS * DAY);
}

export interface SyncPageInput {
  client: GithubClient;
  store: SyncStore;
  repo: RepoRef;
  cursor: string | null;
  /** PRs per page. Defaults to 25, which keeps a page around 25 rate-limit points. */
  pageSize?: number;
  /** Only PRs in these states; omit for all states. */
  states?: PrState[];
}

export interface SyncPageResult {
  fetched: number;
  changed: number;
  nextCursor: string | null;
  /** Epoch ms of the oldest `updatedAt` on the page; `Infinity` for an empty page. */
  oldestUpdatedAt: number;
  rateLimit: RateLimit;
}

/**
 * Fetch one page, upsert it, and report how many PRs actually changed. This is
 * the unit of work a durable job runner can make into a single step.
 */
export async function syncPage(input: SyncPageInput): Promise<SyncPageResult> {
  const { page, rateLimit } = await input.client.pullRequestsPage(
    input.repo,
    input.pageSize ?? 25,
    input.cursor,
    input.states === undefined ? {} : { states: input.states },
  );
  const prs = page.nodes.map(compact);
  const known = await input.store.updatedAtByNumber(prs.map((pr) => pr.number));
  const changed = prs.filter((pr) => known.get(pr.number) !== pr.updatedAt).length;
  await input.store.upsert(prs);
  return {
    fetched: prs.length,
    changed,
    nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
    oldestUpdatedAt: prs.reduce((min, pr) => Math.min(min, Date.parse(pr.updatedAt)), Infinity),
    rateLimit,
  };
}

export type StopReason = 'exhausted' | 'already-synced' | 'max-prs' | 'since' | 'rate-limit';

export interface SyncInput {
  client: GithubClient;
  store: SyncStore;
  repo: RepoRef;
  /** `incremental` stops after `unchangedPagesToStop` pages with no changes. */
  mode?: 'incremental' | 'full';
  pageSize?: number;
  /** Stop once this many PRs have been fetched in this run, across both passes. */
  maxPrs?: number;
  /**
   * Stop once a page's oldest `updatedAt` is before this instant. Pages are
   * ordered by `updatedAt` desc, so everything after it is older too. When set,
   * a second pass walks every open PR so the store also holds the ones that
   * went quiet before `since`.
   */
  since?: Date;
  /** Stop when GitHub reports fewer points than this. Defaults to 200. */
  rateLimitReserve?: number;
  unchangedPagesToStop?: number;
  onPage?: (progress: SyncProgress) => void;
  now?: () => Date;
}

export type SyncPass = 'all' | 'open';

export interface SyncProgress {
  /** Which walk this page belongs to: every state, or the follow-up over open PRs. */
  pass: SyncPass;
  /** Pages so far across both passes. */
  pages: number;
  /** PRs so far across both passes. */
  fetched: number;
  changedOnPage: number;
  rateLimit: RateLimit;
}

export interface SyncPassResult {
  pages: number;
  fetched: number;
  changed: number;
  stoppedBecause: StopReason;
}

export interface SyncResult {
  /** Totals across both passes. */
  pages: number;
  fetched: number;
  changed: number;
  pointsSpent: number;
  /** Why the main walk (every state) stopped. */
  stoppedBecause: StopReason;
  rateLimit: RateLimit | null;
  /**
   * The store's coverage after this run (see `RepoMeta.coverageSince`): the
   * earliest of what it already had and what this run guaranteed.
   */
  coverageSince: string | null;
  /** The follow-up walk over open PRs; `null` when it did not run. */
  openPass: SyncPassResult | null;
  /**
   * Whether every open PR is now in the store: the open pass reached the end
   * (or proved the earlier complete walk still holds), or the main pass walked
   * the whole history. `false` when a pass was cut short by `maxPrs` or the
   * rate limit, or the open pass was skipped.
   */
  openPrsComplete: boolean;
  /**
   * Whether this run reconciled everything it set out to: the main pass
   * reached `since`, the end of history, or already-synced pages, and the open
   * pass (when one was needed) reached the end or already-synced pages. A run
   * cut short by `maxPrs` or the rate limit is not complete: the store keeps
   * its in-flight marker so the next run walks past the half-written pages.
   */
  complete: boolean;
}

/**
 * Walk pages until one of the stop conditions fires, then stamp the store.
 *
 * With `since`, the run is two walks: every PR down to `since`, then every open
 * PR. The coverage this run guarantees is `since` when the first walk reached it
 * (`null`, full history, when it ran out of pages); if it stopped earlier for
 * `maxPrs` or the rate limit, only what lies strictly after the oldest
 * `updatedAt` it reached, since the next page may share that instant. The store
 * keeps the earliest bound it has ever been given, so a shallow run never
 * shrinks coverage, and a run that wants to go deeper than the store already
 * covers never stops on unchanged pages at all: inside the old bound those
 * pages may be nothing but open PRs the earlier open pass cached, so they
 * prove nothing about the closed PRs between them.
 *
 * Unchanged pages only count toward the incremental stop once the page's
 * oldest `updatedAt` is strictly older than `RepoMeta.reconciledAt`, the start
 * of the last complete run. Pages newer than that may be open PRs the previous
 * open pass cached after its main pass had already gone by, with a closure
 * that happened in between still sitting below them.
 */
export async function sync(input: SyncInput): Promise<SyncResult> {
  if (input.maxPrs !== undefined && (!Number.isSafeInteger(input.maxPrs) || input.maxPrs <= 0)) {
    throw new Error('--max-prs must be a positive integer');
  }
  const mode = input.mode ?? 'incremental';
  const reserve = input.rateLimitReserve ?? 200;
  const unchangedToStop = input.unchangedPagesToStop ?? 2;
  const now = input.now ?? (() => new Date());

  const meta = await input.store.meta();
  // Stamp the run as in flight before touching any row. `markSynced` clears
  // it; if this run dies in between, the next one sees `interrupted` and
  // knows that unchanged pages may be this run's half-finished work.
  await input.store.markStarted(now().toISOString());
  const existing =
    meta.syncedAt === null
      ? Infinity
      : meta.coverageSince === null
        ? -Infinity
        : Date.parse(meta.coverageSince);
  // A bounded run must also reach back to the last complete run: a PR updated
  // between the two syncs but older than this run's cutoff would otherwise be
  // missing while coverage still claims it. The watermark is that run's START
  // time, not its finish: a PR updated while it was running, after its page
  // had been fetched, sorts below the finish time and would be skipped. With
  // no complete run yet, the earliest unfinished start is the only instant
  // nothing has been reconciled from; a partial run's finish time is not safe.
  const since = catchUpSince(input.since, meta);
  const target = since === undefined ? -Infinity : since.getTime();
  // Unchanged pages only prove the store is current down to what it already
  // covered, and even inside that bound they may be cached open PRs sitting
  // between closed PRs the store has never seen. A run that wants to go deeper
  // than the existing coverage therefore never stops on them; it walks until
  // `since`, the end of history, `maxPrs`, or the rate limit.
  const deepening = target < existing;
  // After an interrupted run the rows it managed to write look current while
  // everything below them is still stale, so an unchanged page proves nothing
  // in either pass: walk until `since`, the end of history, `maxPrs`, or the
  // rate limit, and let `markSynced` clear the flag once the run completes.
  // Otherwise only pages older than the last complete run's start count: the
  // previous open pass may have cached open PRs touched after its main pass
  // went by, and a PR that closed in between sorts below them, still OPEN in
  // the store. A store with no complete run on record cannot vouch for any
  // page, so nothing counts there either.
  const trustUnchangedFrom =
    deepening || meta.interrupted || meta.reconciledAt === null
      ? -Infinity
      : Date.parse(meta.reconciledAt);
  // The open pass sees everything the main pass just stored, so only pages
  // older than `since` count there, and only against a complete earlier walk:
  // without one, an unchanged page says nothing about the open PRs below it.
  const trustUnchangedFromOpen =
    meta.openPrsSyncedAt === null || meta.interrupted ? -Infinity : target;

  const totals = { pages: 0, fetched: 0, changed: 0, pointsSpent: 0 };

  const walk = async (pass: SyncPass): Promise<Pass> => {
    const states: PrState[] | undefined = pass === 'open' ? ['OPEN'] : undefined;
    const passSince = pass === 'open' ? undefined : since;
    const trustFrom = pass === 'open' ? trustUnchangedFromOpen : trustUnchangedFrom;
    let cursor: string | null = null;
    let pages = 0;
    let fetched = 0;
    let changed = 0;
    let unchangedStreak = 0;
    let oldestReached = Infinity;
    let rateLimit: RateLimit | null = null;
    let stoppedBecause: StopReason = 'exhausted';

    for (;;) {
      const remaining = input.maxPrs === undefined ? Infinity : input.maxPrs - totals.fetched;
      if (remaining <= 0) {
        stoppedBecause = 'max-prs';
        break;
      }
      const result = await syncPage({
        client: input.client,
        store: input.store,
        repo: input.repo,
        cursor,
        pageSize: Math.min(input.pageSize ?? 25, remaining),
        ...(states === undefined ? {} : { states }),
      });
      pages++;
      fetched += result.fetched;
      changed += result.changed;
      totals.pages++;
      totals.fetched += result.fetched;
      totals.changed += result.changed;
      totals.pointsSpent += result.rateLimit.cost;
      oldestReached = Math.min(oldestReached, result.oldestUpdatedAt);
      rateLimit = result.rateLimit;
      input.onPage?.({
        pass,
        pages: totals.pages,
        fetched: totals.fetched,
        changedOnPage: result.changed,
        rateLimit,
      });

      if (result.nextCursor === null) break;
      if (mode === 'incremental' && result.oldestUpdatedAt < trustFrom) {
        unchangedStreak = result.changed === 0 ? unchangedStreak + 1 : 0;
        if (unchangedStreak >= unchangedToStop) {
          stoppedBecause = 'already-synced';
          break;
        }
      }
      if (input.maxPrs !== undefined && totals.fetched >= input.maxPrs) {
        stoppedBecause = 'max-prs';
        break;
      }
      if (passSince !== undefined && result.oldestUpdatedAt < passSince.getTime()) {
        stoppedBecause = 'since';
        break;
      }
      if (rateLimit.remaining < reserve) {
        stoppedBecause = 'rate-limit';
        break;
      }
      cursor = result.nextCursor;
    }
    return { pages, fetched, changed, stoppedBecause, oldestReached, rateLimit };
  };

  const main = await walk('all');

  const budgetLeft =
    (input.maxPrs === undefined || totals.fetched < input.maxPrs) &&
    (main.rateLimit === null || main.rateLimit.remaining >= reserve);
  const open =
    since !== undefined && main.stoppedBecause !== 'exhausted' && budgetLeft
      ? await walk('open')
      : null;

  let bound: number;
  switch (main.stoppedBecause) {
    case 'exhausted':
      bound = -Infinity;
      break;
    case 'since':
      bound = target;
      break;
    default:
      bound = afterOldest(main);
  }
  if (
    open !== null &&
    (open.stoppedBecause === 'max-prs' || open.stoppedBecause === 'rate-limit')
  ) {
    bound = Math.max(bound, afterOldest(open));
  }

  // Every open PR is in the store when the whole history is, or when the open
  // pass ran out of pages. An open pass that stopped on unchanged pages only
  // did so against a complete earlier walk, which it has just confirmed.
  const openPrsComplete =
    main.stoppedBecause === 'exhausted' ||
    (open !== null &&
      (open.stoppedBecause === 'exhausted' || open.stoppedBecause === 'already-synced'));

  // The run is complete when neither pass was cut short by the budget. An
  // open pass was needed whenever `since` applied and the main pass did not
  // walk the whole history; if the budget was gone before it could run, the
  // open set is still whatever the main pass happened to reach.
  const openNeeded = since !== undefined && main.stoppedBecause !== 'exhausted';
  const complete =
    reachedItsGoal(main.stoppedBecause) &&
    (!openNeeded || (open !== null && reachedItsGoal(open.stoppedBecause)));

  const at = now();
  const runCoverage = toCoverage(bound, at);
  await input.store.markSynced(at.toISOString(), runCoverage, openPrsComplete, complete);

  return {
    ...totals,
    stoppedBecause: main.stoppedBecause,
    rateLimit: open?.rateLimit ?? main.rateLimit,
    coverageSince: toCoverage(Math.min(bound, existing), at),
    openPass:
      open === null
        ? null
        : {
            pages: open.pages,
            fetched: open.fetched,
            changed: open.changed,
            stoppedBecause: open.stoppedBecause,
          },
    openPrsComplete,
    complete,
  };
}

interface Pass extends SyncPassResult {
  oldestReached: number;
  rateLimit: RateLimit | null;
}

/** A pass that stopped for any reason other than the budget did what it set out to. */
function reachedItsGoal(reason: StopReason): boolean {
  return reason !== 'max-prs' && reason !== 'rate-limit';
}

/**
 * The bound a pass guarantees when it stopped with pages still to come: one
 * millisecond after the oldest `updatedAt` it fetched. Two PRs can share an
 * `updatedAt` across a page boundary, so the tie itself is not proven. A pass
 * whose last page had no next page stops as `exhausted` instead and never
 * gets here.
 */
function afterOldest(pass: Pass): number {
  return pass.oldestReached + 1;
}

/** `-Infinity` is full history; `Infinity` (nothing reached) collapses to "now". */
function toCoverage(ms: number, now: Date): string | null {
  if (ms === -Infinity) return null;
  return (Number.isFinite(ms) ? new Date(ms) : now).toISOString();
}

/**
 * The earlier of the requested cutoff and the catch-up watermark: the start
 * of the last complete run (`RepoMeta.reconciledAt`), or, before any run has
 * completed, the earliest unfinished start (`RepoMeta.syncStartedAt`). With
 * neither the requested cutoff stands, and the caller must not trust unchanged
 * pages at all.
 */
export function effectiveSince(
  requested: Date | undefined,
  watermark: string | null,
): Date | undefined {
  if (requested === undefined || watermark === null) return requested;
  const last = new Date(watermark);
  return Number.isNaN(last.getTime()) || last >= requested ? requested : last;
}

/**
 * The cutoff a bounded run must actually walk to. Current-format stores carry
 * a safe watermark (`reconciledAt`, or the earliest unresolved start). A store
 * synced by older code has neither, and its `syncedAt` is a finish time that
 * proves nothing, so it reconciles once back to its own coverage boundary
 * (the whole history when coverage is full). A never-synced store just takes
 * the request.
 */
export function catchUpSince(
  requested: Date | undefined,
  meta: Pick<RepoMeta, 'reconciledAt' | 'syncStartedAt' | 'syncedAt' | 'coverageSince'>,
): Date | undefined {
  const watermark = meta.reconciledAt ?? meta.syncStartedAt;
  if (watermark !== null) return effectiveSince(requested, watermark);
  if (meta.syncedAt === null) return requested;
  return meta.coverageSince === null ? undefined : effectiveSince(requested, meta.coverageSince);
}
