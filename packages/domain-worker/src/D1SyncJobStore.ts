import { SyncJobStore } from '@bilan/domain/RepoSync/SyncJobStore';
import { applySyncJobChanges } from '@bilan/store-d1/jobs';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { DomainEnv } from './env.ts';

/**
 * `sync_jobs` in D1, through `applySyncJobChanges` (`@bilan/store-d1`),
 * which its tests run against D1 itself.
 */
export const D1SyncJobStore = Layer.effect(
  SyncJobStore,
  Effect.gen(function* () {
    const { DB } = yield* DomainEnv;
    return {
      apply: (updates) => Effect.promise(() => applySyncJobChanges(DB, updates)),
    };
  }),
);
