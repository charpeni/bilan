import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { JobId, RepoId } from './RepoSync.id.ts';
import { SyncRun } from './SyncRun.ts';

export class AdmissionExpired extends Domain.Event('AdmissionExpired', {
  jobId: JobId,
  /**
   * Who asked, and for what: enough for `SyncJobLedger` to record the request
   * in `sync_jobs` when admission never inserted its row. Absent on events
   * recorded before they were added.
   */
  requestedBy: Schema.optional(Schema.Int),
  mode: Schema.optional(SyncRun.fields.mode),
}) {}

/**
 * Nobody admitted or released the request in time (the caller died between
 * the two). Scheduled by `SyncDeadlines`; records nothing once the request
 * has moved on.
 */
export class ExpireAdmission extends Domain.Command('ExpireAdmission', {
  target: RepoId,
  input: { jobId: JobId },
  events: [AdmissionExpired],
}) {}
