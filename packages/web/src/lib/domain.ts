/**
 * The repository-sync model's API, served by the bilan-domain Worker
 * (`packages/domain-worker/src/routes.ts`) and reached through the `DOMAIN`
 * service binding: the model decides whether a repository is syncing, and
 * the sync Workflow reports each step of a run to it.
 *
 * A refusal is an answer, not an error: `{ ok: false, rejected }`. Anything
 * else (bilan-domain down, a body it could not decode) throws.
 */

/** What a run is asked to do, in the model's terms (`SyncRun`). */
export interface DomainSyncRun {
  owner: string;
  name: string;
  mode: 'incremental' | 'full';
  depth: string;
  since: string | null;
  maxPrs: number | null;
  tokenSource: { _tag: 'Server' } | { _tag: 'User'; userId: number };
}

export type DomainReply =
  | { ok: true }
  | { ok: false; rejected: 'SyncAlreadyRunning'; jobId: string }
  | { ok: false; rejected: 'NotCurrentJob'; current: string | null };

/** A run's report the model refused: it is no longer the repository's current run. */
export type NotCurrent = Extract<DomainReply, { rejected: 'NotCurrentJob' }>;

type DomainEnv = Pick<Env, 'DOMAIN'>;

interface Job {
  repoId: string;
  jobId: string;
}

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
export function requestSync(
  env: DomainEnv,
  body: Job & { requestedBy: number; run: DomainSyncRun },
): Promise<DomainReply> {
  return post(env, '/sync/request', body);
}

/** The request fits the quotas: start it. */
export function admitSync(env: DomainEnv, body: Job): Promise<DomainReply> {
  return post(env, '/sync/admit', body);
}

/** The request did not fit the quotas: free the repository. Never refused. */
export function releaseSync(env: DomainEnv, body: Job & { reason: string }): Promise<DomainReply> {
  return post(env, '/sync/release', body);
}

export function reportStarted(env: DomainEnv, body: Job): Promise<DomainReply> {
  return post(env, '/sync/started', body);
}

export function reportProgress(
  env: DomainEnv,
  body: Job & { prsFetched: number; pointsSpent: number },
): Promise<DomainReply> {
  return post(env, '/sync/progress', body);
}

/** The run sleeps until `until` (ISO) for GitHub's rate limit. */
export function reportPause(env: DomainEnv, body: Job & { until: string }): Promise<DomainReply> {
  return post(env, '/sync/pause', body);
}

export function reportFinished(
  env: DomainEnv,
  body: Job & { outcome: 'complete' | 'partial'; pointsSpent: number },
): Promise<DomainReply> {
  return post(env, '/sync/finish', body);
}

export function reportFailed(
  env: DomainEnv,
  body: Job & { error: string; pointsSpent: number },
): Promise<DomainReply> {
  return post(env, '/sync/fail', body);
}
