/**
 * How the repo page waits for a sync to land, decided from what the API
 * answered and nothing else, so the Astro scripts stay thin.
 *
 * The page may only read `GET /api/sync/:id` for a job it started itself:
 * anyone else's job answers 404 there. So a sync the viewer rode along with
 * (a 409, or a run someone else started before they arrived) is watched on
 * the payload endpoint instead: `HEAD /api/repos/:owner/:name/payload`
 * answers `x-bilan-synced-at` (the payload on offer) and `x-bilan-sync-active`
 * (whether a job is queued or running), both access-checked like the payload.
 * A new `x-bilan-synced-at`, or a 200 after a 202, means the sync published.
 */

import { syncErrorText } from './sync-status.ts';

export const POLL_INTERVAL_MS = 4000;

export const SYNC_ACTIVE_HEADER = 'x-bilan-sync-active';
export const SYNCED_AT_HEADER = 'x-bilan-synced-at';
/** Pull requests already stored for the repo while a job runs: progress, never a decision. */
export const PRS_STORED_HEADER = 'x-bilan-prs-stored';

/** What the page is watching for a sync to finish. */
export type SyncWatch =
  /** A job this viewer started: its row is readable. */
  | { kind: 'job'; jobId: string }
  /** Anyone's sync: only the payload endpoint is readable. `baseline` is the `syncedAt` on offer when the wait began, null for none. */
  | { kind: 'payload'; baseline: string | null };

export type PollOutcome =
  /** Still running; poll again after `POLL_INTERVAL_MS`. */
  | { kind: 'wait' }
  /** A payload newer than the baseline was published. */
  | { kind: 'ready' }
  /** Nothing is running and nothing new was published: the sync ended without a payload. */
  | { kind: 'stopped' }
  /** The job cannot be read here (not this viewer's, or gone); watch the payload instead. */
  | { kind: 'watch-payload' }
  | { kind: 'failed'; message: string };

/**
 * Which endpoint to watch after `POST /sync`: a 202 carries the job this
 * viewer just started, a 409 means someone's sync is already running (its id
 * is not readable, so the payload is watched). Anything else refused the sync.
 */
export function watchAfterSyncResponse(
  status: number,
  body: { jobId?: string },
  baseline: string | null,
): SyncWatch | null {
  if (status === 202 && typeof body.jobId === 'string') return { kind: 'job', jobId: body.jobId };
  if (status === 409) return { kind: 'payload', baseline };
  return null;
}

/** The payload endpoint's answer, as far as the poller reads it. */
export interface PayloadProbe {
  status: number;
  /** `x-bilan-synced-at`: the instant of the payload on offer, null without one. */
  syncedAt: string | null;
  /** `x-bilan-sync-active`: a job is queued or running. */
  syncActive: boolean;
  /** `x-bilan-prs-stored`: pull requests stored so far while a job runs; null when not sent. */
  prsStored: number | null;
}

export function readPayloadProbe(status: number, headers: Headers): PayloadProbe {
  return {
    status,
    syncedAt: headers.get(SYNCED_AT_HEADER),
    syncActive: headers.get(SYNC_ACTIVE_HEADER) === '1',
    prsStored: readCount(headers.get(PRS_STORED_HEADER)),
  };
}

/**
 * A 200 with a `syncedAt` other than the baseline is the sync landing (the
 * first payload after a 202 included). The same `syncedAt` while a job is
 * active is a wait; with none active the run ended without publishing. A 202
 * (first sync in flight) waits; a 404 waits only while a job is active.
 */
export function payloadPollOutcome(probe: PayloadProbe, baseline: string | null): PollOutcome {
  if (probe.status === 200) {
    if (probe.syncedAt !== null && probe.syncedAt !== baseline) return { kind: 'ready' };
    return probe.syncActive ? { kind: 'wait' } : { kind: 'stopped' };
  }
  if (probe.status === 202) return { kind: 'wait' };
  if (probe.status === 404) return probe.syncActive ? { kind: 'wait' } : { kind: 'stopped' };
  return { kind: 'failed', message: `Could not read sync status (${probe.status}).` };
}

/** A non-negative integer header or field, else null. */
function readCount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The job row as `GET /api/sync/:id` answers it, as far as the poller reads it. */
export interface JobProbe {
  status: string;
  settled: boolean;
  error?: string | null;
  /** When the job was queued (ISO). */
  createdAt?: string | null;
  /** Pull requests stored for the repo so far (see `countStoredPrs`). */
  prsStored?: number | null;
  /** How far along the run is (see `sync-progress.ts`); absent from older workers. */
  progress?: { read: number; total: number | null; fraction: number | null; label: string } | null;
  /** The Workflow instance's own status, null once its record is gone. */
  workflow?: { status: string } | null;
  /**
   * Staged runs only (a first sync publishes the last 7 days, then reads on
   * to 30): which stage is running, of how many, and a ready-to-show label
   * such as "Last 7 days published; reading up to 30 days".
   */
  stage?: { current: number; total: number; label: string } | null;
}

/** What the page can say about a running sync, from whichever endpoint it watches. */
export interface SyncProgress {
  /** `queued` or `running` from the job row; `active` when only the payload endpoint is readable. */
  phase: 'queued' | 'running' | 'active';
  prsStored: number | null;
  /** When the job was queued, when known (own jobs only). */
  startedAt: string | null;
  /** Ready-to-show progress sentence from the API (own jobs only). */
  label: string | null;
  /** 0..1 when the run's target is known (full-history runs), else null. */
  fraction: number | null;
  /** The Workflow instance's status (`running`, `waiting`, …), when known. */
  workflowStatus: string | null;
  /** The API's stage label for a staged run, when it sent one. */
  stageLabel: string | null;
  /**
   * A staged run is past its first stage, so an interim payload has been
   * published while the job keeps going.
   */
  interim: boolean;
}

export function jobProgress(job: JobProbe): SyncProgress {
  const progress = job.progress ?? null;
  const fraction = progress?.fraction;
  return {
    phase: job.status === 'queued' ? 'queued' : 'running',
    prsStored: readCount(progress?.read ?? job.prsStored),
    startedAt: typeof job.createdAt === 'string' ? job.createdAt : null,
    label: typeof progress?.label === 'string' && progress.label !== '' ? progress.label : null,
    fraction: typeof fraction === 'number' && fraction >= 0 && fraction <= 1 ? fraction : null,
    workflowStatus: typeof job.workflow?.status === 'string' ? job.workflow.status : null,
    stageLabel:
      typeof job.stage?.label === 'string' && job.stage.label !== '' ? job.stage.label : null,
    interim: typeof job.stage?.current === 'number' && job.stage.current > 1,
  };
}

export function payloadProgress(probe: PayloadProbe): SyncProgress {
  return {
    phase: 'active',
    prsStored: probe.prsStored,
    startedAt: null,
    label: null,
    fraction: null,
    workflowStatus: null,
    stageLabel: null,
    // The payload endpoint says nothing about stages; a 200 while active is decided by the outcome.
    interim: false,
  };
}

/**
 * `settled` covers `complete` and `partial`: a payload was published either
 * way. A 404 means the job is not this viewer's to read (or is gone), so the
 * page falls back to watching the payload rather than giving up.
 */
export function jobPollOutcome(status: number, job: JobProbe | null): PollOutcome {
  if (status === 404) return { kind: 'watch-payload' };
  if (status !== 200 || job === null) {
    return { kind: 'failed', message: `Could not read job status (${status}).` };
  }
  if (job.settled) return { kind: 'ready' };
  if (job.status === 'errored') return { kind: 'failed', message: syncErrorText(job.error) };
  return { kind: 'wait' };
}

/** The watch to continue with after an outcome, or null when the wait is over. */
export function nextWatch(
  watch: SyncWatch,
  outcome: PollOutcome,
  baseline: string | null,
): SyncWatch | null {
  if (outcome.kind === 'wait') return watch;
  if (outcome.kind === 'watch-payload') return { kind: 'payload', baseline };
  return null;
}
