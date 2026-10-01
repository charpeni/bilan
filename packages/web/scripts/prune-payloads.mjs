// Inspect the production backlog by default. --apply performs the deletions.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getPlatformProxy, unstable_readConfig as readConfig } from 'wrangler';

import { runPayloadPruning } from '../src/lib/payload-pruning.ts';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm --filter @bilan/web payloads:prune [--dry-run | --apply] [--local]

Default: inspect production D1 and R2 using Wrangler authentication; delete nothing.
--apply    Delete the candidates after checking each repo's current D1 reference.
--local    Use local Wrangler state instead of production (for development).

Prints candidate keys and compressed sizes, followed by a summary in bytes.`);
} else {
  if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run.');
  await main();
}

async function main() {
  const webRoot = fileURLToPath(new URL('..', import.meta.url));
  const config = readConfig({ config: join(webRoot, 'wrangler.jsonc') });
  const database = config.d1_databases.find((binding) => binding.binding === 'DB');
  const bucket = config.r2_buckets.find((binding) => binding.binding === 'PAYLOADS');
  if (!database || !bucket) throw new Error('Expected DB and PAYLOADS bindings in wrangler.jsonc.');

  console.log(
    `${values.apply ? 'APPLY' : 'DRY RUN'} (${values.local ? 'local' : 'production'}): ${database.database_name} / ${bucket.bucket_name}`,
  );
  // Use the application's resource names and IDs, but expose only the two
  // maintenance bindings. Do not change the app's local development bindings.
  const directory = await mkdtemp(join(tmpdir(), 'bilan-payload-pruning-'));
  let proxy;
  try {
    const configPath = join(directory, 'wrangler.json');
    await writeFile(
      configPath,
      JSON.stringify({
        name: 'bilan-payload-pruning',
        account_id: config.account_id,
        compatibility_date: config.compatibility_date,
        d1_databases: [{ ...database, remote: !values.local }],
        r2_buckets: [{ ...bucket, remote: !values.local }],
      }),
    );
    proxy = await getPlatformProxy({
      configPath,
      envFiles: [],
      persist: values.local ? { path: join(webRoot, '.wrangler/state/v3') } : false,
    });
    const result = await runPayloadPruning(proxy.env, {
      dryRun: !values.apply,
      onCandidates: (objects) => {
        for (const object of objects) console.log(`${object.size}\t${object.key}`);
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      await proxy?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
