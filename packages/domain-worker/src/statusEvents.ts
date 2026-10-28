import { RepoSync } from '@bilan/domain/RepoSync/RepoSync.aggregate';
import { RepoSyncStatus, RepoSyncStatusState } from '@bilan/domain/RepoSync/RepoSyncStatus.view';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

import type { RepoId } from '@bilan/domain/RepoSync/RepoSync.id';

/**
 * How often the stream reads the repository's status. The view's own
 * `watch` would read its Durable Object every 300 ms for as long as the
 * stream is open (beta.84 pushes only to WebSocket readers), so the stream
 * reads it itself, less often.
 */
export const POLL = '2 seconds';

/**
 * Reads of an idle status, in a row, after which a stream that never saw a
 * run ends (about 30 seconds): long enough for a run requested just before
 * the page connected to reach the view.
 */
export const IDLE_READS = 15;

/** No stream outlives this. The browser reconnects, through the access check again. */
export const LIFETIME = '10 minutes';

/** How long the browser waits before reconnecting after a stream ends. */
export const RETRY_MS = 10_000;

/** Often enough that proxies never close a quiet stream as idle. */
export const KEEPALIVE = '25 seconds';

const encodeStatus = Schema.encodeUnknownSync(RepoSyncStatusState);

type Phase = (typeof RepoSyncStatusState.Type)['phase'];

interface Reading {
  readonly phase: Phase;
  /** The whole status, encoded: any change to it (a page of progress too) is an event. */
  readonly fingerprint: string;
  readonly last: boolean;
}

/** What a stream has read so far. */
interface Seen {
  /** It saw a run in progress. */
  readonly sawRun: boolean;
  /** Idle reads in a row. */
  readonly idleReads: number;
}

/**
 * A repository's sync status as Server-Sent Events (`GET /sync/watch`).
 *
 * - The stream starts with a `retry:` field, then sends one `data:` line per
 *   change of `RepoSyncStatus`, the current state first.
 * - An event carries only `{ "phase": … }`. The stream is open to anyone who
 *   may read the repository, so job ids and errors stay out of it; the page
 *   reads those through its own access rules.
 * - A keepalive comment goes out every `KEEPALIVE`.
 * - The stream ends:
 *   - when a run it saw ends (the status turns idle);
 *   - after `IDLE_READS` idle reads if it never saw one;
 *   - after `LIFETIME`;
 *   - or when the client goes away.
 */
export const SyncStatusEvents = Effect.gen(function* () {
  const statuses = yield* RepoSyncStatus;
  return (repoId: RepoId): Stream.Stream<string> => {
    const read = statuses.query(RepoSync.ref(repoId)).pipe(
      Effect.map((state) =>
        Option.isSome(state)
          ? {
              phase: state.value.phase,
              fingerprint: JSON.stringify(encodeStatus(state.value)),
            }
          : { phase: 'idle' as const, fingerprint: 'null' },
      ),
      // Raised only by a read that waits for a receipt, which this one doesn't.
      Effect.catchTag('ConsistencyTimeout', () => Effect.succeed(null)),
    );

    const changes = Stream.fromEffectSchedule(read, Schedule.spaced(POLL)).pipe(
      Stream.filter((reading) => reading !== null),
      Stream.mapAccum(
        (): Seen => ({ sawRun: false, idleReads: 0 }),
        (seen, reading): readonly [Seen, ReadonlyArray<Reading>] => {
          const idle = reading.phase === 'idle';
          const idleReads = idle ? seen.idleReads + 1 : 0;
          const last = idle && (seen.sawRun || idleReads >= IDLE_READS);
          return [{ sawRun: seen.sawRun || !idle, idleReads }, [{ ...reading, last }]];
        },
      ),
      Stream.takeUntil((reading) => reading.last),
      Stream.changesWith((a, b) => a.fingerprint === b.fingerprint),
      Stream.map((reading) => `data: ${JSON.stringify({ phase: reading.phase })}\n\n`),
    );

    const keepalive = Stream.tick(KEEPALIVE).pipe(Stream.map(() => ': keepalive\n\n'));
    const lifetime = Stream.fromEffect(Effect.sleep(LIFETIME)).pipe(Stream.drain);

    return Stream.make(`retry: ${RETRY_MS}\n\n`).pipe(
      Stream.concat(changes.pipe(Stream.merge(keepalive, { haltStrategy: 'left' }))),
      Stream.merge(lifetime, { haltStrategy: 'either' }),
    );
  };
});
