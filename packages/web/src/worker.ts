import { handle } from '@astrojs/cloudflare/handler';

import { runPayloadPruning } from './lib/payload-pruning.ts';
import { runRetention } from './lib/retention.ts';

export { SyncRepoWorkflow } from './workflows/sync-repo.ts';

export default {
  fetch: handle,

  /**
   * Nightly: drop private repos nobody has opened in 90 days and sweep expired
   * sessions, then prune superseded R2 snapshots. The built-in examples are
   * static snapshots (see `lib/examples.ts`), so nothing is synced here.
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runRetention(env).then(async () => {
        console.info('payload pruning', await runPayloadPruning(env, { dryRun: false }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
