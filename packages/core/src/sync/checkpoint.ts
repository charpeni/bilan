import type { SyncCheckpoints, WalkCheckpoint } from '../types.ts';

/**
 * Where one walk (newest `updatedAt` first) stands against the walk an
 * earlier run left off (`WalkCheckpoint`). Both runners share these rules:
 * core's `sync()` and the web app's Workflow, which keeps this between its
 * page steps.
 */
export interface WalkProgress {
  /** The earlier walk this one joins; `null` when there is none it can use. */
  prior: WalkCheckpoint | null;
  /**
   * Whether this walk now speaks for the earlier one: it reached below
   * `prior.from`, or there was no earlier walk to reach.
   */
  joined: boolean;
  /**
   * Epoch ms of the oldest `updatedAt` this walk vouches for, the earlier
   * walk's `reached` included once joined; `Infinity` before any PR.
   */
  oldestReached: number;
}

/** What one page means for the walk. */
export interface WalkAdvance {
  progress: WalkProgress;
  /** The cursor to fetch next: GitHub's, or the earlier walk's once joined; `null` at the end. */
  next: string | null;
  /**
   * What to save for this walk once the page is stored: a checkpoint, `null`
   * when the walk reached its end, or `undefined` to keep the saved one (the
   * walk has not joined it yet, so it still holds more than this one).
   */
  checkpoint: WalkCheckpoint | null | undefined;
}

/**
 * A stored checkpoint this run can join, or `null`: one from a run that
 * started after this one (a clock that moved back) or that does not parse
 * vouches for nothing.
 */
export function usableCheckpoint(
  checkpoint: WalkCheckpoint | null | undefined,
  startedAt: string,
): WalkCheckpoint | null {
  if (checkpoint === null || checkpoint === undefined) return null;
  const from = Date.parse(checkpoint.from);
  return from <= Date.parse(startedAt) && Number.isFinite(Date.parse(checkpoint.reached))
    ? checkpoint
    : null;
}

/**
 * A walk starting from the newest page, given the checkpoint its store kept.
 * `startedAt` is the run's start: the instant its own checkpoints carry as
 * `from`. An earlier instant than the real start is safe (the next run only
 * re-walks more), a later one is not.
 */
export function startWalk(
  saved: WalkCheckpoint | null | undefined,
  startedAt: string,
): WalkProgress {
  const prior = usableCheckpoint(saved, startedAt);
  return { prior, joined: prior === null, oldestReached: Infinity };
}

/**
 * Take one stored page into the walk. A walk left off by an earlier run holds
 * from `prior.from` down to `prior.reached`. This walk starts from the newest
 * page again, since PRs updated in between moved up there, and joins the
 * earlier one once a page reaches below `prior.from`: it then goes on from
 * `prior.cursor` and vouches for everything down to `prior.reached` (or as far
 * as it got itself, if that is further). Pure, so a durable runner can work it
 * out inside a step (to save the checkpoint) and again outside (to go on).
 */
export function advanceWalk(
  progress: WalkProgress,
  page: { oldestUpdatedAt: number; nextCursor: string | null },
  startedAt: string,
): WalkAdvance {
  const { prior } = progress;
  let { joined } = progress;
  let oldestReached = Math.min(progress.oldestReached, page.oldestUpdatedAt);
  let next = page.nextCursor;
  if (prior !== null && !joined && next !== null && oldestReached < Date.parse(prior.from)) {
    joined = true;
    if (Date.parse(prior.reached) < oldestReached) {
      oldestReached = Date.parse(prior.reached);
      next = prior.cursor;
    }
  }
  let checkpoint: WalkCheckpoint | null | undefined;
  if (next === null) checkpoint = null;
  else if (joined && Number.isFinite(oldestReached)) {
    checkpoint = { cursor: next, reached: new Date(oldestReached).toISOString(), from: startedAt };
  }
  return { progress: { prior, joined, oldestReached }, next, checkpoint };
}

/**
 * Whether a request for `cursor` that GitHub failed should drop the walk's
 * checkpoint: a saved cursor GitHub no longer takes must not fail every later
 * run, so it is forgotten and the next run walks down from the newest page.
 */
export function forgetsCheckpoint(progress: WalkProgress, cursor: string | null): boolean {
  return cursor !== null && cursor === progress.prior?.cursor;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validCheckpoint(value: unknown): value is WalkCheckpoint | null {
  return (
    value === null ||
    (record(value) &&
      ['cursor', 'reached', 'from'].every((key) => typeof value[key] === 'string') &&
      Number.isFinite(Date.parse(String(value.reached))) &&
      Number.isFinite(Date.parse(String(value.from))))
  );
}

/** Checkpoints only save work; ones that do not validate are dropped, not an error. */
export function checkpointsOrNothing(value: unknown): SyncCheckpoints | undefined {
  return record(value) && validCheckpoint(value.all) && validCheckpoint(value.open)
    ? { all: value.all, open: value.open }
    : undefined;
}
