import { handle } from '@astrojs/cloudflare/handler';

import { runRetention } from './lib/retention.ts';

export { SyncRepoWorkflow } from './workflows/sync-repo.ts';

export default {
  fetch: handle,

  /**
   * Nightly: drop private repos nobody has opened in 90 days and sweep expired
   * sessions. The built-in examples are static snapshots (see `lib/examples.ts`),
   * so nothing is synced here.
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runRetention(env));
  },
} satisfies ExportedHandler<Env>;
