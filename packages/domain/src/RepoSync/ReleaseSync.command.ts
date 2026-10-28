import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { JobId, RepoId } from './RepoSync.id.ts';

export class SyncReleased extends Domain.Event('SyncReleased', {
  jobId: JobId,
  reason: Schema.String,
}) {}

/**
 * The requested run was not admitted (over quota): free the repository. It
 * undoes a request, so it never rejects, and records nothing once that
 * request is no longer waiting.
 */
export class ReleaseSync extends Domain.Command('ReleaseSync', {
  target: RepoId,
  input: { jobId: JobId, reason: Schema.String },
  events: [SyncReleased],
}) {}
