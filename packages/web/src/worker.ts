import { handle } from '@astrojs/cloudflare/handler';
import { parseRepo } from '@bilan/core';

import { startSync, SyncAlreadyRunningError } from './lib/jobs.ts';
import { runRetention } from './lib/retention.ts';

export { SyncRepoWorkflow } from './workflows/sync-repo.ts';

export default {
  fetch: handle,

  /**
   * Nightly: refresh the example repo on the server token (the last 30 days
   * plus open PRs), drop private repos nobody has opened in 90 days, and sweep
   * expired sessions.
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      startSync(env, parseRepo(env.EXAMPLE_REPO), { mode: 'incremental', depth: '30d' }).catch(
        (error) => {
          if (error instanceof SyncAlreadyRunningError) return;
          throw error;
        },
      ),
    );
    ctx.waitUntil(runRetention(env));
  },
} satisfies ExportedHandler<Env>;
