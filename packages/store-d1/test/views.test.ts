import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { upsertUser } from '../src/auth.ts';
import { createDb } from '../src/db.ts';
import { getRepoById, STALE_OWNER, upsertRepo } from '../src/repos.ts';
import { pullRequests, repos, repoViews, syncJobs } from '../src/schema.ts';
import { deleteRepoIfExpired, touchRepoView } from '../src/views.ts';

import type { Db } from '../src/db.ts';
import type { BatchItem } from 'drizzle-orm/batch';

const CUTOFF = '2026-02-01T00:00:00.000Z';
const BEFORE_CUTOFF = '2026-01-31T23:59:59.000Z';
const AFTER_CUTOFF = '2026-02-15T00:00:00.000Z';

let seq = 0;

async function seed(options: { isPrivate: boolean; parked?: boolean }) {
  const db = createDb(env.DB);
  const id = `R_views_${++seq}`;
  const owner = options.parked ? STALE_OWNER : 'acme';
  const name = options.parked ? id : `repo-${seq}`;
  await upsertRepo(db, { id, owner, name, isPrivate: options.isPrivate, totalPrs: 1 });
  await db.insert(pullRequests).values({ repoId: id, number: 1, updatedAt: CUTOFF, data: '{}' });
  await db.insert(syncJobs).values({
    id: `job_${id}`,
    repoId: id,
    mode: 'incremental',
    status: 'complete',
    createdAt: CUTOFF,
  });
  return { db, id };
}

async function viewer(db: Db, id: number): Promise<number> {
  await upsertUser(db, { id, login: `user${id}`, avatarUrl: null, now: CUTOFF });
  return id;
}

/**
 * A `Db` whose `batch` runs its statements one by one and calls `between`
 * after the first, so a test can slip a write in where D1 would otherwise
 * run the batch as one transaction.
 */
function interleaving(db: Db, between: () => Promise<void>): Db {
  const batch = async (queries: BatchItem<'sqlite'>[]) => {
    const results: unknown[] = [];
    for (const [i, query] of queries.entries()) {
      if (i === 1) await between();
      results.push(await (query as unknown as { run(): Promise<unknown> }).run());
    }
    return results;
  };
  return Object.create(db, { batch: { value: batch } }) as Db;
}

async function children(db: Db, repoId: string) {
  return {
    repo: await getRepoById(db, repoId),
    prs: await db.select().from(pullRequests).where(eq(pullRequests.repoId, repoId)).all(),
    jobs: await db.select().from(syncJobs).where(eq(syncJobs.repoId, repoId)).all(),
    views: await db.select().from(repoViews).where(eq(repoViews.repoId, repoId)).all(),
  };
}

describe('deleteRepoIfExpired', () => {
  it('removes an expired private repo with its children and reports it', async () => {
    const { db, id } = await seed({ isPrivate: true });
    const userId = await viewer(db, 101);
    await touchRepoView(db, { repoId: id, userId, now: BEFORE_CUTOFF });

    expect(await deleteRepoIfExpired(db, id, CUTOFF)).toBe(true);
    const after = await children(db, id);
    expect(after.repo).toBeUndefined();
    expect(after.prs).toEqual([]);
    expect(after.jobs).toEqual([]);
    expect(after.views).toEqual([]);
    // Nothing else is touched.
    expect(await db.select().from(repoViews).all()).toEqual([]);
  });

  it('removes an expired parked row whatever its visibility', async () => {
    const { db, id } = await seed({ isPrivate: false, parked: true });
    expect(await deleteRepoIfExpired(db, id, CUTOFF)).toBe(true);
    expect((await children(db, id)).repo).toBeUndefined();
  });

  it('removes a private repo nobody ever opened', async () => {
    const { db, id } = await seed({ isPrivate: true });
    expect(await deleteRepoIfExpired(db, id, CUTOFF)).toBe(true);
  });

  it('keeps a private repo someone opened at or after the cutoff, children included', async () => {
    const { db, id } = await seed({ isPrivate: true });
    const old = await viewer(db, 102);
    const recent = await viewer(db, 103);
    await touchRepoView(db, { repoId: id, userId: old, now: BEFORE_CUTOFF });
    await touchRepoView(db, { repoId: id, userId: recent, now: CUTOFF });

    expect(await deleteRepoIfExpired(db, id, CUTOFF)).toBe(false);
    const after = await children(db, id);
    expect(after.repo?.id).toBe(id);
    expect(after.prs).toHaveLength(1);
    expect(after.jobs).toHaveLength(1);
    expect(after.views).toHaveLength(2);
  });

  it('keeps a parked row that was restored and viewed after the retention scan nominated it', async () => {
    // The scan saw a parked, unviewed row; before the delete ran, the repo was
    // synced again under its real name (which restores owner/name) and opened.
    const { db, id } = await seed({ isPrivate: false, parked: true });
    await upsertRepo(db, { id, owner: 'acme', name: 'restored', isPrivate: false, totalPrs: 1 });
    const userId = await viewer(db, 104);
    await touchRepoView(db, { repoId: id, userId, now: AFTER_CUTOFF });

    expect(await deleteRepoIfExpired(db, id, CUTOFF)).toBe(false);
    const after = await children(db, id);
    expect(after.repo).toMatchObject({ id, owner: 'acme', name: 'restored' });
    expect(after.prs).toHaveLength(1);
    expect(after.jobs).toHaveLength(1);
    expect(after.views).toHaveLength(1);
  });

  it('keeps a restored row even when it was not viewed, as long as it is public', async () => {
    const { db, id } = await seed({ isPrivate: false, parked: true });
    await upsertRepo(db, { id, owner: 'acme', name: 'restored-quiet', isPrivate: false });
    expect(await deleteRepoIfExpired(db, id, CUTOFF)).toBe(false);
    expect((await children(db, id)).repo?.id).toBe(id);
  });

  it('never touches a public, addressable repo', async () => {
    const { db, id } = await seed({ isPrivate: false });
    expect(await deleteRepoIfExpired(db, id, CUTOFF)).toBe(false);
    expect(await db.select().from(repos).where(eq(repos.id, id)).get()).toBeDefined();
  });

  it('keeps the rows of a repo recreated under the same id between the parent and children deletes', async () => {
    // The scan nominated an expired private repo. Its row went (taking the old
    // children with it where D1 cascades), and before the children deletes ran
    // a fresh sync recreated the repo under the same node id and wrote a PR
    // and a job: those rows must survive, since their parent exists.
    const { db, id } = await seed({ isPrivate: true });
    const recreate = async () => {
      await upsertRepo(db, { id, owner: 'acme', name: 'reborn', isPrivate: true, totalPrs: 1 });
      await db
        .insert(pullRequests)
        .values({ repoId: id, number: 2, updatedAt: AFTER_CUTOFF, data: '{}' });
      await db.insert(syncJobs).values({
        id: `job_${id}_2`,
        repoId: id,
        mode: 'incremental',
        status: 'running',
        createdAt: AFTER_CUTOFF,
      });
    };

    expect(await deleteRepoIfExpired(interleaving(db, recreate), id, CUTOFF)).toBe(true);
    const after = await children(db, id);
    expect(after.repo).toMatchObject({ id, owner: 'acme', name: 'reborn' });
    expect(after.prs.map((pr) => pr.number)).toEqual([2]);
    expect(after.jobs.map((job) => job.id)).toEqual([`job_${id}_2`]);
  });

  it('still removes the children when nothing recreated the repo in between', async () => {
    const { db, id } = await seed({ isPrivate: true });
    expect(
      await deleteRepoIfExpired(
        interleaving(db, async () => {}),
        id,
        CUTOFF,
      ),
    ).toBe(true);
    const after = await children(db, id);
    expect(after.repo).toBeUndefined();
    expect(after.prs).toEqual([]);
    expect(after.jobs).toEqual([]);
  });

  it('reports false for an id that does not exist', async () => {
    const db = createDb(env.DB);
    expect(await deleteRepoIfExpired(db, 'R_nope', CUTOFF)).toBe(false);
  });
});
