import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { JobId, RepoId } from './RepoSync.id.ts';
import { SyncRun } from './SyncRun.ts';

/** The repository already has a run in progress, which the caller can follow instead. */
export class SyncAlreadyRunning extends Domain.Rejection('SyncAlreadyRunning', {
  jobId: JobId,
}) {}

export class SyncRequested extends Domain.Event('SyncRequested', {
  jobId: JobId,
  requestedBy: Schema.Int,
  run: SyncRun,
}) {}

/**
 * Ask to sync a repository. Only one run per repository at a time; the
 * request then waits for admission (the cross-repository quotas) before it
 * starts.
 */
export class RequestSync extends Domain.Command('RequestSync', {
  target: RepoId,
  input: { jobId: JobId, requestedBy: Schema.Int, run: SyncRun },
  events: [SyncRequested],
  rejects: [SyncAlreadyRunning],
}) {}
