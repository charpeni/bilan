import * as Domain from '@alchemy.run/domain';
import { BilanSync, BilanSyncHandlers } from '@bilan/domain/BilanSync.model';
import { RepoSync } from '@bilan/domain/RepoSync/RepoSync.aggregate';
import { JobId, RepoId } from '@bilan/domain/RepoSync/RepoSync.id';
import { RequestSync } from '@bilan/domain/RepoSync/RequestSync.command';
import { MemorySyncJobStore } from '@bilan/domain/RepoSync/SyncJobStore';
import { SyncRunner } from '@bilan/domain/RepoSync/SyncRunner.external';
import { expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';

import { SyncStatusEvents } from '../src/statusEvents.ts';

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
  owner: 'charpeni',
  name: 'bilan',
  mode: 'incremental' as const,
  depth: '30d',
  since: null,
  maxPrs: null,
  tokenSource: { _tag: 'User' as const, userId: 7 },
};

it.live('streams the current status, then each change, as Server-Sent Events', () =>
  Effect.gen(function* () {
    const events = yield* SyncStatusEvents;
    const repos = yield* RepoSync;
    const repoId = RepoId.make('R_bilan');

    // The first two status events, keepalive comments aside.
    const received = yield* events(repoId).pipe(
      Stream.filter((line) => line.startsWith('data: ')),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.sleep('50 millis');
    yield* repos.send(repoId, new RequestSync({ jobId: JobId.make('job-1'), requestedBy: 7, run }));
    const [first, second] = yield* Fiber.join(received);

    expect(first).toBe('data: null\n\n');
    expect(second).toMatch(/^data: \{.*\}\n\n$/);
    expect(JSON.parse(second!.slice('data: '.length))).toMatchObject({
      phase: 'admitting',
      jobId: 'job-1',
    });
  }).pipe(Effect.provide(hosted)),
);
