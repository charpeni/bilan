import * as Domain from '@alchemy.run/domain';
import * as Layer from 'effect/Layer';

import { RepoSync } from './RepoSync/RepoSync.aggregate.ts';
import { RepoSyncStatus } from './RepoSync/RepoSyncStatus.view.ts';
import { StartSyncRun, StartSyncRunLive } from './RepoSync/StartSyncRun.policy.ts';
import { StopLostRun, StopLostRunLive } from './RepoSync/StopLostRun.policy.ts';
import { SyncDeadlines, SyncDeadlinesLive } from './RepoSync/SyncDeadlines.policy.ts';
import { SyncJobLedger, SyncJobLedgerLive } from './RepoSync/SyncJobLedger.projection.ts';

/** Repository syncs: who may sync what, when a run counts as lost, and where each stands. */
export class BilanSync extends Domain.Model('BilanSync', {
  aggregates: [RepoSync],
  views: [RepoSyncStatus],
  policies: [SyncDeadlines, StartSyncRun, StopLostRun],
  projections: [SyncJobLedger],
}) {}

/** The policies' and projection's implementations. They require `SyncRunner` and `SyncJobStore`. */
export const BilanSyncHandlers = Layer.mergeAll(
  SyncDeadlinesLive,
  StartSyncRunLive,
  StopLostRunLive,
  SyncJobLedgerLive,
);
