import * as Domain from '@alchemy.run/domain';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import { AdmissionExpired } from './ExpireAdmission.command.ts';
import { SyncLost } from './ExpireSync.command.ts';
import { SyncFailed } from './FailSync.command.ts';
import { SyncFinished } from './FinishSync.command.ts';
import { SyncStarted } from './MarkSyncStarted.command.ts';
import { SyncPaused } from './PauseSync.command.ts';
import { SyncProgressed } from './RecordSyncProgress.command.ts';
import { RepoSync } from './RepoSync.aggregate.ts';
import { SyncJobStore } from './SyncJobStore.ts';

import type { SyncJobUpdate } from './SyncJobStore.ts';

/**
 * Keeps `sync_jobs` in step with each run, so admission's quota counts and
 * the web app's job history read what the model decided. Admission inserts
 * the row; this only updates it. A paused run stays `running`, as it does on
 * the Workflow engine.
 */
export class SyncJobLedger extends Domain.Projection('SyncJobLedger', {
  from: [RepoSync],
  key: RepoSync,
  on: [
    SyncStarted,
    SyncProgressed,
    SyncPaused,
    SyncFinished,
    SyncFailed,
    SyncLost,
    AdmissionExpired,
  ],
}) {}

export const SyncJobLedgerLive = SyncJobLedger.toLayer(
  Effect.gen(function* () {
    const store = yield* SyncJobStore;
    return Effect.fn(function* (batch) {
      yield* store.apply(
        batch.map(({ event, envelope }): SyncJobUpdate => {
          const at = DateTime.formatIso(envelope.at);
          switch (event._tag) {
            case 'SyncStarted':
            case 'SyncPaused':
              return { jobId: event.jobId, status: 'running', progressAt: at };
            case 'SyncProgressed':
              return { jobId: event.jobId, progressAt: at, pointsSpent: event.pointsSpent };
            case 'SyncFinished':
              return {
                jobId: event.jobId,
                status: event.outcome,
                pointsSpent: event.pointsSpent,
                finishedAt: at,
              };
            case 'SyncFailed':
              return {
                jobId: event.jobId,
                status: 'errored',
                error: event.error,
                pointsSpent: event.pointsSpent,
                finishedAt: at,
              };
            case 'SyncLost':
              return {
                jobId: event.jobId,
                status: 'errored',
                error: `lost: ${event.reason}`,
                finishedAt: at,
              };
            case 'AdmissionExpired':
              return {
                jobId: event.jobId,
                status: 'errored',
                error: 'lost: never admitted',
                finishedAt: at,
              };
          }
        }),
      );
    });
  }),
);
