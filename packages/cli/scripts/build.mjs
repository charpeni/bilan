import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

// Bundle the CLI with its workspace deps so the published package is self-contained.
await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(root, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
});

// The report needs the prebuilt browser bundle of the dashboard next to it.
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(require.resolve('@bilan/ui/dist/bilan-ui.js'), join(root, 'dist/bilan-ui.js'));
copyFileSync(require.resolve('@bilan/ui/dist/bilan-ui.css'), join(root, 'dist/bilan-ui.css'));
