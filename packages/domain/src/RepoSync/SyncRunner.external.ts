import * as Domain from '@alchemy.run/domain';

import { JobId, RepoId } from './RepoSync.id.ts';
import { SyncRun } from './SyncRun.ts';

/**
 * What runs a sync: in production, the `sync-repo` Workflow on bilan-sync.
 * Both calls are made at least once, so an adapter keys them by `jobId`: a
 * second `start` finds the run already started, a second `stop` finds it
 * already stopped.
 */
export class SyncRunner extends Domain.ExternalSystem('SyncRunner', {
  start: { args: { jobId: JobId, repoId: RepoId, run: SyncRun } },
  stop: { args: { jobId: JobId } },
}) {}
