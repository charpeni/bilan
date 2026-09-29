/** How far back a sync guarantees activity; `all` walks the whole history. */
export type SyncDepth = '30d' | '90d' | '180d' | 'all';

export const SYNC_DEPTHS: readonly SyncDepth[] = ['30d', '90d', '180d', 'all'];

/** The product default: what the cron and a plain `POST /sync` load. */
export const DEFAULT_DEPTH: SyncDepth = '30d';

/**
 * How far a run's stage walks: a depth the user can ask for, or the interim
 * bound a first sync publishes at before going on (see `syncStages`).
 */
export type StageDepth = typeof INTERIM_DEPTH | SyncDepth;

/** How far back the first stage of a staged first sync walks before publishing. */
export const INTERIM_DEPTH = '7d';

const DAY_MS = 24 * 60 * 60 * 1000;

export const isSyncDepth = (value: unknown): value is SyncDepth =>
  typeof value === 'string' && (SYNC_DEPTHS as readonly string[]).includes(value);

/**
 * The `since` bound a depth stands for: `now − N days`, or `undefined` for
 * `all` (no bound). This is the instant recorded as coverage once the sync
 * lands, so it is computed once at job start rather than per page.
 */
export function depthToSince(depth: StageDepth, now: Date = new Date()): Date | undefined {
  if (depth === 'all') return undefined;
  const days = Number(depth.slice(0, -1));
  return new Date(now.getTime() - days * DAY_MS);
}

/** One leg of a run's main walk: stop once a page is older than `since` (`undefined`: never). */
export interface SyncStage {
  depth: StageDepth;
  since: string | undefined;
}

/**
 * The bounds a run's main walk publishes at, in order. A repo's first sync at
 * the default depth has nothing to show for minutes on a busy repo, so it runs
 * in two stages: down to `INTERIM_DEPTH`, where an interim payload is published,
 * then on from the same cursor to the depth's bound, the open-PR pass, and the
 * final payload. Every other run (a repo that already has a payload, or an
 * explicit deeper load) is a single stage.
 *
 * `since` is the bound the job actually walks to (`catchUpSince` may have moved
 * it earlier than the depth's own); it becomes the last stage's. An interim
 * stage is only kept when it is strictly shallower than that bound.
 */
export function syncStages(
  prior: Pick<PriorCoverage, 'syncedAt'>,
  depth: SyncDepth,
  now: Date = new Date(),
  since: string | undefined = depthToSince(depth, now)?.toISOString(),
): SyncStage[] {
  const final: SyncStage = { depth, since };
  if (prior.syncedAt !== null || depth !== DEFAULT_DEPTH) return [final];
  const interimSince = depthToSince(INTERIM_DEPTH, now)?.toISOString();
  if (
    interimSince === undefined ||
    (since !== undefined && Date.parse(since) >= Date.parse(interimSince))
  ) {
    return [final];
  }
  return [{ depth: INTERIM_DEPTH, since: interimSince }, final];
}

/**
 * The coverage an interim publish can claim: the walk went below the stage's
 * bound (that is what triggers it), so it is the bound itself, under the same
 * exclusive-bound rules as the final publish (`coverageAfterSync`).
 */
export function interimCoverage(
  stage: SyncStage & { since: string },
  oldestReached: number | null,
  syncedAt: string,
): string {
  return (
    coverageAfterSync({ stop: 'since', since: stage.since, oldestReached, syncedAt }) ?? stage.since
  );
}

/** Why a page walk ended; core's `StopReason` plus the Workflow step budget. */
export type WalkStop = 'exhausted' | 'already-synced' | 'since' | 'max-prs' | 'max-pages';

/**
 * The coverage bound a finished run can honestly claim, mirroring core's
 * `sync()`. Walking every page is full history whatever the depth was;
 * stopping at `since` is `since`; any earlier stop (unchanged pages, page
 * budget) only guarantees down to one millisecond after the oldest `updatedAt`
 * it fetched: two PRs can share an `updatedAt` across a page boundary, so the
 * tie itself is not proven (the bound is exclusive of it). Whether the open-PR
 * set is complete is tracked separately (`RepoMeta.openPrsSyncedAt`), so a
 * cut-short open pass no longer pulls this bound up.
 */
export function coverageAfterSync(input: {
  stop: WalkStop;
  since: string | undefined;
  /** Epoch ms of the oldest `updatedAt` the main walk saw; null when no page had data. */
  oldestReached: number | null;
  syncedAt: string;
}): string | null {
  let bound: number;
  switch (input.stop) {
    case 'exhausted':
      bound = -Infinity;
      break;
    case 'since':
      bound = input.since === undefined ? -Infinity : Date.parse(input.since);
      break;
    default:
      bound = input.oldestReached === null ? Infinity : input.oldestReached + 1;
  }
  if (bound === -Infinity) return null;
  if (bound === Infinity) return input.syncedAt;
  return new Date(bound).toISOString();
}

/** Why the open pass ended; `null` when it did not run. */
export type OpenWalkStop = 'exhausted' | 'already-synced' | 'max-prs' | 'max-pages';

/**
 * Whether this run can vouch for every open PR being in the store: the main
 * pass walked the whole history, or the open pass reached its last page (or
 * proved the rest unchanged, which only counts once the set was complete
 * before, see `trustUnchangedFromOpen`).
 */
export function openPrsComplete(stop: WalkStop, openStop: OpenWalkStop | null): boolean {
  if (stop === 'exhausted') return true;
  return openStop === 'exhausted' || openStop === 'already-synced';
}

/**
 * Whether the run reconciled everything it set out to, mirroring core's
 * `sync()`: the main pass reached `since`, the end of history, or proved the
 * rest unchanged (not cut by `maxPrs` or the page budget), and the open pass
 * either was not needed (no `since`, or the main pass walked everything) or
 * did the same. Only a complete run moves `RepoMeta.reconciledAt`; a partial
 * one keeps the in-flight marker so the next run reaches back to the last
 * complete one and never stops on its half-written pages.
 */
export function runComplete(input: {
  stop: WalkStop;
  openStop: OpenWalkStop | null;
  since: string | undefined;
}): boolean {
  if (!reachedItsGoal(input.stop)) return false;
  const openNeeded = input.since !== undefined && input.stop !== 'exhausted';
  if (!openNeeded) return true;
  return input.openStop !== null && reachedItsGoal(input.openStop);
}

function reachedItsGoal(stop: WalkStop | OpenWalkStop): boolean {
  return stop !== 'max-prs' && stop !== 'max-pages';
}

/** Coverage only ever moves earlier: the earliest of the two bounds, `null` being full history. */
export function widenCoverage(prior: string | null, next: string | null): string | null {
  if (prior === null || next === null) return null;
  return Date.parse(next) < Date.parse(prior) ? next : prior;
}

/** The part of the stored `RepoMeta` the stop rules read. */
export interface PriorCoverage {
  syncedAt: string | null;
  coverageSince: string | null;
  openPrsSyncedAt: string | null;
  /** See `RepoMeta.interrupted`: a previous run wrote rows but never stamped the sync. */
  interrupted: boolean;
  /** See `RepoMeta.reconciledAt`: the start of the last run that reconciled everything. */
  reconciledAt: string | null;
}

/**
 * Epoch ms below which unchanged pages count toward the incremental stop, as
 * in core's `sync()`. Unchanged pages only prove the store is current down to
 * what it already covered, so a run going deeper than that bound (its `since`
 * is earlier than the stored coverage, a full run over partial coverage, or a
 * first run) must never stop on them: `-Infinity`. Nor may a run after an
 * interrupted one: the rows that run left behind look unchanged while the
 * pages below them were never fetched. Within prior coverage, only pages
 * whose oldest `updatedAt` is strictly older than `reconciledAt` count: rows
 * updated at or after the last complete run's start were written by that run
 * or by a partial one, so a page of them looking unchanged says nothing about
 * the pages below. A store that never recorded a complete run (no
 * `reconciledAt`) has no such line, so nothing counts.
 */
export function trustUnchangedFrom(
  prior: Pick<PriorCoverage, 'syncedAt' | 'coverageSince' | 'interrupted' | 'reconciledAt'>,
  since: string | undefined,
): number {
  if (prior.interrupted) return -Infinity;
  const existing =
    prior.syncedAt === null
      ? Infinity
      : prior.coverageSince === null
        ? -Infinity
        : Date.parse(prior.coverageSince);
  const target = since === undefined ? -Infinity : Date.parse(since);
  if (target < existing) return -Infinity;
  if (prior.reconciledAt === null) return -Infinity;
  const reconciledAt = Date.parse(prior.reconciledAt);
  return Number.isNaN(reconciledAt) ? -Infinity : reconciledAt;
}

/**
 * The same bound for the open-PR pass. It sees everything the main pass just
 * stored, so only pages older than `since` can count; and unchanged open pages
 * only prove anything once a run has walked every open PR (`openPrsSyncedAt`),
 * otherwise an untouched page may sit right above open PRs never fetched.
 */
export function trustUnchangedFromOpen(prior: PriorCoverage, since: string | undefined): number {
  if (prior.openPrsSyncedAt === null) return -Infinity;
  const sinceMs = since === undefined ? -Infinity : Date.parse(since);
  return Math.min(trustUnchangedFrom(prior, since), sinceMs);
}

/**
 * What the store's coverage will be once this run is stamped. A repo that has
 * never been synced has `coverageSince: null` meaning "nothing yet", not "full
 * history", so its first run takes the run's bound as-is; afterwards coverage
 * only ever widens.
 */
export function coverageAfterRun(
  prior: { syncedAt: string | null; coverageSince: string | null },
  next: string | null,
): string | null {
  if (prior.syncedAt === null) return next;
  return widenCoverage(prior.coverageSince, next);
}
