import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { NotCurrentJob } from './NotCurrentJob.rejection.ts';
import { JobId, RepoId } from './RepoSync.id.ts';

export class SyncProgressed extends Domain.Event('SyncProgressed', {
  jobId: JobId,
  /** Pull requests this run has fetched so far. */
  prsFetched: Schema.Int,
  /** GitHub GraphQL points the run has spent so far. */
  pointsSpent: Schema.Int,
}) {}

/** A page landed: the run is alive. Resumes a paused run. */
export class RecordSyncProgress extends Domain.Command('RecordSyncProgress', {
  target: RepoId,
  input: { jobId: JobId, prsFetched: Schema.Int, pointsSpent: Schema.Int },
  events: [SyncProgressed],
  rejects: [NotCurrentJob],
}) {}
