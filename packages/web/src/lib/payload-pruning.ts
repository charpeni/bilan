import { getRepoById } from '@bilan/store-d1';

import { getDb } from './db.ts';
import { payloadKey } from './payload-key.ts';

export const PAYLOAD_GRACE_HOURS = 48;

interface PayloadObject {
  key: string;
  uploaded: Date;
  size: number;
}

export interface PayloadPruningDeps {
  list(cursor?: string): Promise<{ objects: PayloadObject[]; cursor?: string }>;
  currentKey(repoId: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<void>;
}

export interface PayloadPruningOptions {
  /** Inspection is the default; deleting requires an explicit false. */
  dryRun?: boolean;
  now?: number;
  onCandidates?: (objects: readonly PayloadObject[]) => void;
}

export interface PayloadPruningResult {
  dryRun: boolean;
  scanned: number;
  /** Old objects retained because no current snapshot could be verified. */
  skippedUnverified: number;
  candidates: number;
  candidateBytes: number;
  deleted: number;
  deletedBytes: number;
}

/** Only recognize keys produced by payloadKey; leave unrelated objects alone. */
function payloadIdentity(key: string): { repoId: string; timestamp: number } | null {
  const match = /^payload\/([^/]+)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.json\.gz$/.exec(
    key,
  );
  if (!match) return null;
  const repoId = match[1]!;
  const syncedAt = match[2]!;
  const timestamp = Date.parse(syncedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== syncedAt) return null;
  return { repoId, timestamp };
}

/**
 * Keep D1's current snapshot indefinitely and all snapshots uploaded in the last
 * 48 hours. Only prune when D1 references an object that still exists in R2;
 * retain orphaned objects and possible recovery copies when that cannot be
 * verified. Bound memory and deletes to one listing page, and re-read D1 for
 * each repo in each page.
 *
 * Publishing uploads a new object before advancing D1's pointer. The grace
 * period protects that object during publication; using upload time also
 * protects an old key that has just been rewritten. Future-dated keys are kept.
 */
export async function prunePayloads(
  deps: PayloadPruningDeps,
  options: PayloadPruningOptions = {},
): Promise<PayloadPruningResult> {
  const cutoff = (options.now ?? Date.now()) - PAYLOAD_GRACE_HOURS * 60 * 60 * 1000;
  const result: PayloadPruningResult = {
    dryRun: options.dryRun ?? true,
    scanned: 0,
    skippedUnverified: 0,
    candidates: 0,
    candidateBytes: 0,
    deleted: 0,
    deletedBytes: 0,
  };
  let cursor: string | undefined;
  do {
    const page = await deps.list(cursor);
    result.scanned += page.objects.length;
    const byRepo = new Map<string, PayloadObject[]>();
    for (const object of page.objects) {
      const identity = payloadIdentity(object.key);
      if (!identity || !(object.uploaded.getTime() < cutoff) || identity.timestamp >= cutoff)
        continue;
      const objects = byRepo.get(identity.repoId) ?? [];
      objects.push(object);
      byRepo.set(identity.repoId, objects);
    }
    for (const [repoId, objects] of byRepo) {
      // Fail closed if D1 is unavailable. Never treat a failed lookup as a missing repo.
      const currentKey = await deps.currentKey(repoId);
      // A missing row/reference or missing R2 object is not evidence that these
      // older copies are disposable: they may be the only recovery snapshots.
      if (currentKey === null || !(await deps.exists(currentKey))) {
        result.skippedUnverified += objects.length;
        continue;
      }
      const candidates = objects.filter((object) => object.key !== currentKey);
      if (candidates.length === 0) continue;
      const bytes = candidates.reduce((sum, object) => sum + object.size, 0);
      result.candidates += candidates.length;
      result.candidateBytes += bytes;
      options.onCandidates?.(candidates);
      if (!result.dryRun) {
        await deps.delete(candidates.map((object) => object.key));
        result.deleted += candidates.length;
        result.deletedBytes += bytes;
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return result;
}

export function runPayloadPruning(
  env: Pick<Env, 'DB' | 'PAYLOADS'>,
  options: PayloadPruningOptions = {},
): Promise<PayloadPruningResult> {
  const db = getDb(env);
  return prunePayloads(
    {
      list: async (cursor) => {
        const page = await env.PAYLOADS.list({
          prefix: 'payload/',
          limit: 1000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        return { objects: page.objects, ...(page.truncated ? { cursor: page.cursor } : {}) };
      },
      currentKey: async (repoId) => {
        const repo = await getRepoById(db, repoId);
        return repo?.lastSyncedAt ? payloadKey(repoId, repo.lastSyncedAt) : null;
      },
      delete: (keys) => env.PAYLOADS.delete(keys),
      exists: async (key) => (await env.PAYLOADS.head(key)) !== null,
    },
    options,
  );
}
