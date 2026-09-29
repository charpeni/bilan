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
  job: Pick<SyncJob, 'status' | 'createdAt'>;
  instance: InstanceStatus;
  now?: number;
}): Reconciliation {
  const { job, instance } = input;
  if (job.status !== 'queued' && job.status !== 'running') return { action: 'keep' };
  const age = (input.now ?? Date.now()) - Date.parse(job.createdAt);
  if (LIVE.has(instance)) {
    return age > LOST_AFTER_MS
      ? { action: 'lost', error: `still ${instance} after ${Math.round(age / 3600e3)}h; given up` }
      : { action: 'keep' };
  }
  const why =
    instance === 'missing'
      ? 'the sync engine has no record of this run (server restarted?)'
      : instance === 'complete'
        ? 'the run finished but never recorded its result'
        : `the run ${instance}`;
  return { action: 'lost', error: `lost: ${why}` };
}
