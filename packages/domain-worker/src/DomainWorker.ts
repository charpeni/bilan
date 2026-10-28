import * as Cloudflare from '@alchemy.run/cloudflare';
import * as DomainCloudflare from '@alchemy.run/cloudflare/Domain';
import { BilanSync, BilanSyncHandlers } from '@bilan/domain/BilanSync.model';
import { RepoId } from '@bilan/domain/RepoSync/RepoSync.id';
import * as Effect from 'effect/Effect';
import { HttpServerRequest } from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

import { compatibility, Database, syncRepoWorkflow, workerName } from '../../../infra/resources.ts';
import { D1SyncJobStore } from './D1SyncJobStore.ts';
import { SyncRoutes } from './routes.ts';
import { SyncStatusEvents } from './statusEvents.ts';
import { WorkflowSyncRunner } from './WorkflowSyncRunner.ts';

/**
 * The repository-sync model on Durable Objects, with its adapters: runs go to
 * the `sync-repo` Workflow, and `sync_jobs` lives in D1. Both are plain
 * bindings on `env`, declared below and read at runtime.
 */
const SyncLive = BilanSync.layer(BilanSyncHandlers).pipe(
  Layer.provide(Layer.mergeAll(WorkflowSyncRunner, D1SyncJobStore)),
  Layer.provide(DomainCloudflare.DurableObjects),
);

/**
 * bilan-domain: hosts the model and serves its sync API (`routes.ts`) to the
 * other Workers through their `DOMAIN` service binding. It has no public URL.
 */
export default class DomainWorker extends Cloudflare.Worker<DomainWorker>()(
  'Domain',
  Effect.gen(function* () {
    return {
      name: yield* workerName('bilan-domain'),
      main: import.meta.url,
      compatibility,
      workersDev: false,
      env: {
        DB: yield* Database,
        // By name, not by output: bilan-sync binds this Worker too, so neither
        // may wait for the other.
        SYNC_REPO: yield* syncRepoWorkflow(yield* workerName('bilan-sync')),
      },
    };
  }),
  Effect.gen(function* () {
    const routes = yield* SyncRoutes;
    const statusEvents = yield* SyncStatusEvents;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, 'http://localhost');
        if (request.method === 'GET' && url.pathname === '/sync/watch') {
          const repoId = Schema.decodeUnknownOption(RepoId)(url.searchParams.get('repoId'));
          if (Option.isNone(repoId)) {
            return yield* HttpServerResponse.json(
              { ok: false, error: 'invalid request', detail: 'repoId is required' },
              { status: 400 },
            );
          }
          return HttpServerResponse.stream(Stream.encodeText(statusEvents(repoId.value)), {
            contentType: 'text/event-stream',
            headers: { 'cache-control': 'no-store' },
          });
        }
        const body =
          request.method === 'POST'
            ? yield* request.json.pipe(Effect.orElseSucceed(() => null))
            : Object.fromEntries(url.searchParams);
        const reply = yield* routes(request.method, url.pathname, body);
        return yield* HttpServerResponse.json(reply.body, { status: reply.status });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(SyncLive)),
) {}
