import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { LastSync, RepoSync } from './RepoSync.aggregate.ts';
import { JobId } from './RepoSync.id.ts';

/** Where one repository's sync stands. */
export const RepoSyncStatusState = Schema.Struct({
  phase: Schema.Literals(['idle', 'admitting', 'queued', 'running', 'paused']),
  jobId: Schema.NullOr(JobId),
  prsStored: Schema.Int,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  pausedUntil: Schema.NullOr(Schema.DateTimeUtc),
  last: Schema.NullOr(LastSync),
  lastError: Schema.NullOr(Schema.String),
  lastEndedAt: Schema.NullOr(Schema.DateTimeUtc),
});
type Status = typeof RepoSyncStatusState.Type;

/**
 * Where a repository's sync stands, for screens: the current run and its
 * progress, and how the last one ended.
 */
export class RepoSyncStatus extends Domain.View('RepoSyncStatus', {
  from: [RepoSync],
  key: RepoSync,
  state: RepoSyncStatusState,
  initial: {
    phase: 'idle',
    jobId: null,
    prsStored: 0,
    startedAt: null,
    pausedUntil: null,
    last: null,
    lastError: null,
    lastEndedAt: null,
  },
  evolve: {
    SyncRequested: (v, e) => ({ ...v, phase: 'admitting' as const, jobId: e.jobId, prsStored: 0 }),
    SyncAdmitted: (v) => ({ ...v, phase: 'queued' as const }),
    SyncStarted: (v, _, { at }) => ({ ...v, phase: 'running' as const, startedAt: at }),
    SyncProgressed: (v, e) => ({
      ...v,
      phase: 'running' as const,
      prsStored: e.prsStored,
      pausedUntil: null,
    }),
    SyncPaused: (v, e) => ({ ...v, phase: 'paused' as const, pausedUntil: e.until }),
    SyncFinished: (v, e, { at }) => idle(v, { jobId: e.jobId, outcome: e.outcome }, null, at),
    SyncFailed: (v, e, { at }) => idle(v, { jobId: e.jobId, outcome: 'failed' }, e.error, at),
    SyncLost: (v, e, { at }) => idle(v, { jobId: e.jobId, outcome: 'lost' }, e.reason, at),
    SyncReleased: (v, e, { at }) => idle(v, { jobId: e.jobId, outcome: 'released' }, e.reason, at),
    AdmissionExpired: (v, e, { at }) =>
      idle(v, { jobId: e.jobId, outcome: 'expired' }, 'never admitted', at),
  },
}) {}

function idle(
  v: Status,
  last: Status['last'],
  error: string | null,
  at: Status['lastEndedAt'],
): Status {
  return {
    ...v,
    phase: 'idle',
    jobId: null,
    startedAt: null,
    pausedUntil: null,
    last,
    lastError: error,
    lastEndedAt: at,
  };
}
