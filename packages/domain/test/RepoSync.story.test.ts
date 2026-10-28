import { Story } from '@alchemy.run/domain/Story';
import { expect, it } from '@effect/vitest';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { BilanSync, BilanSyncHandlers } from '../src/BilanSync.model.ts';
import { AdmitSync, SyncAdmitted } from '../src/RepoSync/AdmitSync.command.ts';
import { AdmissionExpired } from '../src/RepoSync/ExpireAdmission.command.ts';
import { SyncLost } from '../src/RepoSync/ExpireSync.command.ts';
import { FailSync, SyncFailed } from '../src/RepoSync/FailSync.command.ts';
import { FinishSync, SyncFinished } from '../src/RepoSync/FinishSync.command.ts';
import { MarkSyncStarted, SyncStarted } from '../src/RepoSync/MarkSyncStarted.command.ts';
import { NotCurrentJob } from '../src/RepoSync/NotCurrentJob.rejection.ts';
import { PauseSync, SyncPaused } from '../src/RepoSync/PauseSync.command.ts';
import { RecordSyncProgress, SyncProgressed } from '../src/RepoSync/RecordSyncProgress.command.ts';
import { ReleaseSync, SyncReleased } from '../src/RepoSync/ReleaseSync.command.ts';
import { RepoSync } from '../src/RepoSync/RepoSync.aggregate.ts';
import { JobId } from '../src/RepoSync/RepoSync.id.ts';
import { RepoSyncStatus } from '../src/RepoSync/RepoSyncStatus.view.ts';
import {
  RequestSync,
  SyncAlreadyRunning,
  SyncRequested,
} from '../src/RepoSync/RequestSync.command.ts';
import { MemorySyncJobStore, memorySyncJobs } from '../src/RepoSync/SyncJobStore.ts';
import { SyncRunner } from '../src/RepoSync/SyncRunner.external.ts';

import type { SyncRun } from '../src/RepoSync/SyncRun.ts';

const { clock, given, rejected, state, then, view, when } = Story;
const { expectCall, resolve } = Story;

const story = Story.make(BilanSync, {
  layer: BilanSyncHandlers.pipe(Layer.provide(MemorySyncJobStore)),
  externalSystems: [SyncRunner],
});

const repo = RepoSync.ref('R_bilan');
const j1 = JobId.make('job-1');
const j2 = JobId.make('job-2');
const run: SyncRun = {
  owner: 'charpeni',
  name: 'bilan',
  mode: 'incremental',
  depth: '30d',
  since: '2026-09-28T12:00:00.000Z',
  maxPrs: null,
  tokenSource: { _tag: 'User', userId: 7189823 },
};
const requested = (jobId = j1) => new SyncRequested({ jobId, requestedBy: 7189823, run });
const expired = new AdmissionExpired({ jobId: j1, requestedBy: 7189823, mode: 'incremental' });
const at = (iso: string) => DateTime.makeUnsafe(iso);

/** Request and admit `j1` at noon, and let the runner start it. */
const admitted = [
  clock('2026-10-28T12:00:00Z'),
  when(repo, new RequestSync({ jobId: j1, requestedBy: 7189823, run })),
  then(repo, requested()),
  when(repo, new AdmitSync({ jobId: j1 })),
  then(repo, new SyncAdmitted({ jobId: j1, run })),
  expectCall(SyncRunner.start, { jobId: j1 }),
  resolve(SyncRunner.start, undefined),
] as const;

/** `admitted`, then the run's first step reports in at 12:01. */
const started = [
  ...admitted,
  clock('2026-10-28T12:01:00Z'),
  when(repo, new MarkSyncStarted({ jobId: j1 })),
  then(repo, new SyncStarted({ jobId: j1 })),
] as const;

it.effect('a run goes from request to its end, and the repository is free again', () =>
  story(
    ...started,
    view(RepoSyncStatus, repo, { phase: 'running', jobId: j1 }),
    when(repo, new RecordSyncProgress({ jobId: j1, prsFetched: 25, pointsSpent: 12 })),
    then(repo, new SyncProgressed({ jobId: j1, prsFetched: 25, pointsSpent: 12 })),
    view(RepoSyncStatus, repo, { phase: 'running', prsFetched: 25 }),
    when(repo, new FinishSync({ jobId: j1, outcome: 'complete', pointsSpent: 30 })),
    then(repo, new SyncFinished({ jobId: j1, outcome: 'complete', pointsSpent: 30 })),
    view(RepoSyncStatus, repo, {
      phase: 'idle',
      jobId: null,
      last: { jobId: j1, outcome: 'complete' },
    }),
    // The next request is accepted.
    when(repo, new RequestSync({ jobId: j2, requestedBy: 7189823, run })),
    then(repo, requested(j2)),
  ),
);

it.effect('a second request while one runs is refused with the running job', () =>
  story(
    ...started,
    when(repo, new RequestSync({ jobId: j2, requestedBy: 42, run })),
    rejected(new SyncAlreadyRunning({ jobId: j1 })),
  ),
);

it.effect('a request waiting for admission blocks a second one too', () =>
  story(
    given(repo, requested()),
    when(repo, new RequestSync({ jobId: j2, requestedBy: 42, run })),
    rejected(new SyncAlreadyRunning({ jobId: j1 })),
  ),
);

it.effect('a request over quota is released, and nothing starts', () =>
  story(
    clock('2026-10-28T12:00:00Z'),
    when(repo, new RequestSync({ jobId: j1, requestedBy: 7189823, run })),
    then(repo, requested()),
    when(repo, new ReleaseSync({ jobId: j1, reason: 'quota' })),
    then(repo, new SyncReleased({ jobId: j1, reason: 'quota' })),
    view(RepoSyncStatus, repo, {
      phase: 'idle',
      last: { jobId: j1, outcome: 'released' },
      lastError: 'quota',
    }),
    // Its admission deadline passes without effect.
    clock('2026-10-28T12:05:00Z'),
    then(repo),
    // A late admission for it is refused.
    when(repo, new AdmitSync({ jobId: j1 })),
    rejected(new NotCurrentJob({ current: null })),
  ),
);

it.effect('releasing twice records the release once', () =>
  story(
    given(repo, requested()),
    when(repo, new ReleaseSync({ jobId: j1, reason: 'quota' })),
    then(repo, new SyncReleased({ jobId: j1, reason: 'quota' })),
    when(repo, new ReleaseSync({ jobId: j1, reason: 'quota' })),
    then(repo),
  ),
);

it.effect('a request nobody admits or releases expires after two minutes', () =>
  story(
    clock('2026-10-28T12:00:00Z'),
    when(repo, new RequestSync({ jobId: j1, requestedBy: 7189823, run })),
    then(repo, requested()),
    clock('2026-10-28T12:01:59Z'),
    then(repo),
    clock('2026-10-28T12:02:00Z'),
    then(repo, expired),
    view(RepoSyncStatus, repo, {
      phase: 'idle',
      last: { jobId: j1, outcome: 'expired' },
    }),
  ),
);

it.effect('admission that lands after the request expired finds its job taken', () =>
  Effect.gen(function* () {
    const jobs = memorySyncJobs();
    const ledgerStory = Story.make(BilanSync, {
      layer: BilanSyncHandlers.pipe(Layer.provide(jobs.layer)),
      externalSystems: [SyncRunner],
    });
    // The caller asked, then took over two minutes to insert the row.
    yield* ledgerStory(
      clock('2026-10-28T12:00:00Z'),
      when(repo, new RequestSync({ jobId: j1, requestedBy: 7189823, run })),
      then(repo, requested()),
      clock('2026-10-28T12:02:00Z'),
      then(repo, expired),
    );
    // The ledger recorded the request, so the late insert admits nothing:
    // no row is left queued, blocking the repository and its quotas.
    expect(yield* jobs.admit(j1)).toBe(false);
    expect(yield* jobs.get(j1)).toEqual({
      status: 'errored',
      error: 'lost: never admitted',
      finishedAt: '2026-10-28T12:02:00.000Z',
    });
  }),
);

it.effect('a retried first step records nothing', () =>
  story(...started, when(repo, new MarkSyncStarted({ jobId: j1 })), then(repo)),
);

it.effect('a run that never starts is lost ten minutes after admission, and stopped', () =>
  story(
    ...admitted,
    clock('2026-10-28T12:09:59Z'),
    then(repo),
    clock('2026-10-28T12:10:00Z'),
    then(repo, new SyncLost({ jobId: j1, reason: 'never started' })),
    expectCall(SyncRunner.stop, { jobId: j1 }),
    resolve(SyncRunner.stop, undefined),
    view(RepoSyncStatus, repo, {
      phase: 'idle',
      last: { jobId: j1, outcome: 'lost' },
      lastError: 'never started',
    }),
  ),
);

it.effect('each report pushes the stall check back; ten silent minutes lose the run', () =>
  story(
    ...started,
    clock('2026-10-28T12:09:00Z'),
    when(repo, new RecordSyncProgress({ jobId: j1, prsFetched: 25, pointsSpent: 12 })),
    then(repo, new SyncProgressed({ jobId: j1, prsFetched: 25, pointsSpent: 12 })),
    // Ten minutes after the start: an older check, now stale.
    clock('2026-10-28T12:11:00Z'),
    then(repo),
    clock('2026-10-28T12:18:59Z'),
    then(repo),
    // Ten minutes after the last report.
    clock('2026-10-28T12:19:00Z'),
    then(repo, new SyncLost({ jobId: j1, reason: 'no progress' })),
    expectCall(SyncRunner.stop, { jobId: j1 }),
    resolve(SyncRunner.stop, undefined),
  ),
);

it.effect('a rate-limit pause is not a stall, until ten minutes after it should end', () =>
  story(
    ...started,
    when(repo, new PauseSync({ jobId: j1, until: at('2026-10-28T12:45:00Z') })),
    then(repo, new SyncPaused({ jobId: j1, until: at('2026-10-28T12:45:00Z') })),
    view(RepoSyncStatus, repo, { phase: 'paused', pausedUntil: at('2026-10-28T12:45:00Z') }),
    clock('2026-10-28T12:30:00Z'),
    then(repo),
    clock('2026-10-28T12:54:59Z'),
    then(repo),
    clock('2026-10-28T12:55:00Z'),
    then(repo, new SyncLost({ jobId: j1, reason: 'did not resume after its rate-limit pause' })),
    expectCall(SyncRunner.stop, { jobId: j1 }),
    resolve(SyncRunner.stop, undefined),
  ),
);

it.effect('a run that resumes after its pause carries on', () =>
  story(
    ...started,
    when(repo, new PauseSync({ jobId: j1, until: at('2026-10-28T12:45:00Z') })),
    then(repo, new SyncPaused({ jobId: j1, until: at('2026-10-28T12:45:00Z') })),
    clock('2026-10-28T12:46:00Z'),
    when(repo, new RecordSyncProgress({ jobId: j1, prsFetched: 50, pointsSpent: 20 })),
    then(repo, new SyncProgressed({ jobId: j1, prsFetched: 50, pointsSpent: 20 })),
    view(RepoSyncStatus, repo, { phase: 'running', pausedUntil: null }),
    // The pause's own check is stale now.
    clock('2026-10-28T12:55:00Z'),
    then(repo),
    when(repo, new FinishSync({ jobId: j1, outcome: 'partial', pointsSpent: 40 })),
    then(repo, new SyncFinished({ jobId: j1, outcome: 'partial', pointsSpent: 40 })),
  ),
);

it.effect('a run is lost after six hours even while it keeps reporting', () =>
  story(
    ...started,
    // A report every nine minutes, inside the stall window, until 17:52.
    ...Array.from({ length: 39 }, (_, i) => {
      const time = new Date(Date.parse('2026-10-28T12:10:00Z') + i * 9 * 60_000);
      return [
        clock(time.toISOString()),
        when(repo, new RecordSyncProgress({ jobId: j1, prsFetched: i, pointsSpent: i })),
        then(repo, new SyncProgressed({ jobId: j1, prsFetched: i, pointsSpent: i })),
      ] as const;
    }).flat(),
    clock('2026-10-28T18:00:00Z'),
    then(repo, new SyncLost({ jobId: j1, reason: 'ran past its time limit' })),
    expectCall(SyncRunner.stop, { jobId: j1 }),
    resolve(SyncRunner.stop, undefined),
  ),
);

it.effect('a lost run is refused when it reports again', () =>
  story(
    ...admitted,
    clock('2026-10-28T12:10:00Z'),
    then(repo, new SyncLost({ jobId: j1, reason: 'never started' })),
    expectCall(SyncRunner.stop, { jobId: j1 }),
    resolve(SyncRunner.stop, undefined),
    when(repo, new MarkSyncStarted({ jobId: j1 })),
    rejected(new NotCurrentJob({ current: null })),
    when(repo, new FinishSync({ jobId: j1, outcome: 'complete', pointsSpent: 1 })),
    rejected(new NotCurrentJob({ current: null })),
  ),
);

it.effect('a report about another job is refused with the current one', () =>
  story(
    ...started,
    when(repo, new RecordSyncProgress({ jobId: j2, prsFetched: 1, pointsSpent: 1 })),
    rejected(new NotCurrentJob({ current: j1 })),
    state(repo, (s) => expect(s._tag).toBe('Running')),
  ),
);

it.effect('a run that fails in its first step frees the repository', () =>
  story(
    ...admitted,
    when(repo, new FailSync({ jobId: j1, error: 'GitHub: Not Found', pointsSpent: 0 })),
    then(repo, new SyncFailed({ jobId: j1, error: 'GitHub: Not Found', pointsSpent: 0 })),
    view(RepoSyncStatus, repo, {
      phase: 'idle',
      last: { jobId: j1, outcome: 'failed' },
      lastError: 'GitHub: Not Found',
    }),
    // Its stall check passes without effect.
    clock('2026-10-28T12:10:00Z'),
    then(repo),
  ),
);

it.effect('sync_jobs follows the run: running, then how it ended', () =>
  Effect.gen(function* () {
    const jobs = memorySyncJobs();
    const ledgerStory = Story.make(BilanSync, {
      layer: BilanSyncHandlers.pipe(Layer.provide(jobs.layer)),
      externalSystems: [SyncRunner],
    });
    yield* jobs.admit(j1);
    yield* ledgerStory(
      ...started,
      clock('2026-10-28T12:02:00Z'),
      when(repo, new RecordSyncProgress({ jobId: j1, prsFetched: 25, pointsSpent: 12 })),
      then(repo, new SyncProgressed({ jobId: j1, prsFetched: 25, pointsSpent: 12 })),
    );
    expect(yield* jobs.get(j1)).toEqual({
      status: 'running',
      progressAt: '2026-10-28T12:02:00.000Z',
      pointsSpent: 12,
    });

    const lost = memorySyncJobs();
    const lostStory = Story.make(BilanSync, {
      layer: BilanSyncHandlers.pipe(Layer.provide(lost.layer)),
      externalSystems: [SyncRunner],
    });
    yield* lost.admit(j1);
    yield* lostStory(
      ...started,
      clock('2026-10-28T12:11:00Z'),
      then(repo, new SyncLost({ jobId: j1, reason: 'no progress' })),
      expectCall(SyncRunner.stop, { jobId: j1 }),
      resolve(SyncRunner.stop, undefined),
    );
    expect(yield* lost.get(j1)).toEqual({
      status: 'errored',
      progressAt: '2026-10-28T12:01:00.000Z',
      error: 'lost: no progress',
      finishedAt: '2026-10-28T12:11:00.000Z',
    });
  }),
);
