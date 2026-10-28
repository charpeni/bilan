import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { JobId, RepoId } from './RepoSync.id.ts';

/** The model gave up on a run that stopped reporting. Its Workflow is stopped too. */
export class SyncLost extends Domain.Event('SyncLost', {
  jobId: JobId,
  reason: Schema.String,
}) {}

/**
 * The run's overall time limit passed. Scheduled by `SyncDeadlines` when the
 * run is admitted; records nothing once the run has ended.
 */
export class ExpireSync extends Domain.Command('ExpireSync', {
  target: RepoId,
  input: { jobId: JobId },
  events: [SyncLost],
}) {}
