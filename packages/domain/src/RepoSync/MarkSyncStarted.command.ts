import * as Domain from '@alchemy.run/domain';

import { NotCurrentJob } from './NotCurrentJob.rejection.ts';
import { JobId, RepoId } from './RepoSync.id.ts';

export class SyncStarted extends Domain.Event('SyncStarted', { jobId: JobId }) {}

/**
 * The run's first step began. A retried step sends it again and records
 * nothing; a run that is no longer current is refused, so it stops.
 */
export class MarkSyncStarted extends Domain.Command('MarkSyncStarted', {
  target: RepoId,
  input: { jobId: JobId },
  events: [SyncStarted],
  rejects: [NotCurrentJob],
}) {}
