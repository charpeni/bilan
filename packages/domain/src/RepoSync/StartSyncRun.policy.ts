import * as Domain from '@alchemy.run/domain';
import * as Effect from 'effect/Effect';

import { SyncAdmitted } from './AdmitSync.command.ts';
import { RepoSync } from './RepoSync.aggregate.ts';
import { SyncRunner } from './SyncRunner.external.ts';

/** Whenever a run is admitted, start it. */
export class StartSyncRun extends Domain.Policy('StartSyncRun', {
  from: RepoSync,
  on: [SyncAdmitted],
}) {}

export const StartSyncRunLive = StartSyncRun.toLayer(
  Effect.gen(function* () {
    const runner = yield* SyncRunner;
    return Effect.fn(function* ({ source, event }) {
      yield* runner.start({ jobId: event.jobId, repoId: source.id, run: event.run });
    });
  }),
);
