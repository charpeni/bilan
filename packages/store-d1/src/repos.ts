import { and, eq, ne, sql } from 'drizzle-orm';

import { repos } from './schema.ts';

import type { Db } from './db.ts';
import type { NewRepo, Repo } from './schema.ts';

/** Owner assigned to rows whose `owner/name` was taken over by another repo. */
export const STALE_OWNER = '#stale';

/**
 * Rows at `owner/name` in any letter case, as GitHub resolves names. GitHub
 * names are ASCII, which is all `NOCASE` folds. The comparison cannot use the
 * case-sensitive `repos_owner_name` index, so it scans `repos`: one row per
 * repository anyone opened, small enough for that.
 */
function atName(owner: string, name: string) {
  return and(
    sql`${repos.owner} = ${owner} COLLATE NOCASE`,
    sql`${repos.name} = ${name} COLLATE NOCASE`,
  );
}

/**
 * The repo currently living at `owner/name`, however its letters are cased:
 * `Acme/Widgets` finds the row stored as GitHub spells it, `acme/widgets`. A
 * parked row (see `STALE_OWNER`) is never resolved this way: its placeholder
 * name is not a GitHub name.
 */
export async function getRepoByName(
  db: Db,
  owner: string,
  name: string,
): Promise<Repo | undefined> {
  if (owner.toLowerCase() === STALE_OWNER) return undefined;
  return db.select().from(repos).where(atName(owner, name)).get();
}

export async function getRepoById(db: Db, id: string): Promise<Repo | undefined> {
  return db.select().from(repos).where(eq(repos.id, id)).get();
}

/**
 * Insert or refresh a repo row by GitHub node id. `owner` and `name` must be
 * GitHub's own spelling, from `repoMeta` (never a URL's), since that is the
 * one spelling the row keeps. Sync bookkeeping columns
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
  // other row still holding this name (in any letter case, as GitHub matches
  // names) out of the way; if that repo is synced again under its real name, the
  // upsert on its id restores its owner/name. The row being upserted is never
  // parked: a repo renamed only in case keeps its row and takes the new spelling.
  await db
    .update(repos)
    .set({ owner: STALE_OWNER, name: repos.id })
    .where(and(atName(rest.owner, rest.name), ne(repos.id, id)));
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
