import * as Domain from '@alchemy.run/domain';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { SyncLost } from './ExpireSync.command.ts';
import { RepoSync } from './RepoSync.aggregate.ts';
import { RUNNER_RETRY, SyncRunner } from './SyncRunner.external.ts';

/**
 * Whenever a run is given up, stop its Workflow, in case it is still going
 * somewhere: its reports are refused from now on anyway, so a stop that
 * still fails after `RUNNER_RETRY` is logged and left there.
 */
export class StopLostRun extends Domain.Policy('StopLostRun', {
  from: RepoSync,
  on: [SyncLost],
}) {}

export const StopLostRunLive = StopLostRun.toLayer(
  Effect.gen(function* () {
    const runner = yield* SyncRunner;
    return Effect.fn(function* ({ event }) {
      yield* runner.stop({ jobId: event.jobId }).pipe(
        Effect.retry({
          schedule: Schedule.exponential(RUNNER_RETRY.base),
          times: RUNNER_RETRY.times,
        }),
        Effect.catchTag('SyncRunnerUnavailable', ({ reason }) =>
          Effect.logWarning(`could not stop lost run ${event.jobId}: ${reason}`),
        ),
      );
    });
  }),
);
