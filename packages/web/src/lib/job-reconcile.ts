import type { SyncJob } from '@bilan/store-d1';

/** What the Workflow engine says about a job's instance, or that it has none. */
export type InstanceStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting'
  | 'waitingForPause'
  | 'errored'
  | 'terminated'
  | 'complete'
  | 'unknown'
  | 'missing';

/** A job that has been "running" this long with no verdict is treated as lost. */
export const LOST_AFTER_MS = 6 * 3600e3;
/** A running (not sleeping) job whose heartbeat is older than this is treated as lost. */
export const STALL_AFTER_MS = 10 * 60e3;

const SLEEPING: ReadonlySet<InstanceStatus> = new Set(['paused', 'waiting', 'waitingForPause']);

const LIVE: ReadonlySet<InstanceStatus> = new Set([
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingForPause',
]);

export type Reconciliation = { action: 'keep' } | { action: 'lost'; error: string };

/**
 * A job row says `queued`/`running` until the Workflow's last step updates it.
 * If the instance died before that (a crash, a local restart, a terminated
 * run) the row stays "running" forever, the page polls forever, and the
 * already-running guard blocks every new sync. Decide from the engine's view:
 * a live instance keeps the row; anything else, including no instance at all,
 * marks it lost so the next sync can start (the store's in-flight marker makes
 * that run reconcile conservatively).
 */
export function reconcileJobStatus(input: {
  job: Pick<SyncJob, 'status' | 'createdAt' | 'progressAt'>;
  instance: InstanceStatus;
  now?: number;
}): Reconciliation {
  const { job, instance } = input;
  if (job.status !== 'queued' && job.status !== 'running') return { action: 'keep' };
  const now = input.now ?? Date.now();
  const age = now - Date.parse(job.createdAt);
  if (LIVE.has(instance)) {
    if (age > LOST_AFTER_MS) {
      return {
        action: 'lost',
        error: `still ${instance} after ${Math.round(age / 3600e3)}h; given up`,
      };
    }
    // The engine can keep calling an instance "running" that no longer executes
    // (a local restart, a wedged isolate). Each page step beats the heartbeat;
    // a sleeping instance (rate-limit wait) legitimately does not, so only a
    // supposedly running one is held to it.
    const lastBeat = Date.parse(job.progressAt ?? job.createdAt);
    const quiet = now - lastBeat;
    if (!SLEEPING.has(instance) && quiet > STALL_AFTER_MS) {
      return {
        action: 'lost',
        error: `lost: no progress for ${Math.round(quiet / 60e3)} min while the engine reported it ${instance}`,
      };
    }
    return { action: 'keep' };
  }
  const why =
    instance === 'missing'
      ? 'the sync engine has no record of this run (server restarted?)'
      : instance === 'complete'
        ? 'the run finished but never recorded its result'
        : `the run ${instance}`;
  return { action: 'lost', error: `lost: ${why}` };
}
