import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Alchemy from 'alchemy';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';

import type { Input } from 'alchemy';

/**
 * The resources several Workers bind, declared once so each Worker's module
 * can import them: an Effect Worker declares its bindings in its own module,
 * not in `alchemy.run.ts`. Each varies by stage (see `alchemy.run.ts`).
 */

/** The stage being deployed: `prod`, a preview (`pr-<n>`), or a dev or personal stage. */
export const Stage = Effect.map(Alchemy.Stack, ({ stage }) => ({
  stage,
  prod: stage === 'prod',
}));

const isProd = Effect.map(Stage, (s) => s.prod);

/**
 * A Worker's script name: `base` in production, `base-<stage>` elsewhere
 * (`bilan-pr-42`, so previews get readable `workers.dev` hostnames). Fixed in
 * every stage so one Worker can name another without depending on it.
 */
export const workerName = (base: string) =>
  Effect.map(Stage, ({ prod, stage }) =>
    prod ? base : `${base}-${stage.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')}`,
  );

/** Shared by every Worker. */
export const compatibility = { date: '2026-07-24', flags: ['nodejs_compat'] };

/**
 * Production's resources were created by Wrangler, so they carry no Alchemy
 * ownership tags and would otherwise only be taken over with `--adopt`.
 * Adoption is scoped to them instead of every deploy: a Worker's is decided
 * while deploying, not while planning, so a missing flag would fail midway.
 */
export const existingInProd = Alchemy.AdoptPolicy.adopt(isProd);
const retainInProd = Alchemy.RemovalPolicy.retain(isProd);

/**
 * The directory of plain `.sql` migrations to apply, supplied by
 * `alchemy.run.ts` at deploy time, so no Worker bundle needs the file system.
 */
export class D1Migrations extends Context.Service<D1Migrations, string>()('bilan/D1Migrations') {}

export const Database = Cloudflare.D1.Database(
  'DB',
  Effect.gen(function* () {
    const { prod } = yield* Stage;
    return { ...(prod ? { name: 'bilan' } : {}), migrations: yield* D1Migrations };
  }),
).pipe(retainInProd, existingInProd);

// R2 refuses to delete a bucket that still holds objects. A preview's
// payloads are disposable, so closing its pull request empties the bucket
// first; production's is retained and never emptied.
export const Payloads = Cloudflare.R2.Bucket(
  'Payloads',
  Effect.map(Stage, ({ prod }) => (prod ? { name: 'bilan-payloads' } : { forceDestroy: true })),
).pipe(retainInProd, existingInProd);

// Production's namespace (id 5d8223fa9ec74ff3b172ff74b408a98f) is titled CACHE.
export const Cache = Cloudflare.KV.Namespace(
  'Cache',
  Effect.map(Stage, ({ prod }) => (prod ? { title: 'CACHE' } : {})),
).pipe(existingInProd);

/**
 * The `sync-repo` Workflow, hosted by `bilan-sync` and bound across scripts
 * by the others. Pass the host Worker's `workerName` output as `hostScript`
 * so the binding Worker deploys after it. Without a fixed name, each side
 * derives the same stage-scoped default from the host script and class.
 */
export const syncRepoWorkflow = (hostScript?: Input<string>) =>
  Effect.map(Stage, ({ prod }) =>
    Cloudflare.Workflow('SyncRepo', {
      className: 'SyncRepoWorkflow',
      ...(prod ? { workflowName: 'sync-repo' } : {}),
      ...(hostScript === undefined ? {} : { scriptName: hostScript }),
    }),
  );
