import {
  jobPollOutcome,
  jobProgress,
  nextWatch,
  payloadPollOutcome,
  payloadProgress,
  POLL_INTERVAL_MS,
  readPayloadProbe,
} from './poll.ts';

import type { JobProbe, PollOutcome, SyncProgress, SyncWatch } from './poll.ts';

/** Why a wait ended without a new payload. */
export class SyncWatchError extends Error {
  /** `failed`: the job errored or its status could not be read; `stopped`: it ended without publishing. */
  readonly kind: 'failed' | 'stopped';
  constructor(kind: 'failed' | 'stopped', message: string) {
    super(message);
    this.name = 'SyncWatchError';
    this.kind = kind;
  }
}

export const STOPPED_MESSAGE = 'The sync ended without publishing new data. Try again.';

export interface SyncWatchDeps {
  /** `/api/repos/:owner/:name` of the repository being watched. */
  apiBase: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Called after every probe that says the sync is still running. */
  onProgress?: (progress: SyncProgress) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One probe of whatever the watch points at, per the rules in `poll.ts`: a
 * job this viewer started is read on `GET /api/sync/:id`; anyone else's sync
 * only through `HEAD <apiBase>/payload`.
 */
async function probe(
  watch: SyncWatch,
  deps: SyncWatchDeps,
): Promise<{ outcome: PollOutcome; progress: SyncProgress | null }> {
  if (watch.kind === 'job') {
    const response = await deps.fetch(`/api/sync/${encodeURIComponent(watch.jobId)}`, {
      cache: 'no-store',
    });
    const job = response.ok ? ((await response.json()) as JobProbe) : null;
    return { outcome: jobPollOutcome(response.status, job), progress: job && jobProgress(job) };
  }
  const response = await deps.fetch(`${deps.apiBase}/payload`, {
    method: 'HEAD',
    cache: 'no-store',
  });
  const read = readPayloadProbe(response.status, response.headers);
  return { outcome: payloadPollOutcome(read, watch.baseline), progress: payloadProgress(read) };
}

/**
 * Resolve once a payload newer than `baseline` is published; reject with a
 * `SyncWatchError` when the sync failed or ended without one.
 */
export async function watchSync(
  initial: SyncWatch,
  baseline: string | null,
  deps: SyncWatchDeps,
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  let watch: SyncWatch | null = initial;
  while (watch !== null) {
    const { outcome, progress } = await probe(watch, deps);
    if (outcome.kind === 'ready') return;
    if (outcome.kind === 'failed') throw new SyncWatchError('failed', outcome.message);
    if (outcome.kind === 'stopped') throw new SyncWatchError('stopped', STOPPED_MESSAGE);
    if (outcome.kind === 'wait' && progress) deps.onProgress?.(progress);
    watch = nextWatch(watch, outcome, baseline);
    if (outcome.kind === 'wait') await sleep(POLL_INTERVAL_MS);
  }
}
