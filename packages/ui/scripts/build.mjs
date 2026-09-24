import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(pkg, 'dist');

await mkdir(dist, { recursive: true });

await build({
  absWorkingDir: pkg,
  entryPoints: [resolve(pkg, 'src/index.ts')],
  outfile: resolve(dist, 'bilan-ui.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'BilanUI',
  target: 'es2020',
  logLevel: 'info',
});

await copyFile(resolve(pkg, 'src/styles.css'), resolve(dist, 'bilan-ui.css'));
