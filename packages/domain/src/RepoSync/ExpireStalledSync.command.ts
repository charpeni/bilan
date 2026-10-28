import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { SyncLost } from './ExpireSync.command.ts';
import { JobId, RepoId } from './RepoSync.id.ts';

/**
 * Check that the run reported since `beat`: the sequence number of the event
 * that scheduled this check. Every admission, start, progress, and pause
 * schedules a fresh one, so only the newest can find the run silent.
 * Scheduled by `SyncDeadlines`; records nothing when the run moved on.
 */
export class ExpireStalledSync extends Domain.Command('ExpireStalledSync', {
  target: RepoId,
  input: { jobId: JobId, beat: Schema.Int },
  events: [SyncLost],
}) {}
