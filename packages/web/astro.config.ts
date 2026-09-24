import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// The worker entry (`src/worker.ts`, with the `scheduled` handler and the
// `SyncRepoWorkflow` export) is declared as `main` in wrangler.jsonc; the
// adapter picks it up from there and bundles it with the Cloudflare Vite plugin.
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough',
    // Astro sessions are unused; point them at CACHE so deploy does not provision another namespace.
    sessionKVBindingName: 'CACHE',
    prerenderEnvironment: 'workerd',
  }),
});
