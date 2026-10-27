import { execSync } from 'node:child_process';

import { defineConfig } from 'astro/config';

// Deployed by `Cloudflare.Website.Astro` in alchemy.run.ts, which injects its
// own Cloudflare adapter: declaring one here fails the build. Prerendering runs
// in workerd by default there too.
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
});
