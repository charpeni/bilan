import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Effect from 'effect/Effect';

import { Database, syncRepoWorkflow, workerName } from '../../../infra/resources.ts';

/** bilan-domain's bindings, as `DomainWorker` declares them. */
export const DomainBindings = Effect.gen(function* () {
  return {
    DB: yield* Database,
    // By name, not by output: bilan-sync binds this Worker too, so neither
    // may wait for the other.
    SYNC_REPO: yield* syncRepoWorkflow(yield* workerName('bilan-sync')),
  };
});

/** What those bindings are at runtime, inferred from their declarations. */
export type DomainEnv = Cloudflare.InferEnv<typeof DomainBindings>;

/** The Worker's `env`, typed by its declared bindings. */
export const DomainEnv = Effect.map(
  Cloudflare.Workers.WorkerEnvironment,
  // WorkerEnvironment is the raw `env`; its shape is what DomainBindings declared.
  (env) => env as unknown as DomainEnv,
);
