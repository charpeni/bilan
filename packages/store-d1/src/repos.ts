import { and, eq, ne } from 'drizzle-orm';

import { repos } from './schema.ts';

import type { Db } from './db.ts';
import type { NewRepo, Repo } from './schema.ts';

/** Owner assigned to rows whose `owner/name` was taken over by another repo. */
export const STALE_OWNER = '#stale';

/**
 * The repo currently living at `owner/name`. A parked row (see `STALE_OWNER`)
 * is never resolved this way: its placeholder name is not a GitHub name.
 */
export async function getRepoByName(
  db: Db,
  owner: string,
  name: string,
): Promise<Repo | undefined> {
  if (owner === STALE_OWNER) return undefined;
  return db
    .select()
    .from(repos)
    .where(and(eq(repos.owner, owner), eq(repos.name, name)))
    .get();
}

export async function getRepoById(db: Db, id: string): Promise<Repo | undefined> {
  return db.select().from(repos).where(eq(repos.id, id)).get();
}

/**
 * Insert or refresh a repo row by GitHub node id. Sync bookkeeping columns
 * (`last_synced_at`, `last_full_sync_at`, `coverage_since`,
 * `open_prs_synced_at`, `sync_started_at`, `areas_override`) are left alone
 * unless explicitly provided, so a metadata refresh never clears them.
 * Coverage, the open-PR stamp and the in-flight stamp are never taken from
 * the caller at all: only `D1Store` may move them.
 */
export async function upsertRepo(
  db: Db,
  repo: Omit<NewRepo, 'coverageSince' | 'openPrsSyncedAt' | 'syncStartedAt'>,
): Promise<Repo> {
  const { id, ...rest } = repo;
  // GitHub names are not stable: a repo can be renamed or transferred and a new
  // one created at the old `owner/name`. The row is keyed by node id, so move any
  // other row still holding this name out of the way; if that repo is synced again
  // under its real name, the upsert on its id restores its owner/name.
  await db
    .update(repos)
    .set({ owner: STALE_OWNER, name: repos.id })
    .where(and(eq(repos.owner, rest.owner), eq(repos.name, rest.name), ne(repos.id, id)));
  const set: Partial<NewRepo> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) (set as Record<string, unknown>)[key] = value;
  }
  const row = await db
    .insert(repos)
    .values({ id, ...rest })
    .onConflictDoUpdate({ target: repos.id, set })
    .returning()
    .get();
  return row;
}
