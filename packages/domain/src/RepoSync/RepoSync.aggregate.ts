import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

import { AdmitSync, SyncAdmitted } from './AdmitSync.command.ts';
import { AdmissionExpired, ExpireAdmission } from './ExpireAdmission.command.ts';
import { ExpireStalledSync } from './ExpireStalledSync.command.ts';
import { ExpireSync, SyncLost } from './ExpireSync.command.ts';
import { FailSync, SyncFailed } from './FailSync.command.ts';
import { FinishSync, SyncFinished } from './FinishSync.command.ts';
import { MarkSyncStarted, SyncStarted } from './MarkSyncStarted.command.ts';
import { NotCurrentJob } from './NotCurrentJob.rejection.ts';
import { PauseSync, SyncPaused } from './PauseSync.command.ts';
import { RecordSyncProgress, SyncProgressed } from './RecordSyncProgress.command.ts';
import { ReleaseSync, SyncReleased } from './ReleaseSync.command.ts';
import { JobId, RepoId } from './RepoSync.id.ts';
import { RequestSync, SyncAlreadyRunning, SyncRequested } from './RequestSync.command.ts';
import { SyncRun } from './SyncRun.ts';

/** How the last run ended, for the next request and for screens. */
export const LastSync = Schema.Struct({
  jobId: JobId,
  outcome: Schema.Literals(['complete', 'partial', 'failed', 'lost', 'released', 'expired']),
});

/** A run past admission: `beat` is the seq of the event that last armed its stall check. */
const Run = { jobId: JobId, beat: Schema.Int, prsFetched: Schema.Int, pointsSpent: Schema.Int };

export const RepoSyncState = Schema.Union([
  Schema.TaggedStruct('Idle', { last: Schema.NullOr(LastSync) }),
  Schema.TaggedStruct('Admitting', { jobId: JobId, requestedBy: Schema.Int, run: SyncRun }),
  Schema.TaggedStruct('Queued', Run),
  Schema.TaggedStruct('Running', Run),
  Schema.TaggedStruct('Paused', { ...Run, until: Schema.DateTimeUtc }),
]);
export type RepoSyncState = typeof RepoSyncState.Type;

type Active = Extract<RepoSyncState, { _tag: 'Queued' | 'Running' | 'Paused' }>;
type Started = Extract<RepoSyncState, { _tag: 'Running' | 'Paused' }>;

const currentJob = (s: RepoSyncState): string | null => ('jobId' in s ? s.jobId : null);
const notCurrent = (s: RepoSyncState) => new NotCurrentJob({ current: currentJob(s) });

/** The run `jobId` names, past admission, or null when it is not the current one. */
const activeRun = (s: RepoSyncState, jobId: string): Active | null =>
  (s._tag === 'Queued' || s._tag === 'Running' || s._tag === 'Paused') && s.jobId === jobId
    ? s
    : null;

/** The run `jobId` names, once its first step began. */
const startedRun = (s: RepoSyncState, jobId: string): Started | null =>
  (s._tag === 'Running' || s._tag === 'Paused') && s.jobId === jobId ? s : null;

const ended = (jobId: JobId, outcome: typeof LastSync.Type.outcome): RepoSyncState => ({
  _tag: 'Idle',
  last: { jobId, outcome },
});

/**
 * One repository's sync: at most one run at a time, from request to its end.
 * It is the only record of whether a repository is syncing, so nothing has to
 * reconcile it against the Workflow engine. Runs that stop reporting are given
 * up by deadlines it schedules on itself (`SyncDeadlines`), decided here like
 * any other command, so a late report and its deadline cannot both win.
 */
export class RepoSync extends Domain.Aggregate('RepoSync', {
  id: RepoId,
  state: RepoSyncState,
  initial: { _tag: 'Idle', last: null },
  commands: [
    RequestSync,
    AdmitSync,
    ReleaseSync,
    ExpireAdmission,
    MarkSyncStarted,
    RecordSyncProgress,
    PauseSync,
    FinishSync,
    FailSync,
    ExpireStalledSync,
    ExpireSync,
  ],
  decide: {
    RequestSync: (s, cmd) => {
      const current = currentJob(s);
      if (current !== null) return new SyncAlreadyRunning({ jobId: JobId.make(current) });
      return [new SyncRequested({ jobId: cmd.jobId, requestedBy: cmd.requestedBy, run: cmd.run })];
    },
    AdmitSync: (s, cmd) =>
      s._tag === 'Admitting' && s.jobId === cmd.jobId
        ? [new SyncAdmitted({ jobId: s.jobId, run: s.run })]
        : notCurrent(s),
    ReleaseSync: (s, cmd) =>
      s._tag === 'Admitting' && s.jobId === cmd.jobId
        ? [new SyncReleased({ jobId: cmd.jobId, reason: cmd.reason })]
        : [],
    ExpireAdmission: (s, cmd) =>
      s._tag === 'Admitting' && s.jobId === cmd.jobId
        ? [
            new AdmissionExpired({
              jobId: cmd.jobId,
              requestedBy: s.requestedBy,
              mode: s.run.mode,
            }),
          ]
        : [],
    MarkSyncStarted: (s, cmd) => {
      const run = activeRun(s, cmd.jobId);
      if (run === null) return notCurrent(s);
      // A retried first step: already started.
      return run._tag === 'Queued' ? [new SyncStarted({ jobId: cmd.jobId })] : [];
    },
    RecordSyncProgress: (s, cmd) =>
      startedRun(s, cmd.jobId) === null
        ? notCurrent(s)
        : [
            new SyncProgressed({
              jobId: cmd.jobId,
              prsFetched: cmd.prsFetched,
              pointsSpent: cmd.pointsSpent,
            }),
          ],
    PauseSync: (s, cmd) =>
      startedRun(s, cmd.jobId) === null
        ? notCurrent(s)
        : [new SyncPaused({ jobId: cmd.jobId, until: cmd.until })],
    FinishSync: (s, cmd) =>
      startedRun(s, cmd.jobId) === null
        ? notCurrent(s)
        : [
            new SyncFinished({
              jobId: cmd.jobId,
              outcome: cmd.outcome,
              pointsSpent: cmd.pointsSpent,
            }),
          ],
    // A run can fail in its first step, before it reported starting.
    FailSync: (s, cmd) =>
      activeRun(s, cmd.jobId) === null
        ? notCurrent(s)
        : [new SyncFailed({ jobId: cmd.jobId, error: cmd.error, pointsSpent: cmd.pointsSpent })],
    ExpireStalledSync: (s, cmd) => {
      const run = activeRun(s, cmd.jobId);
      if (run === null || run.beat !== cmd.beat) return [];
      const reason =
        run._tag === 'Paused'
          ? 'did not resume after its rate-limit pause'
          : run._tag === 'Queued'
            ? 'never started'
            : 'no progress';
      return [new SyncLost({ jobId: cmd.jobId, reason })];
    },
    ExpireSync: (s, cmd) =>
      activeRun(s, cmd.jobId) === null
        ? []
        : [new SyncLost({ jobId: cmd.jobId, reason: 'ran past its time limit' })],
  },
  evolve: {
    SyncRequested: (_, e) => ({
      _tag: 'Admitting' as const,
      jobId: e.jobId,
      requestedBy: e.requestedBy,
      run: e.run,
    }),
    SyncAdmitted: (_, e, { seq }) => ({
      _tag: 'Queued' as const,
      jobId: e.jobId,
      beat: seq,
      prsFetched: 0,
      pointsSpent: 0,
    }),
    SyncReleased: (_, e) => ended(e.jobId, 'released'),
    AdmissionExpired: (_, e) => ended(e.jobId, 'expired'),
    SyncStarted: (s, _, { seq }) =>
      s._tag === 'Queued' ? { ...s, _tag: 'Running' as const, beat: seq } : s,
    SyncProgressed: (s, e, { seq }) =>
      s._tag === 'Running' || s._tag === 'Paused'
        ? {
            _tag: 'Running' as const,
            jobId: s.jobId,
            beat: seq,
            prsFetched: e.prsFetched,
            pointsSpent: e.pointsSpent,
          }
        : s,
    SyncPaused: (s, e, { seq }) =>
      s._tag === 'Running' || s._tag === 'Paused'
        ? {
            _tag: 'Paused' as const,
            jobId: s.jobId,
            beat: seq,
            prsFetched: s.prsFetched,
            pointsSpent: s.pointsSpent,
            until: e.until,
          }
        : s,
    SyncFinished: (_, e) => ended(e.jobId, e.outcome),
    SyncFailed: (_, e) => ended(e.jobId, 'failed'),
    SyncLost: (_, e) => ended(e.jobId, 'lost'),
  },
}) {}
