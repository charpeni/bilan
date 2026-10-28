import * as Domain from '@alchemy.run/domain';
import { expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as TestClock from 'effect/testing/TestClock';

import { BilanSync, BilanSyncHandlers } from '../src/BilanSync.model.ts';
import { AdmitSync } from '../src/RepoSync/AdmitSync.command.ts';
import { ExpireSync } from '../src/RepoSync/ExpireSync.command.ts';
import { RepoSync } from '../src/RepoSync/RepoSync.aggregate.ts';
import { JobId, RepoId } from '../src/RepoSync/RepoSync.id.ts';
import { RepoSyncStatus } from '../src/RepoSync/RepoSyncStatus.view.ts';
import { RequestSync } from '../src/RepoSync/RequestSync.command.ts';
import { MemorySyncJobStore } from '../src/RepoSync/SyncJobStore.ts';
import {
  RUNNER_RETRY,
  SyncRunner,
  SyncRunnerUnavailable,
} from '../src/RepoSync/SyncRunner.external.ts';

import type { SyncRun } from '../src/RepoSync/SyncRun.ts';

/**
 * The runner failures stories cannot express (beta.84's `resolve` only
 * succeeds): the model hosted in memory, with a runner that always fails.
 */
const failingRunner = ({ startFails = true } = {}) => {
  const calls = { start: 0, stop: 0 };
  const unavailable = new SyncRunnerUnavailable({ reason: 'Workflows are down' });
  const layer = SyncRunner.toLayer(
    Effect.succeed({
      start: () =>
        Effect.sync(() => calls.start++).pipe(
          Effect.andThen(startFails ? Effect.fail(unavailable) : Effect.void),
        ),
      stop: () => Effect.sync(() => calls.stop++).pipe(Effect.andThen(Effect.fail(unavailable))),
    }),
  );
  return { calls, layer };
};

const hosted = (runner: ReturnType<typeof failingRunner>['layer']) =>
  BilanSync.layer(BilanSyncHandlers).pipe(
    Layer.provide(Layer.mergeAll(runner, MemorySyncJobStore)),
    Layer.provide(Domain.InMemory),
  );

const run: SyncRun = {
  owner: 'charpeni',
  name: 'bilan',
  mode: 'incremental',
  depth: '30d',
  since: null,
  maxPrs: null,
  tokenSource: { _tag: 'Server' },
};

/** Moves the test clock a second at a time, letting policies run between steps. */
const advance = (seconds: number) =>
  Effect.gen(function* () {
    for (let i = 0; i <= seconds; i++) {
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
      yield* TestClock.adjust('1 second');
    }
  });

it.effect('a run the runner cannot start fails after the retries, freeing the repository', () => {
  const runner = failingRunner();
  return Effect.gen(function* () {
    const repos = yield* RepoSync;
    const statuses = yield* RepoSyncStatus;
    const repoId = RepoId.make('R_bilan');
    const jobId = JobId.make('job-1');

    yield* repos.send(repoId, new RequestSync({ jobId, requestedBy: 1, run }));
    yield* repos.send(repoId, new AdmitSync({ jobId }));
    yield* advance(30);

    expect(runner.calls.start).toBe(RUNNER_RETRY.times + 1);
    const status = yield* statuses.query(RepoSync.ref(repoId));
    expect(Option.getOrThrow(status)).toMatchObject({
      phase: 'idle',
      last: { jobId, outcome: 'failed' },
      lastError: 'could not start: Workflows are down',
    });
    // A new request is taken at once, not after the stall window.
    yield* repos.send(repoId, new RequestSync({ jobId: JobId.make('job-2'), requestedBy: 1, run }));
  }).pipe(Effect.provide(hosted(runner.layer)));
});

it.effect('a lost run the runner cannot stop is logged and left after the retries', () => {
  const runner = failingRunner({ startFails: false });
  return Effect.gen(function* () {
    const repos = yield* RepoSync;
    const repoId = RepoId.make('R_lost');
    const jobId = JobId.make('job-1');

    yield* repos.send(repoId, new RequestSync({ jobId, requestedBy: 1, run }));
    yield* repos.send(repoId, new AdmitSync({ jobId }));
    // Started, then given up on (its six hours are over): stopped.
    yield* repos.send(repoId, new ExpireSync({ jobId }));
    yield* advance(30);
    expect(runner.calls.stop).toBe(RUNNER_RETRY.times + 1);

    // Settled, not redelivered: no more attempts later on.
    yield* advance(120);
    expect(runner.calls.stop).toBe(RUNNER_RETRY.times + 1);
  }).pipe(Effect.provide(hosted(runner.layer)));
});
