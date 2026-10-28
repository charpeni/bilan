import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type { RuntimeContext } from 'alchemy';

/**
 * A change to one `sync_jobs` row. Every field is an absolute value, so
 * applying the same update twice leaves the row as applying it once.
 */
export interface SyncJobUpdate {
  readonly jobId: string;
  readonly status?: 'running' | 'complete' | 'partial' | 'errored';
  /** ISO instant of the run's latest sign of life. */
  readonly progressAt?: string;
  readonly pointsSpent?: number;
  readonly error?: string;
  /** ISO instant the run ended. */
  readonly finishedAt?: string;
}

/**
 * Where `sync_jobs` lives: the quota ledger admission counts against, and the
 * history the web app lists. The projection depends on this port, not on D1,
 * so stories run it against memory.
 */
export class SyncJobStore extends Context.Service<
  SyncJobStore,
  {
    readonly apply: (
      updates: ReadonlyArray<SyncJobUpdate>,
    ) => Effect.Effect<void, never, RuntimeContext>;
  }
>()('Bilan/SyncJobStore') {}

/** Updates folded per job, as `sync_jobs` would hold them. */
export type SyncJobRow = Omit<SyncJobUpdate, 'jobId'>;

/** `sync_jobs` in memory, for stories: its Layer, and a reader for assertions. */
export const memorySyncJobs = () => {
  const rows = new Map<string, SyncJobRow>();
  return {
    layer: Layer.succeed(SyncJobStore, {
      apply: (updates) =>
        Effect.sync(() => {
          for (const { jobId, ...fields } of updates) {
            rows.set(jobId, { ...rows.get(jobId), ...fields });
          }
        }),
    }),
    get: (jobId: string) => Effect.sync(() => rows.get(jobId)),
  };
};

/** A fresh, empty `sync_jobs` in memory each time it is built. */
export const MemorySyncJobStore = Layer.suspend(() => memorySyncJobs().layer);
