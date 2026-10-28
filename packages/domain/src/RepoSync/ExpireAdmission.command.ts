import * as Domain from '@alchemy.run/domain';

import { JobId, RepoId } from './RepoSync.id.ts';

export class AdmissionExpired extends Domain.Event('AdmissionExpired', { jobId: JobId }) {}

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
