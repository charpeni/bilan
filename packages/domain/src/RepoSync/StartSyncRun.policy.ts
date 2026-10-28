import * as Domain from '@alchemy.run/domain';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { SyncAdmitted } from './AdmitSync.command.ts';
import { FailSync } from './FailSync.command.ts';
import { RepoSync } from './RepoSync.aggregate.ts';
import { RUNNER_RETRY, SyncRunner } from './SyncRunner.external.ts';

/**
 * Whenever a run is admitted, start it. A runner that still fails after
 * `RUNNER_RETRY` fails the run, so the repository is free again at once
 * instead of after the stall window.
 */
export class StartSyncRun extends Domain.Policy('StartSyncRun', {
  from: RepoSync,
  on: [SyncAdmitted],
}) {}

export const StartSyncRunLive = StartSyncRun.toLayer(
  Effect.gen(function* () {
    const runner = yield* SyncRunner;
    const repos = yield* RepoSync;
    return Effect.fn(function* ({ source, event }) {
      yield* runner.start({ jobId: event.jobId, repoId: source.id, run: event.run }).pipe(
        Effect.retry({
          schedule: Schedule.exponential(RUNNER_RETRY.base),
          times: RUNNER_RETRY.times,
        }),
        Effect.catchTag('SyncRunnerUnavailable', ({ reason }) =>
          repos
            .send(
              source,
              new FailSync({
                jobId: event.jobId,
                error: `could not start: ${reason}`,
                pointsSpent: 0,
              }),
            )
            // The run already ended some other way: nothing left to fail.
            .pipe(
              Effect.catchTag('NotCurrentJob', () => Effect.void),
              Effect.asVoid,
            ),
        ),
      );
    });
  }),
);
