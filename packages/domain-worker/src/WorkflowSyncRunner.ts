import { SyncRunner } from '@bilan/domain/RepoSync/SyncRunner.external';
import * as Effect from 'effect/Effect';

import { DomainEnv } from './env.ts';

import type { RepoId } from '@bilan/domain/RepoSync/RepoSync.id';
import type { SyncRepoParams } from '@bilan/domain/RepoSync/SyncRepoParams';
import type { SyncRun } from '@bilan/domain/RepoSync/SyncRun';

const toParams = (repoId: RepoId, run: SyncRun): SyncRepoParams => ({
  repoId,
  owner: run.owner,
  name: run.name,
  mode: run.mode,
  depth: run.depth,
  ...(run.since === null ? {} : { since: run.since }),
  ...(run.maxPrs === null ? {} : { maxPrs: run.maxPrs }),
  ...(run.tokenSource._tag === 'Server'
    ? { tokenSource: 'server' as const }
    : { tokenSource: 'user' as const, userId: run.tokenSource.userId }),
});

/** Cloudflare's answer when an instance with that id was already created. */
const ALREADY_CREATED = /already[ _.]?exists/i;
/** Its answers when there is nothing left to stop. */
const NOTHING_TO_STOP = /not[ _.]?found|not[ _.]?running|already|complete|errored|terminated/i;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs a sync on the `sync-repo` Workflow hosted by bilan-sync, keyed by the
 * job id: the policies call `start` and `stop` at least once, so a second
 * `start` finds the instance already created, and a second `stop` finds it
 * already stopped. Any other failure is a defect, so the policy runs again.
 */
export const WorkflowSyncRunner = SyncRunner.toLayer(
  Effect.gen(function* () {
    const { SYNC_REPO: workflow } = yield* DomainEnv;
    return {
      start: ({ jobId, repoId, run }) =>
        Effect.promise(async () => {
          try {
            await workflow.create({ id: jobId, params: toParams(repoId, run) });
          } catch (error) {
            if (!ALREADY_CREATED.test(message(error))) throw error;
          }
        }),
      stop: ({ jobId }) =>
        Effect.promise(async () => {
          try {
            await (await workflow.get(jobId)).terminate();
          } catch (error) {
            if (!NOTHING_TO_STOP.test(message(error))) throw error;
          }
        }),
    };
  }),
);
