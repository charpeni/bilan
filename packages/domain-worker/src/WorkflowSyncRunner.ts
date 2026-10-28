import { SyncRunner, SyncRunnerUnavailable } from '@bilan/domain/RepoSync/SyncRunner.external';
import * as Effect from 'effect/Effect';

import { DomainEnv } from './env.ts';

import type { RepoId } from '@bilan/domain/RepoSync/RepoSync.id';
import type { SyncRepoParams } from '@bilan/domain/RepoSync/SyncRepoParams';
import type { SyncRun } from '@bilan/domain/RepoSync/SyncRun';

/** The repository's name, which the model does not keep (`SyncRun`). */
interface RepoName {
  owner: string;
  name: string;
}

const toParams = (repoId: RepoId, { owner, name }: RepoName, run: SyncRun): SyncRepoParams => ({
  repoId,
  owner,
  name,
  mode: run.mode,
  depth: run.depth,
  ...(run.since === null ? {} : { since: run.since }),
  ...(run.maxPrs === null ? {} : { maxPrs: run.maxPrs }),
  ...(run.tokenSource._tag === 'Server'
    ? { tokenSource: 'server' as const }
    : { tokenSource: 'user' as const, userId: run.tokenSource.userId }),
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const unavailable = (error: unknown) => new SyncRunnerUnavailable({ reason: message(error) });

/** Instance statuses with nothing left to stop. */
const ENDED = new Set(['complete', 'errored', 'terminated']);

/**
 * Runs a sync on the `sync-repo` Workflow hosted by bilan-sync, keyed by the
 * job id. The policies call `start` and `stop` at least once, so both look
 * at the instance rather than at Cloudflare's error messages:
 *
 * - `start` reads the repository's name from D1 (the model keeps ids only),
 *   and when it fails while an instance with the id exists, an earlier call
 *   already did it;
 * - `stop` terminates the instance only while it has not ended.
 *
 * Anything else is `SyncRunnerUnavailable`, which the policies retry, then
 * settle.
 */
export const WorkflowSyncRunner = SyncRunner.toLayer(
  Effect.gen(function* () {
    const { DB, SYNC_REPO: workflow } = yield* DomainEnv;
    return {
      start: ({ jobId, repoId, run }) =>
        Effect.tryPromise({
          try: async () => {
            // Admission upserted the row; retention may have deleted it since.
            const repo = await DB.prepare('SELECT owner, name FROM repos WHERE id = ?')
              .bind(repoId)
              .first<RepoName>();
            if (!repo) throw new Error(`repository ${repoId} is no longer stored`);
            return workflow.create({ id: jobId, params: toParams(repoId, repo, run) });
          },
          catch: unavailable,
        }).pipe(
          Effect.catchTag('SyncRunnerUnavailable', (error) =>
            Effect.tryPromise({ try: () => workflow.get(jobId), catch: () => error }),
          ),
          Effect.asVoid,
        ),
      stop: ({ jobId }) =>
        Effect.tryPromise({
          try: async () => {
            const instance = await workflow.get(jobId);
            const { status } = await instance.status();
            if (!ENDED.has(status)) await instance.terminate();
          },
          catch: unavailable,
        }),
    };
  }),
);
