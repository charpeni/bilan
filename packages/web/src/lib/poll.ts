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

export const POLL_INTERVAL_MS = 4000;

export const SYNC_ACTIVE_HEADER = 'x-bilan-sync-active';
export const SYNCED_AT_HEADER = 'x-bilan-synced-at';

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
}

export function readPayloadProbe(status: number, headers: Headers): PayloadProbe {
  return {
    status,
    syncedAt: headers.get(SYNCED_AT_HEADER),
    syncActive: headers.get(SYNC_ACTIVE_HEADER) === '1',
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

/** The job row as `GET /api/sync/:id` answers it, as far as the poller reads it. */
export interface JobProbe {
  status: string;
  settled: boolean;
  error?: string | null;
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
  if (job.status === 'errored') {
    return { kind: 'failed', message: `Sync failed: ${job.error ?? 'unknown error'}` };
  }
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
