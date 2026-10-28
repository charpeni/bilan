import * as Cloudflare from '@alchemy.run/cloudflare';
import { SyncJobStore } from '@bilan/domain/RepoSync/SyncJobStore';
import { applySyncJobChanges } from '@bilan/store-d1/jobs';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type { D1Database } from '@cloudflare/workers-types';

/**
 * `sync_jobs` in D1, through `applySyncJobChanges` (`@bilan/store-d1`),
 * which its tests run against D1 itself.
 */
export const D1SyncJobStore = Layer.effect(
  SyncJobStore,
  Effect.gen(function* () {
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    const db = env.DB as D1Database;
    return {
      apply: (updates) => Effect.promise(() => applySyncJobChanges(db, updates)),
    };
  }),
);
