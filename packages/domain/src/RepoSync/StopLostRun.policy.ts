import * as Domain from '@alchemy.run/domain';
import * as Effect from 'effect/Effect';

import { SyncLost } from './ExpireSync.command.ts';
import { RepoSync } from './RepoSync.aggregate.ts';
import { SyncRunner } from './SyncRunner.external.ts';

/**
 * Whenever a run is given up, stop its Workflow, in case it is still going
 * somewhere: its reports are refused from now on anyway.
 */
export class StopLostRun extends Domain.Policy('StopLostRun', {
  from: RepoSync,
  on: [SyncLost],
}) {}

export const StopLostRunLive = StopLostRun.toLayer(
  Effect.gen(function* () {
    const runner = yield* SyncRunner;
    return Effect.fn(function* ({ event }) {
      yield* runner.stop({ jobId: event.jobId });
    });
  }),
);
