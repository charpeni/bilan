import { AdmitSync } from '@bilan/domain/RepoSync/AdmitSync.command';
import { FailSync } from '@bilan/domain/RepoSync/FailSync.command';
import { FinishSync, SyncOutcome } from '@bilan/domain/RepoSync/FinishSync.command';
import { MarkSyncStarted } from '@bilan/domain/RepoSync/MarkSyncStarted.command';
import { PauseSync } from '@bilan/domain/RepoSync/PauseSync.command';
import { RecordSyncProgress } from '@bilan/domain/RepoSync/RecordSyncProgress.command';
import { ReleaseSync } from '@bilan/domain/RepoSync/ReleaseSync.command';
import { RepoSync } from '@bilan/domain/RepoSync/RepoSync.aggregate';
import { JobId, RepoId } from '@bilan/domain/RepoSync/RepoSync.id';
import { RepoSyncStatus, RepoSyncStatusState } from '@bilan/domain/RepoSync/RepoSyncStatus.view';
import { RequestSync } from '@bilan/domain/RepoSync/RequestSync.command';
import { SyncRun } from '@bilan/domain/RepoSync/SyncRun';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import type { NotCurrentJob } from '@bilan/domain/RepoSync/NotCurrentJob.rejection';
import type { SyncAlreadyRunning } from '@bilan/domain/RepoSync/RequestSync.command';

/**
 * The sync API the other Workers call through their `DOMAIN` service binding:
 * one JSON route per command, plus the status view. It is not public (the
 * Worker has no route or `workers.dev` URL), and every body is decoded
 * against a schema before it reaches the model.
 *
 * | Route                  | Body                                      | 409 when                |
 * | ---------------------- | ----------------------------------------- | ----------------------- |
 * | `POST /sync/request`   | `repoId, jobId, requestedBy, run`         | another run is current  |
 * | `POST /sync/admit`     | `repoId, jobId`                           | the request moved on    |
 * | `POST /sync/release`   | `repoId, jobId, reason`                   | never                   |
 * | `POST /sync/started`   | `repoId, jobId`                           | not the current run     |
 * | `POST /sync/progress`  | `repoId, jobId, prsFetched, pointsSpent`  | not the current run     |
 * | `POST /sync/pause`     | `repoId, jobId, until` (ISO)              | not the current run     |
 * | `POST /sync/finish`    | `repoId, jobId, outcome, pointsSpent`     | not the current run     |
 * | `POST /sync/fail`      | `repoId, jobId, error, pointsSpent`       | not the current run     |
 * | `GET /sync/status`     | `?repoId=`                                | never                   |
 * | `GET /sync/watch`      | `?repoId=`: Server-Sent Events, see `statusEvents.ts` | never   |
 *
 * Answers `{ ok: true }`; a refusal is `{ ok: false, rejected, ... }` with 409,
 * and a body that does not decode is 400.
 */
export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const Job = { repoId: RepoId, jobId: JobId };
const Bodies = {
  request: Schema.Struct({ ...Job, requestedBy: Schema.Int, run: SyncRun }),
  admit: Schema.Struct(Job),
  release: Schema.Struct({ ...Job, reason: Schema.String }),
  started: Schema.Struct(Job),
  progress: Schema.Struct({ ...Job, prsFetched: Schema.Int, pointsSpent: Schema.Int }),
  pause: Schema.Struct({ ...Job, until: Schema.String }),
  finish: Schema.Struct({ ...Job, outcome: SyncOutcome, pointsSpent: Schema.Int }),
  fail: Schema.Struct({ ...Job, error: Schema.String, pointsSpent: Schema.Int }),
  status: Schema.Struct({ repoId: RepoId }),
};

const ok: Reply = { status: 200, body: { ok: true } };
const notFound: Reply = { status: 404, body: { ok: false, error: 'not found' } };
const invalid = (detail: string): Reply => ({
  status: 400,
  body: { ok: false, error: 'invalid request', detail },
});
const refused = (rejection: SyncAlreadyRunning | NotCurrentJob): Reply => ({
  status: 409,
  body:
    rejection._tag === 'SyncAlreadyRunning'
      ? { ok: false, rejected: rejection._tag, jobId: rejection.jobId }
      : { ok: false, rejected: rejection._tag, current: rejection.current },
});
const encodeStatus = Schema.encodeUnknownSync(RepoSyncStatusState);

/** Decode `body`, or answer 400 with what was wrong. */
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  body: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError((error) => invalid(error.message)));

/**
 * The handler for one request, built once from the hosted model. Every
 * outcome is a `Reply`: refusals and bad bodies included.
 */
export const SyncRoutes = Effect.gen(function* () {
  const repos = yield* RepoSync;
  const statuses = yield* RepoSyncStatus;

  const route = (method: string, path: string, body: unknown): Effect.Effect<Reply, Reply> => {
    if (method === 'GET' && path === '/sync/status') {
      return decode(Bodies.status, body).pipe(
        Effect.flatMap(({ repoId }) => statuses.query(RepoSync.ref(repoId))),
        Effect.map((state) => ({
          status: 200,
          body: { ok: true, status: Option.isSome(state) ? encodeStatus(state.value) : null },
        })),
        Effect.catchTag('ConsistencyTimeout', () =>
          Effect.succeed<Reply>({ status: 503, body: { ok: false, error: 'status unavailable' } }),
        ),
      );
    }
    if (method !== 'POST') return Effect.fail(notFound);
    switch (path) {
      case '/sync/request':
        return decode(Bodies.request, body).pipe(
          Effect.flatMap(({ repoId, ...b }) =>
            repos.send(repoId, new RequestSync(b)).pipe(Effect.mapError(refused)),
          ),
          Effect.as(ok),
        );
      case '/sync/admit':
        return decode(Bodies.admit, body).pipe(
          Effect.flatMap(({ repoId, jobId }) =>
            repos.send(repoId, new AdmitSync({ jobId })).pipe(Effect.mapError(refused)),
          ),
          Effect.as(ok),
        );
      case '/sync/release':
        return decode(Bodies.release, body).pipe(
          Effect.flatMap(({ repoId, ...b }) => repos.send(repoId, new ReleaseSync(b))),
          Effect.as(ok),
        );
      case '/sync/started':
        return decode(Bodies.started, body).pipe(
          Effect.flatMap(({ repoId, jobId }) =>
            repos.send(repoId, new MarkSyncStarted({ jobId })).pipe(Effect.mapError(refused)),
          ),
          Effect.as(ok),
        );
      case '/sync/progress':
        return decode(Bodies.progress, body).pipe(
          Effect.flatMap(({ repoId, ...b }) =>
            repos.send(repoId, new RecordSyncProgress(b)).pipe(Effect.mapError(refused)),
          ),
          Effect.as(ok),
        );
      case '/sync/pause':
        return decode(Bodies.pause, body).pipe(
          Effect.flatMap(({ repoId, jobId, until }) =>
            Option.match(DateTime.make(until), {
              onNone: () => Effect.fail(invalid('until is not a date')),
              onSome: (at) =>
                repos
                  .send(repoId, new PauseSync({ jobId, until: DateTime.toUtc(at) }))
                  .pipe(Effect.mapError(refused)),
            }),
          ),
          Effect.as(ok),
        );
      case '/sync/finish':
        return decode(Bodies.finish, body).pipe(
          Effect.flatMap(({ repoId, ...b }) =>
            repos.send(repoId, new FinishSync(b)).pipe(Effect.mapError(refused)),
          ),
          Effect.as(ok),
        );
      case '/sync/fail':
        return decode(Bodies.fail, body).pipe(
          Effect.flatMap(({ repoId, ...b }) =>
            repos.send(repoId, new FailSync(b)).pipe(Effect.mapError(refused)),
          ),
          Effect.as(ok),
        );
      default:
        return Effect.fail(notFound);
    }
  };

  return (method: string, path: string, body: unknown): Effect.Effect<Reply> =>
    route(method, path, body).pipe(
      Effect.match({ onFailure: (reply) => reply, onSuccess: (reply) => reply }),
    );
});
