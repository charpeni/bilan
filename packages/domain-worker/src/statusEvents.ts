import { RepoSync } from '@bilan/domain/RepoSync/RepoSync.aggregate';
import { RepoSyncStatus, RepoSyncStatusState } from '@bilan/domain/RepoSync/RepoSyncStatus.view';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

import type { RepoId } from '@bilan/domain/RepoSync/RepoSync.id';

/** Often enough that proxies never close a quiet stream as idle. */
export const KEEPALIVE = '25 seconds';

const encodeStatus = Schema.encodeUnknownSync(RepoSyncStatusState);

/**
 * A repository's sync status as Server-Sent Events (`GET /sync/watch`): one
 * `data:` line of JSON per change of `RepoSyncStatus`, its current state
 * first (`null` before the repository's first request), and a comment every
 * `KEEPALIVE`. It ends when the client goes away. The view is pushed from the
 * Durable Object that owns the key, so nothing polls.
 */
export const SyncStatusEvents = Effect.gen(function* () {
  const statuses = yield* RepoSyncStatus;
  return (repoId: RepoId): Stream.Stream<string> =>
    Stream.merge(
      statuses
        .watch(RepoSync.ref(repoId))
        .pipe(
          Stream.map(
            (state) =>
              `data: ${JSON.stringify(Option.isSome(state) ? encodeStatus(state.value) : null)}\n\n`,
          ),
        ),
      Stream.tick(KEEPALIVE).pipe(Stream.map(() => ': keepalive\n\n')),
    );
});
