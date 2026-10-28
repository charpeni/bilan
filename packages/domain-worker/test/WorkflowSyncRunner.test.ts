import * as Cloudflare from '@alchemy.run/cloudflare';
import { JobId, RepoId } from '@bilan/domain/RepoSync/RepoSync.id';
import { SyncRunner } from '@bilan/domain/RepoSync/SyncRunner.external';
import { expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { WorkflowSyncRunner } from '../src/WorkflowSyncRunner.ts';

import type { SyncRun } from '@bilan/domain/RepoSync/SyncRun';

/** The `sync-repo` binding, as far as the runner uses it, with Cloudflare's own errors. */
const fakeWorkflow = () => {
  const instances = new Map<string, { params: unknown; status: string }>();
  const state = { down: false };
  const check = () => {
    if (state.down) throw new Error('internal error; reference = 1234');
  };
  const binding = {
    create: async ({ id, params }: { id: string; params: unknown }) => {
      check();
      if (instances.has(id)) throw new Error('instance.already_exists');
      instances.set(id, { params, status: 'running' });
      return { id };
    },
    get: async (id: string) => {
      check();
      const instance = instances.get(id);
      if (!instance) throw new Error('instance.not_found');
      return {
        id,
        status: async () => ({ status: instance.status }),
        terminate: async () => {
          instance.status = 'terminated';
        },
      };
    },
  };
  return { instances, state, binding };
};

/** `repos` in D1, as far as the runner reads it: the name of a repository id. */
const fakeDb = (repos: Record<string, { owner: string; name: string }>) => ({
  prepare: () => ({
    bind: (id: string) => ({ first: async () => repos[id] ?? null }),
  }),
});

const runnerWith = (
  workflow: ReturnType<typeof fakeWorkflow>,
  repos: Record<string, { owner: string; name: string }> = {
    R_bilan: { owner: 'charpeni', name: 'bilan' },
  },
) =>
  WorkflowSyncRunner.pipe(
    Layer.provide(
      Layer.succeed(Cloudflare.Workers.WorkerEnvironment, {
        DB: fakeDb(repos),
        SYNC_REPO: workflow.binding,
      }),
    ),
  );

const run: SyncRun = {
  mode: 'full',
  depth: 'all',
  since: null,
  maxPrs: 500,
  tokenSource: { _tag: 'User', userId: 7 },
};
const job = { jobId: JobId.make('job-1'), repoId: RepoId.make('R_bilan'), run };

it.effect('start creates the instance with the Workflow params, named from D1, once', () => {
  const workflow = fakeWorkflow();
  return Effect.gen(function* () {
    const runner = yield* SyncRunner;
    yield* runner.start(job);
    // Called again (at least once): the instance is there already.
    yield* runner.start(job);
    expect([...workflow.instances]).toEqual([
      [
        'job-1',
        {
          status: 'running',
          params: {
            repoId: 'R_bilan',
            owner: 'charpeni',
            name: 'bilan',
            mode: 'full',
            depth: 'all',
            maxPrs: 500,
            tokenSource: 'user',
            userId: 7,
          },
        },
      ],
    ]);
  }).pipe(Effect.provide(runnerWith(workflow)));
});

it.effect('start fails as unavailable when the Workflow engine is', () => {
  const workflow = fakeWorkflow();
  workflow.state.down = true;
  return Effect.gen(function* () {
    const runner = yield* SyncRunner;
    expect(yield* Effect.flip(runner.start(job))).toMatchObject({
      _tag: 'SyncRunnerUnavailable',
      reason: 'internal error; reference = 1234',
    });
  }).pipe(Effect.provide(runnerWith(workflow)));
});

it.effect('start fails as unavailable when the repository is no longer stored', () => {
  const workflow = fakeWorkflow();
  return Effect.gen(function* () {
    const runner = yield* SyncRunner;
    expect(yield* Effect.flip(runner.start(job))).toMatchObject({
      _tag: 'SyncRunnerUnavailable',
      reason: 'repository R_bilan is no longer stored',
    });
    expect(workflow.instances.size).toBe(0);
  }).pipe(Effect.provide(runnerWith(workflow, {})));
});

it.effect('stop terminates a running instance and leaves an ended one', () => {
  const workflow = fakeWorkflow();
  return Effect.gen(function* () {
    const runner = yield* SyncRunner;
    yield* runner.start(job);
    yield* runner.stop({ jobId: job.jobId });
    expect(workflow.instances.get('job-1')?.status).toBe('terminated');

    yield* runner.start({ ...job, jobId: JobId.make('job-2') });
    workflow.instances.get('job-2')!.status = 'complete';
    yield* runner.stop({ jobId: JobId.make('job-2') });
    expect(workflow.instances.get('job-2')?.status).toBe('complete');
  }).pipe(Effect.provide(runnerWith(workflow)));
});

it.effect('stop of an instance that was never created fails as unavailable', () =>
  Effect.gen(function* () {
    const runner = yield* SyncRunner;
    expect(yield* Effect.flip(runner.stop({ jobId: JobId.make('job-x') }))).toMatchObject({
      _tag: 'SyncRunnerUnavailable',
      reason: 'instance.not_found',
    });
  }).pipe(Effect.provide(runnerWith(fakeWorkflow()))),
);
