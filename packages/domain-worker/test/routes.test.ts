import * as Domain from '@alchemy.run/domain';
import { BilanSync, BilanSyncHandlers } from '@bilan/domain/BilanSync.model';
import { MemorySyncJobStore } from '@bilan/domain/RepoSync/SyncJobStore';
import { SyncRunner } from '@bilan/domain/RepoSync/SyncRunner.external';
import { expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schedule from 'effect/Schedule';

import { SyncRoutes } from '../src/routes.ts';

/** The model in memory, with a runner that records what it was asked to start. */
const hosted = () => {
  const started: unknown[] = [];
  const runner = SyncRunner.toLayer(
    Effect.succeed({
      start: (args) => Effect.sync(() => void started.push(args)),
      stop: () => Effect.void,
    }),
  );
  const layer = BilanSync.layer(BilanSyncHandlers).pipe(
    Layer.provide(Layer.mergeAll(runner, MemorySyncJobStore)),
    Layer.provide(Domain.InMemory),
  );
  return { started, layer };
};

/** Retry `assert` until it passes: views and policies catch up just after each command. */
const eventually = <A>(read: Effect.Effect<A>, assert: (value: A) => void) =>
  read.pipe(
    Effect.flatMap((value) => Effect.try(() => assert(value))),
    Effect.retry({ times: 50, schedule: Schedule.spaced('10 millis') }),
    Effect.orDie,
  );

const run = {
  owner: 'charpeni',
  name: 'bilan',
  mode: 'incremental',
  depth: '30d',
  since: null,
  maxPrs: null,
  tokenSource: { _tag: 'User', userId: 7 },
};
const job = { repoId: 'R_bilan', jobId: 'job-1' };

it.live('serves a run from request to finish, refusing what the model refuses', () => {
  const { started, layer } = hosted();
  return Effect.gen(function* () {
    const route = yield* SyncRoutes;
    const post = (path: string, body: object) => route('POST', path, body);
    const status = () => route('GET', '/sync/status', { repoId: 'R_bilan' });

    expect(yield* status()).toEqual({ status: 200, body: { ok: true, status: null } });
    expect(yield* post('/sync/request', { ...job, requestedBy: 7, run })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(yield* post('/sync/request', { ...job, jobId: 'job-2', requestedBy: 8, run })).toEqual({
      status: 409,
      body: { ok: false, rejected: 'SyncAlreadyRunning', jobId: 'job-1' },
    });
    expect((yield* post('/sync/admit', job)).status).toBe(200);
    expect((yield* post('/sync/started', job)).status).toBe(200);
    expect(
      (yield* post('/sync/progress', { ...job, prsFetched: 25, pointsSpent: 12 })).status,
    ).toBe(200);
    expect(
      yield* post('/sync/progress', { ...job, jobId: 'job-2', prsFetched: 1, pointsSpent: 1 }),
    ).toEqual({ status: 409, body: { ok: false, rejected: 'NotCurrentJob', current: 'job-1' } });
    expect((yield* post('/sync/pause', { ...job, until: '2026-10-28T23:00:00Z' })).status).toBe(
      200,
    );
    expect(
      (yield* post('/sync/finish', { ...job, outcome: 'complete', pointsSpent: 30 })).status,
    ).toBe(200);

    yield* eventually(status(), (reply) =>
      expect((reply.body as { status: unknown }).status).toMatchObject({
        phase: 'idle',
        prsFetched: 25,
        last: { jobId: 'job-1', outcome: 'complete' },
      }),
    );
    // The model started the run once, with the request's parameters.
    yield* eventually(Effect.succeed(started), (calls) =>
      expect(calls).toEqual([{ jobId: 'job-1', repoId: 'R_bilan', run }]),
    );
  }).pipe(Effect.provide(layer));
});

it.effect('answers 400 for a body that does not decode, and 404 for an unknown route', () =>
  Effect.gen(function* () {
    const route = yield* SyncRoutes;
    const missing = yield* route('POST', '/sync/request', { repoId: 'R_bilan' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ ok: false, error: 'invalid request' });
    const badRun = yield* route('POST', '/sync/request', {
      ...job,
      requestedBy: 7,
      run: { ...run, mode: 'sideways' },
    });
    expect(badRun.status).toBe(400);
    expect((yield* route('POST', '/sync/pause', { ...job, until: 'tomorrow' })).body).toEqual({
      ok: false,
      error: 'invalid request',
      detail: 'until is not a date',
    });
    expect((yield* route('POST', '/sync/nope', {})).status).toBe(404);
    expect((yield* route('GET', '/sync/request', {})).status).toBe(404);
  }).pipe(Effect.provide(hosted().layer)),
);
