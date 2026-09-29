import { fmtElapsed } from './progress.ts';

import type { SyncProgress } from './poll.ts';

/**
 * What a running sync looks like on screen, decided from the probes alone so
 * the pages stay thin: how much is done (the API's progress label, a
 * determinate bar when the target is known), how long it has taken, and
 * whether it is still moving (the read count must keep growing, unless the
 * run is asleep until GitHub's rate limit resets, which the page says).
 */

/** No new pull request stored for this long reads as stalled. */
export const STALL_AFTER_MS = 90_000;

/** Workflow states in which a run is asleep, waiting for GitHub's rate limit to reset. */
const WAITING_STATES = new Set(['waiting', 'paused', 'waitingForPause']);

/** When the read count last grew; carried between probes by the page. */
export interface Liveness {
  read: number | null;
  /** Epoch ms of the last growth (or of the first probe). */
  since: number;
}

/** Fold one probe into the liveness record: any growth of the read count resets the clock. */
export function observe(previous: Liveness | null, read: number | null, now: number): Liveness {
  if (previous === null) return { read, since: now };
  if (read !== null && (previous.read === null || read > previous.read))
    return { read, since: now };
  return previous;
}

export interface SyncView {
  state: 'queued' | 'reading' | 'waiting' | 'stalled';
  /** The primary line: how much is done, or what the run is waiting for. */
  headline: string;
  /** The figure in the headline (pull requests read) when it carries one, so a page can count it up. */
  count: number | null;
  /** The secondary line: the counts while waiting, then the elapsed time. */
  detail: string;
  /** 0..1 when the target is known: a determinate bar. Null: indeterminate. */
  fraction: number | null;
  /** A quiet warning when nothing has moved for `STALL_AFTER_MS`; polling goes on. */
  warning: string | null;
}

const count = (n: number): string =>
  `${n.toLocaleString('en-US')} pull request${n === 1 ? '' : 's'}`;

/** The progress sentence: the API's label when it sent one, else the stored count. */
function progressLine(progress: SyncProgress): string | null {
  const n = progress.prsStored;
  if (n === null || n === 0) return null;
  return progress.label ?? `${count(n)} read`;
}

export function describeSync(
  progress: SyncProgress,
  liveness: Liveness | null,
  now: number = Date.now(),
): SyncView {
  const line = progressLine(progress);
  const elapsed =
    progress.startedAt === null || Number.isNaN(Date.parse(progress.startedAt))
      ? null
      : fmtElapsed(now - Date.parse(progress.startedAt));
  const waiting = progress.workflowStatus !== null && WAITING_STATES.has(progress.workflowStatus);
  const quiet = liveness === null ? 0 : now - liveness.since;
  const stalled = !waiting && quiet >= STALL_AFTER_MS;

  let headline: string;
  let secondary: (string | null)[];
  let state: SyncView['state'];
  if (waiting) {
    state = 'waiting';
    headline = 'Waiting for GitHub’s rate limit to reset';
    secondary = [line, elapsed];
  } else if (progress.phase === 'queued') {
    state = stalled ? 'stalled' : 'queued';
    headline = 'Waiting to start…';
    secondary = [elapsed];
  } else {
    state = stalled ? 'stalled' : 'reading';
    headline = line ?? 'Reading pull requests from GitHub…';
    secondary = [elapsed];
  }
  return {
    state,
    headline,
    count: headline === line ? progress.prsStored : null,
    detail: secondary.filter((part): part is string => part !== null).join(' · '),
    fraction: progress.fraction,
    warning: stalled ? `No progress for ${fmtElapsed(quiet)}` : null,
  };
}

/** One line for a place with room for one (the dashboard's load-more note). */
export function syncLine(view: SyncView): string {
  return [view.headline, view.detail, view.warning]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
}

/**
 * What an errored job says to the person watching it. A leading one-word code
 * (`lost: …`, written by the job reconciler) is dropped: the sentence after it
 * is the reason.
 */
export function syncErrorText(error: string | null | undefined): string {
  const reason = (error ?? '')
    .trim()
    .replace(/^[a-z-]+:\s+/, '')
    .replace(/\.$/, '');
  return reason === '' ? 'The sync stopped.' : `The sync stopped: ${reason}.`;
}

/**
 * The dashboard's status line while a staged first sync is still running
 * behind an interim payload: what is on screen (`history`, e.g. "last 7
 * days"), what the run is doing (the API's stage label reads
 * "<done>; <doing>", so only the doing part is kept; "still syncing" without
 * one), then the progress and any stall warning.
 */
export function interimText(
  history: string,
  view: SyncView | null,
  stageLabel: string | null,
): string {
  const doing = stageLabel?.split(';').pop()?.trim() || 'still syncing';
  const parts: (string | null)[] = [`Showing the ${history}`, doing];
  if (view !== null && view.state !== 'queued') parts.push(view.headline, view.warning);
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

/** What the dashboard offers once the final payload of a staged run lands. */
export function finalReadyText(history: string): string {
  return `The ${history} ${history.endsWith('days') ? 'are' : 'is'} ready.`;
}
