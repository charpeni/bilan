import type { SyncDepth, SyncRun } from './SyncRun.ts';

/**
 * Which GitHub token the run reads with, as the Workflow takes it: the
 * server's, or a signed-in user's, resolved again inside every step.
 */
export type SyncTokenSource = { tokenSource: 'server' } | { tokenSource: 'user'; userId: number };

/**
 * What the `sync-repo` Workflow takes (`SyncRepoWorkflow` in
 * `packages/web/src/workflows/sync-repo.ts`): a `SyncRun`, flattened, for the
 * repository the model admitted it for. `WorkflowSyncRunner` creates
 * instances with it; the binding types in `infra/` and the web app's `Env`
 * use it too.
 */
export type SyncRepoParams = SyncTokenSource & {
  /** The repository the sync model admitted the run for (GitHub's node id). */
  repoId: string;
  owner: string;
  name: string;
  mode: SyncRun['mode'];
  /** How far back the job was asked to guarantee activity; `since` is its bound, caught up. */
  depth: SyncDepth;
  /**
   * ISO instant. Stop walking once a page is older than this, then fetch every
   * open PR so the backlog is complete whatever the depth. Omit for full history.
   */
  since?: string;
  maxPrs?: number;
};
