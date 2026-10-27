import { runPayloadPruning } from './lib/payload-pruning.ts';
import { runRetention } from './lib/retention.ts';

/**
 * The `bilan-sync` Worker: hosts the sync Workflow and the nightly cron. The
 * Astro Worker owns its own entry, so neither can live there; it reaches the
 * Workflow through a cross-script binding (see `alchemy.run.ts`).
 */
export { SyncRepoWorkflow } from './workflows/sync-repo.ts';

export default {
  /** Nothing is served here; pages and APIs are on the Astro Worker. */
  fetch() {
    return new Response('Not found', { status: 404 });
  },

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
