import * as Domain from '@alchemy.run/domain';

import { NotCurrentJob } from './NotCurrentJob.rejection.ts';
import { JobId, RepoId } from './RepoSync.id.ts';
import { SyncRun } from './SyncRun.ts';

/** Carries the run, so the policy that starts it needs nothing else. */
export class SyncAdmitted extends Domain.Event('SyncAdmitted', { jobId: JobId, run: SyncRun }) {}

/** The requested run fits the quotas: queue it. */
export class AdmitSync extends Domain.Command('AdmitSync', {
  target: RepoId,
  input: { jobId: JobId },
  events: [SyncAdmitted],
  rejects: [NotCurrentJob],
}) {}
