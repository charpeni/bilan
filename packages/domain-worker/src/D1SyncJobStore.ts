import * as Cloudflare from '@alchemy.run/cloudflare';
import { SyncJobStore } from '@bilan/domain/RepoSync/SyncJobStore';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type { D1Database } from '@cloudflare/workers-types';

/**
 * `sync_jobs` in D1. Each update sets only the fields it carries
 * (`COALESCE` keeps the others), so applying one twice changes nothing.
 * Admission inserts the row; a job without one (released before admission)
 * updates nothing.
 */
export const D1SyncJobStore = Layer.effect(
  SyncJobStore,
  Effect.gen(function* () {
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    const db = env.DB as D1Database;
    return {
      apply: (updates) =>
        updates.length === 0
          ? Effect.void
          : Effect.promise(() =>
              db.batch(
                updates.map((u) =>
                  db
                    .prepare(
                      `UPDATE sync_jobs SET
                         status = COALESCE(?, status),
                         progress_at = COALESCE(?, progress_at),
                         points_spent = COALESCE(?, points_spent),
                         error = COALESCE(?, error),
                         finished_at = COALESCE(?, finished_at)
                       WHERE id = ?`,
                    )
                    .bind(
                      u.status ?? null,
                      u.progressAt ?? null,
                      u.pointsSpent ?? null,
                      u.error ?? null,
                      u.finishedAt ?? null,
                      u.jobId,
                    ),
                ),
              ),
            ).pipe(Effect.asVoid),
    };
  }),
);
