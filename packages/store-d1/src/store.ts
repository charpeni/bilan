import { and, eq, inArray, sql } from 'drizzle-orm';

import { pullRequests, repos } from './schema.ts';

import type { Db } from './db.ts';
import type { RawPr, RepoMeta, SyncStore } from '@bilan/core';

/** D1 allows 100 bound parameters per statement; leave headroom for the repo id. */
export const IN_CHUNK = 90;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `SyncStore` over the `pull_requests` table for a single repo. The repo row
 * must already exist (see `upsertRepo`); `repo` is the `owner/name` label
 * reported in `meta()`.
 */
export class D1Store implements SyncStore {
  private readonly db: Db;
  private readonly repoId: string;
  private readonly repo: string;

  constructor(db: Db, repoId: string, repo: string) {
    this.db = db;
    this.repoId = repoId;
    this.repo = repo;
  }

  async meta(): Promise<RepoMeta> {
    const row = await this.db
      .select({
        lastSyncedAt: repos.lastSyncedAt,
        coverageSince: repos.coverageSince,
        openPrsSyncedAt: repos.openPrsSyncedAt,
        syncStartedAt: repos.syncStartedAt,
        reconciledAt: repos.reconciledAt,
      })
      .from(repos)
      .where(eq(repos.id, this.repoId))
      .get();
    return {
      repo: this.repo,
      syncedAt: row?.lastSyncedAt ?? null,
      coverageSince: row?.coverageSince ?? null,
      openPrsSyncedAt: row?.openPrsSyncedAt ?? null,
      interrupted: (row?.syncStartedAt ?? null) !== null,
      syncStartedAt: row?.syncStartedAt ?? null,
      reconciledAt: row?.reconciledAt ?? null,
    };
  }

  async updatedAtByNumber(numbers: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const part of chunk(numbers, IN_CHUNK)) {
      const rows = await this.db
        .select({ number: pullRequests.number, updatedAt: pullRequests.updatedAt })
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, this.repoId), inArray(pullRequests.number, part)))
        .all();
      for (const row of rows) out.set(row.number, row.updatedAt);
    }
    return out;
  }

  async upsert(prs: RawPr[]): Promise<void> {
    if (prs.length === 0) return;
    const statements = prs.map((pr) =>
      this.db
        .insert(pullRequests)
        .values({
          repoId: this.repoId,
          number: pr.number,
          updatedAt: pr.updatedAt,
          data: JSON.stringify(pr),
        })
        .onConflictDoUpdate({
          target: [pullRequests.repoId, pullRequests.number],
          set: { updatedAt: pr.updatedAt, data: JSON.stringify(pr) },
        }),
    );
    const [first, ...rest] = statements;
    if (!first) return;
    await this.db.batch([first, ...rest]);
  }

  async all(): Promise<RawPr[]> {
    const rows = await this.db
      .select({ data: pullRequests.data })
      .from(pullRequests)
      .where(eq(pullRequests.repoId, this.repoId))
      .all();
    return rows.map((row) => JSON.parse(row.data) as RawPr);
  }

  /** Keeps the earliest start across consecutive unfinished runs. */
  async markStarted(at: string): Promise<void> {
    await this.db
      .update(repos)
      .set({ syncStartedAt: sql`coalesce(${repos.syncStartedAt}, ${at})` })
      .where(eq(repos.id, this.repoId));
  }

  /**
   * Coverage only widens: the first sync takes the bound as given, later ones
   * keep the earlier of the stored and the new bound, and `null` (full history)
   * beats any instant. ISO-8601 strings in UTC compare correctly as text.
   *
   * A complete run promotes `sync_started_at` to `reconciled_at` and clears it
   * (SQLite evaluates every SET expression against the row as it was), and
   * stamps `open_prs_synced_at` when `openPrsComplete`. An incomplete run
   * leaves all three as they were. A retried completion finds
   * `sync_started_at` already null and keeps `reconciled_at` as it is, so a
   * Workflow step that runs again after a later failure cannot erase the
   * watermark.
   */
  async markSynced(
    at: string,
    coverageSince: string | null,
    openPrsComplete: boolean,
    complete: boolean,
  ): Promise<void> {
    await this.db
      .update(repos)
      .set({
        lastSyncedAt: at,
        coverageSince: sql`case
          when ${repos.lastSyncedAt} is null then ${coverageSince}
          when ${repos.coverageSince} is null or ${coverageSince} is null then null
          when ${coverageSince} < ${repos.coverageSince} then ${coverageSince}
          else ${repos.coverageSince}
        end`,
        ...(complete
          ? {
              reconciledAt: sql`coalesce(${repos.syncStartedAt}, ${repos.reconciledAt})`,
              syncStartedAt: null,
              ...(openPrsComplete ? { openPrsSyncedAt: at } : {}),
            }
          : {}),
      })
      .where(eq(repos.id, this.repoId));
  }
}
