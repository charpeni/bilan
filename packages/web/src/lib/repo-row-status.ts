import { fmtCount } from './count-up.ts';
import { fmtAgo, fmtHistory } from './format.ts';
import { isStale } from './stale.ts';
import { syncStage } from './sync-progress.ts';

import type { PayloadProbe } from './poll.ts';

/**
 * What a row on /repositories says about its sync, decided from the rows
 * alone so the page stays thin. A running job reads as progress (and the
 * stage of a staged first sync); a last run cut by the budget asks to be run
 * again; otherwise the payload's age and reach, as the header chip says them.
 */

export interface RowStage {
  current: number;
  total: number;
}

export type RowStatus =
  | { kind: 'syncing'; text: string; count: number; stage: RowStage | null }
  | { kind: 'partial'; text: string }
  | { kind: 'synced'; text: string; stale: boolean }
  | { kind: 'never'; text: string };

export interface RowStatusInput {
  lastSyncedAt: string | null;
  coverageSince: string | null;
  syncStartedAt: string | null;
  /** The queued or running job, when there is one. */
  activeJob: { status: string; createdAt: string } | null;
  /** Pull requests stored so far, read only while a job is active. */
  storedPrs: number | null;
  /** The status of the most recent job, whatever it is; null when there never was one. */
  lastJobStatus: string | null;
}

/** `Syncing · 1,200 pull requests read · stage 1 of 2` */
export function syncingText(count: number, stage: RowStage | null): string {
  const parts = ['Syncing', `${fmtCount(count)} pull request${count === 1 ? '' : 's'} read`];
  if (stage) parts.push(`stage ${stage.current} of ${stage.total}`);
  return parts.join(' · ');
}

/** `Synced 12 min ago · last 30 days` */
export function syncedText(syncedAt: string, coverageSince: string | null, now: number): string {
  return `Synced ${fmtAgo(syncedAt, now)} · ${fmtHistory(coverageSince, syncedAt)}`;
}

export const PARTIAL_TEXT = 'Partial · run again';
export const NEVER_TEXT = 'Never synced';

export function repoRowStatus(input: RowStatusInput, now: number = Date.now()): RowStatus {
  const { lastSyncedAt, coverageSince, syncStartedAt, activeJob, storedPrs, lastJobStatus } = input;
  if (activeJob) {
    const stage = syncStage({ job: activeJob, repo: { lastSyncedAt, syncStartedAt } });
    const count = storedPrs ?? 0;
    const rowStage = stage ? { current: stage.current, total: stage.total } : null;
    return { kind: 'syncing', text: syncingText(count, rowStage), count, stage: rowStage };
  }
  if (lastJobStatus === 'partial') return { kind: 'partial', text: PARTIAL_TEXT };
  if (lastSyncedAt !== null) {
    return {
      kind: 'synced',
      text: syncedText(lastSyncedAt, coverageSince, now),
      stale: isStale(lastSyncedAt, now),
    };
  }
  return { kind: 'never', text: NEVER_TEXT };
}

/**
 * The stage a live row is in after a probe: the payload endpoint says
 * nothing about stages, but a payload newer than the one the row started
 * with, while the job still runs, can only be the interim one of a staged
 * first sync, so the next stage has begun.
 */
export function liveStage(
  initial: RowStage | null,
  baseline: string | null,
  syncedAt: string | null,
): RowStage | null {
  if (initial === null) return null;
  const published = syncedAt !== null && syncedAt !== baseline;
  return published && initial.current < initial.total
    ? { current: initial.current + 1, total: initial.total }
    : initial;
}

/**
 * What a live row says after one `HEAD /payload` probe (see `poll.ts`): the
 * count while the job runs, then the final chip once it is over. `baseline`
 * is the `syncedAt` the row was rendered with. Null when the probe could not
 * be read (the row keeps its last text and stops polling).
 */
export function rowStatusFromProbe(
  probe: PayloadProbe & { coverageSince: string | null },
  initialStage: RowStage | null,
  baseline: string | null,
  now: number = Date.now(),
): RowStatus | null {
  if (probe.status !== 200 && probe.status !== 202 && probe.status !== 404) return null;
  if (probe.syncActive) {
    const stage = liveStage(initialStage, baseline, probe.syncedAt);
    const count = probe.prsStored ?? 0;
    return { kind: 'syncing', text: syncingText(count, stage), count, stage };
  }
  if (probe.status === 200 && probe.syncedAt !== null) {
    return {
      kind: 'synced',
      text: syncedText(probe.syncedAt, probe.coverageSince, now),
      stale: isStale(probe.syncedAt, now),
    };
  }
  return { kind: 'never', text: NEVER_TEXT };
}
