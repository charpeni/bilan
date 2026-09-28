import type { SyncJob } from '@bilan/store-d1';

/** The columns the decision reads, so callers and tests can pass partial rows. */
export type VisibleJob = Pick<SyncJob, 'requestedBy'>;

export type JobVisibility = 'ok' | 'login-required' | 'unknown';

/**
 * Whether the viewer may read a sync job's status. Decided from the row alone:
 * no KV, no GitHub, so the answer is the same whatever GitHub's mood, and the
 * route can never turn a job id into a repo probe.
 *
 * | job            | signed out     | signed in                          |
 * | -------------- | -------------- | ---------------------------------- |
 * | unknown id     | login-required | unknown                            |
 * | the viewer's   | —              | ok                                 |
 * | another user's | login-required | unknown (same answer as unknown id) |
 * | the cron's     | login-required | unknown                            |
 *
 * The built-in examples never have jobs (they are static snapshots), so
 * there is no exception for them.
 */
export function jobVisibility(input: {
  job: VisibleJob | undefined;
  user: { id: number } | null;
}): JobVisibility {
  const { job, user } = input;
  if (user === null) return 'login-required';
  if (job === undefined) return 'unknown';
  return job.requestedBy === user.id ? 'ok' : 'unknown';
}

/** Statuses of a run that has finished writing: the payload is there to read. */
export const SETTLED_JOB_STATUSES: readonly string[] = ['complete', 'partial'];

/** `complete` and `partial` both mean a payload was published; a partial run just did not reconcile everything. */
export function isSettledJobStatus(status: string): boolean {
  return SETTLED_JOB_STATUSES.includes(status);
}
