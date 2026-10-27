import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Alchemy from 'alchemy';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';

/**
 * bilan on Cloudflare, one stack per stage:
 *
 * - `prod`: bilan.dev. Every resource keeps the physical name it had under
 *   Wrangler, so the first deploy adopts it (`--adopt`), and storage is
 *   retained if the stack is ever destroyed.
 * - `pr-<n>`: a pull request preview on its `workers.dev` URL, never under
 *   bilan.dev, so it cannot set cookies production would read. It gets its
 *   own empty D1, R2, KV, and Workflow, and no cron.
 * - `alchemy dev`: everything runs locally in workerd.
 *
 * Two Workers: `Website` serves Astro (pages and API routes), and `Sync` hosts
 * the `SyncRepoWorkflow` class and the nightly `scheduled` handler, because
 * the Astro Worker's entry belongs to Astro and cannot export them.
 */
export default Alchemy.Stack(
  'bilan',
  {
    providers: Cloudflare.providers(),
    // `alchemy dev` needs no Cloudflare account, so its state stays on disk.
    state: process.env.ALCHEMY_DEV === 'true' ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const prod = stage === 'prod';
    // Readable preview hostnames: bilan-pr-42.<account>.workers.dev.
    const workerName = (base: string) =>
      prod ? { name: base } : /^pr-\d+$/.test(stage) ? { name: `${base}-${stage}` } : {};
    const retainInProd = Alchemy.RemovalPolicy.retain(prod);

    const db = yield* Cloudflare.D1.Database('DB', {
      ...(prod ? { name: 'bilan' } : {}),
      migrations: flatMigrations(),
    }).pipe(retainInProd);
    const payloads = yield* Cloudflare.R2.Bucket(
      'Payloads',
      prod ? { name: 'bilan-payloads' } : {},
    ).pipe(retainInProd);
    // Created by `wrangler kv namespace create CACHE`; check the title with
    // `wrangler kv namespace list` (id 5d8223fa9ec74ff3b172ff74b408a98f) before
    // the first production deploy.
    const cache = yield* Cloudflare.KV.Namespace('Cache', prod ? { title: 'CACHE' } : {});

    // Same name on both sides: the Workflow lives on `Sync` and `Website`
    // binds it across scripts. Without a fixed name both derive the same
    // stage-scoped default from the host script and class.
    const workflow = {
      className: 'SyncRepoWorkflow',
      ...(prod ? { workflowName: 'sync-repo' } : {}),
    };

    const shared = {
      DB: db,
      PAYLOADS: payloads,
      CACHE: cache,
      GITHUB_APP_SLUG: yield* Config.String('GITHUB_APP_SLUG').pipe(
        Config.withDefault('bilan-app'),
      ),
      TOKEN_ENCRYPTION_KEY: yield* Config.Redacted('TOKEN_ENCRYPTION_KEY'),
      // Optional: login is disabled without the GitHub App's credentials, and
      // the server token is only a fallback (see `lib/token-source.ts`).
      ...(yield* optionalSecret('GITHUB_CLIENT_ID')),
      ...(yield* optionalSecret('GITHUB_CLIENT_SECRET')),
      ...(yield* optionalSecret('GITHUB_TOKEN')),
    };
    const compatibility = { date: '2026-07-24', flags: ['nodejs_compat'] };

    const sync = yield* Cloudflare.Worker('Sync', {
      ...workerName('bilan-sync'),
      main: fileURLToPath(new URL('packages/web/src/sync-worker.ts', import.meta.url)),
      compatibility,
      // Retention and payload pruning only matter where real data lives.
      crons: prod ? ['0 6 * * *'] : [],
      workersDev: false,
      env: {
        ...shared,
        SYNC_REPO: Cloudflare.Workflow('SyncRepo', workflow),
      },
    });

    const website = yield* Cloudflare.Website.Astro('Website', {
      ...workerName('bilan'),
      ...(prod
        ? { domain: 'bilan.dev', workersDev: false }
        : { workersDev: { enabled: true, previewsEnabled: false } }),
      rootDir: fileURLToPath(new URL('packages/web', import.meta.url)),
      compatibility,
      // bilan does not use Astro sessions; its own live in D1.
      sessionKVBindingName: false,
      // The GitHub App's local callback is http://localhost:8788/auth/github/callback.
      dev: { port: 8788, strictPort: true },
      env: {
        ...shared,
        SYNC_REPO: Cloudflare.Workflow('SyncRepo', {
          ...workflow,
          scriptName: sync.workerName,
        }),
      },
    });

    return { url: website.url };
  }),
);

/**
 * A secret bound only when the deploy environment sets it to something. CI
 * passes an unset repository secret as an empty string, which counts as unset.
 */
function optionalSecret<const Name extends string>(name: Name) {
  return Config.option(Config.Redacted(name)).pipe(
    Effect.map((value) =>
      Option.match(
        Option.filter(value, (secret) => Redacted.value(secret) !== ''),
        {
          onNone: () => ({}),
          onSome: (secret) => ({ [name]: secret }) as Record<Name, typeof secret>,
        },
      ),
    ),
  );
}

/**
 * Alchemy applies a directory of plain `.sql` files, keyed by file name: the
 * same keys Wrangler recorded in `d1_migrations`, so production's history is
 * adopted as is. It refuses a directory holding drizzle-kit's pre-v1
 * `meta/_journal.json`, which `packages/store-d1/migrations` must keep for
 * `drizzle-kit generate`, so deploy from a copy of the SQL files alone.
 */
function flatMigrations(): string {
  const source = fileURLToPath(new URL('packages/store-d1/migrations', import.meta.url));
  const target = fileURLToPath(new URL('.alchemy/d1-migrations', import.meta.url));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(source)) {
    if (file.endsWith('.sql')) copyFileSync(join(source, file), join(target, file));
  }
  return target;
}
