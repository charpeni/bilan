import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { NotCurrentJob } from './NotCurrentJob.rejection.ts';
import { JobId, RepoId } from './RepoSync.id.ts';

export class SyncFailed extends Domain.Event('SyncFailed', {
  jobId: JobId,
  error: Schema.String,
  pointsSpent: Schema.Int,
}) {}

/** The run gave up on its own: an error it could not retry its way out of. */
export class FailSync extends Domain.Command('FailSync', {
  target: RepoId,
  input: { jobId: JobId, error: Schema.String, pointsSpent: Schema.Int },
  events: [SyncFailed],
  rejects: [NotCurrentJob],
}) {}
