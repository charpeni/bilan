import { execSync } from 'node:child_process';

import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// The worker entry (`src/worker.ts`, with the `scheduled` handler and the
// `SyncRepoWorkflow` export) is declared as `main` in wrangler.jsonc; the
// adapter picks it up from there and bundles it with the Cloudflare Vite plugin.
/** The commit being built, for the footer: git first, then the CI variable, else unknown. */
function commit(): string {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return process.env.GITHUB_SHA ?? '';
  }
}

export default defineConfig({
  vite: { define: { __BILAN_COMMIT__: JSON.stringify(commit()) } },
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough',
    // Astro sessions are unused; point them at CACHE so deploy does not provision another namespace.
    sessionKVBindingName: 'CACHE',
    prerenderEnvironment: 'workerd',
  }),
});
