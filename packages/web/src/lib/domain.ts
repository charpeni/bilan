/**
 * The repository-sync model's API, served by the bilan-domain Worker
 * (`packages/domain-worker/src/routes.ts`) and reached through the `DOMAIN`
 * service binding: the model decides whether a repository is syncing, and
 * the sync Workflow reports each step of a run to it.
 *
 * A refusal is an answer, not an error: `{ ok: false, rejected }`. Anything
 * else (bilan-domain down, a body it could not decode) throws. Each body is
 * typed by the schema bilan-domain decodes it with (`SyncApi`), so the two
 * sides cannot drift apart.
 */

import type { CommandReply, SyncApi } from '@bilan/domain-worker/routes';

/** What a run is asked to do, in the model's terms (`SyncRun`). */
export type DomainSyncRun = SyncApi['request']['run'];

/** The answer to a command, as bilan-domain's routes declare it. */
export type DomainReply = CommandReply;

/** A run's report the model refused: it is no longer the repository's current run. */
export type NotCurrent = Extract<DomainReply, { rejected: 'NotCurrentJob' }>;

type DomainEnv = Pick<Env, 'DOMAIN'>;

async function post(env: DomainEnv, path: string, body: object): Promise<DomainReply> {
  // The host is ignored: a service binding always reaches bilan-domain.
  const response = await env.DOMAIN.fetch(`https://bilan-domain${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 200 || response.status === 409) {
    return (await response.json()) as DomainReply;
  }
  throw new Error(`bilan-domain ${path} answered ${response.status}: ${await response.text()}`);
}

/** Ask to sync a repository; refused while another run is current. */
export function requestSync(env: DomainEnv, body: SyncApi['request']): Promise<DomainReply> {
  return post(env, '/sync/request', body);
}

/** The request fits the quotas: start it. */
export function admitSync(env: DomainEnv, body: SyncApi['admit']): Promise<DomainReply> {
  return post(env, '/sync/admit', body);
}

/** The request did not fit the quotas: free the repository. Never refused. */
export function releaseSync(env: DomainEnv, body: SyncApi['release']): Promise<DomainReply> {
  return post(env, '/sync/release', body);
}

export function reportStarted(env: DomainEnv, body: SyncApi['started']): Promise<DomainReply> {
  return post(env, '/sync/started', body);
}

export function reportProgress(env: DomainEnv, body: SyncApi['progress']): Promise<DomainReply> {
  return post(env, '/sync/progress', body);
}

/** The run sleeps until `until` (ISO) for GitHub's rate limit. */
export function reportPause(env: DomainEnv, body: SyncApi['pause']): Promise<DomainReply> {
  return post(env, '/sync/pause', body);
}

export function reportFinished(env: DomainEnv, body: SyncApi['finish']): Promise<DomainReply> {
  return post(env, '/sync/finish', body);
}

export function reportFailed(env: DomainEnv, body: SyncApi['fail']): Promise<DomainReply> {
  return post(env, '/sync/fail', body);
}
