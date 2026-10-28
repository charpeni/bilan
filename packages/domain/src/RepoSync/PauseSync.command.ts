import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { NotCurrentJob } from './NotCurrentJob.rejection.ts';
import { JobId, RepoId } from './RepoSync.id.ts';

export class SyncPaused extends Domain.Event('SyncPaused', {
  jobId: JobId,
  until: Schema.DateTimeUtc,
}) {}

/**
 * The run sleeps until GitHub's rate limit resets. Said up front, so a quiet
 * run is never mistaken for a stalled one.
 */
export class PauseSync extends Domain.Command('PauseSync', {
  target: RepoId,
  input: { jobId: JobId, until: Schema.DateTimeUtc },
  events: [SyncPaused],
  rejects: [NotCurrentJob],
}) {}
