import {
  deleteExpiredSessions,
  deleteRepoIfExpired,
  listReposWithLastView,
  repoExpired,
} from '@bilan/store-d1';

import { getDb } from './db.ts';

import type { RepoLastView } from '@bilan/store-d1';

export const PRIVATE_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionCutoff(now: number = Date.now()): string {
  return new Date(now - PRIVATE_RETENTION_DAYS * DAY_MS).toISOString();
}

/**
 * Private repos nobody has opened since the cutoff (or ever), plus parked rows
 * (another repo took their name) on the same rule whatever their visibility.
 * Public, addressable repos are kept: they hold nothing that needs a viewer to
 * justify it.
 */
export function selectExpiredPrivateRepos(
  repos: readonly RepoLastView[],
  cutoff: string,
): string[] {
  return repos
    .filter(
      (repo) =>
        (repo.isPrivate || repo.parked) &&
        (repo.lastViewedAt === null || repo.lastViewedAt < cutoff),
    )
    .map((repo) => repo.id);
}

export interface RetentionResult {
  /** Repos actually removed; a candidate restored or viewed since the scan is not among them. */
  deletedRepos: string[];
  deletedSessions: number;
}

/** Everything the sweep touches, so the ordering rules run in plain vitest with fakes. */
export interface RetentionDeps {
  listRepos(): Promise<RepoLastView[]>;
  /** Re-check eligibility right before touching R2 (store-d1's `repoExpired`). */
  isExpired(repoId: string, cutoff: string): Promise<boolean>;
  /** See store-d1's `deleteRepoIfExpired`: one guarded batch, true when the row went. */
  deleteRepoIfExpired(repoId: string, cutoff: string): Promise<boolean>;
  /** Remove every payload object of the repo; may throw when R2 is unavailable. */
  deletePayloads(repoId: string): Promise<void>;
  deleteExpiredSessions(now: string): Promise<number>;
}

export function retentionDeps(env: Pick<Env, 'DB' | 'PAYLOADS'>): RetentionDeps {
  const db = getDb(env);
  return {
    listRepos: () => listReposWithLastView(db),
    isExpired: (repoId, cutoff) => repoExpired(db, repoId, cutoff),
    deleteRepoIfExpired: (repoId, cutoff) => deleteRepoIfExpired(db, repoId, cutoff),
    deletePayloads: (repoId) => deletePayloads(env.PAYLOADS, repoId),
    deleteExpiredSessions: (now) => deleteExpiredSessions(db, now),
  };
}

/**
 * Drop stale private repos (rows and R2 payloads) and expired sessions. The
 * scan only nominates candidates: each is removed by `deleteRepoIfExpired`,
 * which re-checks the rule in the delete itself, so a repo that was restored
 * (synced again under its name) or opened between the scan and the delete is
 * left alone.
 *
 * Payloads go first. Deleting the row first would leave the payloads orphaned
 * for good should R2 fail (nothing lists a repo with no row); with R2 first, a
 * failed cleanup skips the repo for this sweep and the row is nominated again
 * next time. The other way round is harmless: a repo restored between its
 * payload cleanup and the (then refused) row delete writes a new payload on
 * its next sync.
 */
export async function sweepRetention(
  deps: RetentionDeps,
  now: number = Date.now(),
): Promise<RetentionResult> {
  const cutoff = retentionCutoff(now);
  const candidates = selectExpiredPrivateRepos(await deps.listRepos(), cutoff);
  const deletedRepos: string[] = [];
  for (const repoId of candidates) {
    // The candidate list ages while earlier repos are cleaned up; a repo opened
    // or restored in the meantime must keep its (possibly fresh) payloads.
    if (!(await deps.isExpired(repoId, cutoff))) continue;
    try {
      await deps.deletePayloads(repoId);
    } catch (error) {
      console.error(`retention: payload cleanup of ${repoId} failed; keeping its row`, error);
      continue;
    }
    if (await deps.deleteRepoIfExpired(repoId, cutoff)) deletedRepos.push(repoId);
  }
  const deletedSessions = await deps.deleteExpiredSessions(new Date(now).toISOString());
  return { deletedRepos, deletedSessions };
}

export function runRetention(
  env: Pick<Env, 'DB' | 'PAYLOADS'>,
  now: number = Date.now(),
): Promise<RetentionResult> {
  return sweepRetention(retentionDeps(env), now);
}

async function deletePayloads(bucket: R2Bucket, repoId: string): Promise<void> {
  const prefix = `payload/${repoId}/`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}
