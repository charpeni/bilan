import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { JobId, RepoId } from './RepoSync.id.ts';
import { SyncRun } from './SyncRun.ts';

/** The runner could not be reached, or would not take the call. */
export class SyncRunnerUnavailable extends Schema.TaggedError<SyncRunnerUnavailable>()(
  'SyncRunnerUnavailable',
  { reason: Schema.String },
) {}

/**
 * What runs a sync: in production, the `sync-repo` Workflow on bilan-sync.
 * Both calls are made at least once, so an adapter keys them by `jobId`: a
 * second `start` finds the run already started, a second `stop` finds it
 * already stopped. Any other failure is `SyncRunnerUnavailable`, which the
 * policies retry for a while and then settle (`StartSyncRun`, `StopLostRun`).
 */
export class SyncRunner extends Domain.ExternalSystem('SyncRunner', {
  start: { args: { jobId: JobId, repoId: RepoId, run: SyncRun }, error: SyncRunnerUnavailable },
  stop: { args: { jobId: JobId }, error: SyncRunnerUnavailable },
}) {}

/**
 * How a policy retries a runner call before settling it: five attempts over
 * about 15 seconds. A call that fails for good must not hold the policy's
 * inbox for its repository, as the platform's own redelivery would, forever.
 */
export const RUNNER_RETRY = { times: 4, base: '1 second' } as const;
