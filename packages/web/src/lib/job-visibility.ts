import type { Repo, SyncJob } from '@bilan/store-d1';

/** The columns the decision reads, so callers and tests can pass partial rows. */
export type VisibleJob = Pick<SyncJob, 'repoId' | 'requestedBy'>;

/** The example repo's row, as far as the decision reads it. */
export type ExampleRepo = Pick<Repo, 'id' | 'isPrivate'>;

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
 * | example repo's | ok             | ok                                 |
 *
 * `exampleRepo` is the example repo's row, or `null` when bilan has no row
 * for it yet (then no job is an example-repo job). The exception only holds
 * while the row says the repo is public: a private example repo's jobs fall
 * under the owner-only rule like any other private repo's.
 */
export function jobVisibility(input: {
  job: VisibleJob | undefined;
  user: { id: number } | null;
  exampleRepo: ExampleRepo | null;
}): JobVisibility {
  const { job, user, exampleRepo } = input;
  const isExample =
    job !== undefined &&
    exampleRepo !== null &&
    exampleRepo.isPrivate === false &&
    job.repoId === exampleRepo.id;
  if (user === null) return isExample ? 'ok' : 'login-required';
  if (job === undefined) return 'unknown';
  if (isExample || job.requestedBy === user.id) return 'ok';
  return 'unknown';
}

/** Statuses of a run that has finished writing: the payload is there to read. */
export const SETTLED_JOB_STATUSES: readonly string[] = ['complete', 'partial'];

/** `complete` and `partial` both mean a payload was published; a partial run just did not reconcile everything. */
export function isSettledJobStatus(status: string): boolean {
  return SETTLED_JOB_STATUSES.includes(status);
}
