import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { NotCurrentJob } from './NotCurrentJob.rejection.ts';
import { JobId, RepoId } from './RepoSync.id.ts';

export const SyncOutcome = Schema.Literals(['complete', 'partial']);

export class SyncFinished extends Domain.Event('SyncFinished', {
  jobId: JobId,
  /** `partial`: the run stopped at its page budget before covering everything asked. */
  outcome: SyncOutcome,
  pointsSpent: Schema.Int,
}) {}

export class FinishSync extends Domain.Command('FinishSync', {
  target: RepoId,
  input: { jobId: JobId, outcome: SyncOutcome, pointsSpent: Schema.Int },
  events: [SyncFinished],
  rejects: [NotCurrentJob],
}) {}
