import * as Domain from '@alchemy.run/domain';
import { BilanSync, BilanSyncHandlers } from '@bilan/domain/BilanSync.model';
import { ReleaseSync } from '@bilan/domain/RepoSync/ReleaseSync.command';
import { RepoSync } from '@bilan/domain/RepoSync/RepoSync.aggregate';
import { JobId, RepoId } from '@bilan/domain/RepoSync/RepoSync.id';
import { RequestSync } from '@bilan/domain/RepoSync/RequestSync.command';
import { MemorySyncJobStore } from '@bilan/domain/RepoSync/SyncJobStore';
import { SyncRunner } from '@bilan/domain/RepoSync/SyncRunner.external';
import { expect, it } from '@effect/vitest';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as TestClock from 'effect/testing/TestClock';

import { IDLE_READS, LIFETIME, POLL, RETRY_MS, SyncStatusEvents } from '../src/statusEvents.ts';

const hosted = BilanSync.layer(BilanSyncHandlers).pipe(
  Layer.provide(
    Layer.mergeAll(
      SyncRunner.toLayer(Effect.succeed({ start: () => Effect.void, stop: () => Effect.void })),
      MemorySyncJobStore,
    ),
  ),
  Layer.provide(Domain.InMemory),
);

const run = {
  mode: 'incremental' as const,
  depth: '30d' as const,
  since: null,
  maxPrs: null,
  tokenSource: { _tag: 'User' as const, userId: 7 },
};

/**
 * Moves the test clock a second at a time, letting the in-memory model and
 * the stream run between steps.
 */
const advance = (duration: Duration.Input) =>
  Effect.gen(function* () {
    const steps = Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(duration)) / 1000);
    for (let i = 0; i < steps; i++) {
      for (let turn = 0; turn < 5; turn++) yield* Effect.yieldNow;
      yield* TestClock.adjust('1 second');
    }
    for (let turn = 0; turn < 5; turn++) yield* Effect.yieldNow;
  });

const data = (phase: string) => `data: {"phase":"${phase}"}\n\n`;

it.effect('streams the phase on each change, and ends when the run it saw ends', () =>
  Effect.gen(function* () {
    const events = yield* SyncStatusEvents;
    const repos = yield* RepoSync;
    const repoId = RepoId.make('R_bilan');
    const jobId = JobId.make('job-1');

    const received = yield* events(repoId).pipe(
      Stream.filter((line) => !line.startsWith(':')),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* advance(0);
    yield* repos.send(repoId, new RequestSync({ jobId, requestedBy: 7, run }));
    yield* advance(POLL);
    yield* repos.send(repoId, new ReleaseSync({ jobId, reason: 'over quota' }));
    yield* advance(POLL);

    // Only the phase: no job id, no error text.
    expect(yield* Fiber.join(received)).toEqual([
      `retry: ${RETRY_MS}\n\n`,
      data('idle'),
      data('admitting'),
      data('idle'),
    ]);
  }).pipe(Effect.provide(hosted)),
);

it.effect('ends a stream that sees no run after IDLE_READS reads', () =>
  Effect.gen(function* () {
    const events = yield* SyncStatusEvents;
    const received = yield* events(RepoId.make('R_quiet')).pipe(
      Stream.filter((line) => !line.startsWith(':')),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* advance(Duration.times(Duration.fromInputUnsafe(POLL), IDLE_READS));

    expect(yield* Fiber.join(received)).toEqual([`retry: ${RETRY_MS}\n\n`, data('idle')]);
  }).pipe(Effect.provide(hosted)),
);

it.effect('ends after LIFETIME however long the run lasts, with keepalives meanwhile', () =>
  Effect.gen(function* () {
    const events = yield* SyncStatusEvents;
    const repos = yield* RepoSync;
    const repoId = RepoId.make('R_long');
    yield* repos.send(repoId, new RequestSync({ jobId: JobId.make('job-2'), requestedBy: 7, run }));

    const received = yield* events(repoId).pipe(Stream.runCollect, Effect.forkChild);
    yield* advance(LIFETIME);

    const lines = yield* Fiber.join(received);
    expect(lines.filter((line) => line.startsWith('data: '))).toEqual([data('admitting')]);
    expect(lines.filter((line) => line === ': keepalive\n\n').length).toBeGreaterThan(0);
  }).pipe(Effect.provide(hosted)),
);
