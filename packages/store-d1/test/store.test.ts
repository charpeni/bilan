import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { upsertUser } from '../src/auth.ts';
import { createDb } from '../src/db.ts';
import { getRepoById, getRepoByName, STALE_OWNER, upsertRepo } from '../src/repos.ts';
import { pullRequests } from '../src/schema.ts';
import { chunk, D1Store, IN_CHUNK } from '../src/store.ts';
import { listReposWithLastView, listRepoViews, touchRepoView } from '../src/views.ts';

import type { RawPr } from '@bilan/core';

function rawPr(overrides: Partial<RawPr> = {}): RawPr {
  return {
    number: 1,
    title: 'Add thing',
    state: 'MERGED',
    isDraft: false,
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-02T10:00:00Z',
    closedAt: '2026-01-02T10:00:00Z',
    mergedAt: '2026-01-02T10:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    baseRefName: 'main',
    author: 'alice',
    authorType: 'User',
    mergedBy: 'bob',
    labels: [],
    comments: 0,
    reviewThreads: 0,
    fileSample: ['src/index.ts'],
    fileCount: 1,
    reviewCount: 1,
    reviews: [{ author: 'bob', authorType: 'User', state: 'APPROVED', at: '2026-01-01T12:00:00Z' }],
    readyAt: [],
    draftedAt: [],
    reviewRequests: [{ at: '2026-01-01T10:05:00Z', to: 'bob' }],
    ...overrides,
  };
}

let seq = 0;
async function freshRepo() {
  const db = createDb(env.DB);
  const id = `R_test_${++seq}`;
  const row = await upsertRepo(db, { id, owner: 'acme', name: `repo-${seq}`, totalPrs: 0 });
  return { db, repo: row, store: new D1Store(db, row.id, `${row.owner}/${row.name}`) };
}

describe('chunk', () => {
  it('splits into pieces of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe('D1Store', () => {
  it('starts empty with no syncedAt', async () => {
    const { store, repo } = await freshRepo();
    expect(await store.meta()).toEqual({
      repo: `acme/${repo.name}`,
      syncedAt: null,
      coverageSince: null,
      openPrsSyncedAt: null,
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: null,
    });
    expect(await store.all()).toEqual([]);
    expect(await store.updatedAtByNumber([1, 2])).toEqual(new Map());
  });

  it('round-trips upsert → updatedAtByNumber → all', async () => {
    const { store } = await freshRepo();
    await store.upsert([
      rawPr({ number: 1 }),
      rawPr({ number: 2, updatedAt: '2026-02-01T00:00:00Z' }),
    ]);

    expect(await store.updatedAtByNumber([1, 2, 3])).toEqual(
      new Map([
        [1, '2026-01-02T10:00:00Z'],
        [2, '2026-02-01T00:00:00Z'],
      ]),
    );

    await store.upsert([rawPr({ number: 1, title: 'Renamed', updatedAt: '2026-03-01T00:00:00Z' })]);
    expect((await store.updatedAtByNumber([1])).get(1)).toBe('2026-03-01T00:00:00Z');

    const all = (await store.all()).toSorted((a, b) => a.number - b.number);
    expect(all.map((pr) => [pr.number, pr.title])).toEqual([
      [1, 'Renamed'],
      [2, 'Add thing'],
    ]);
    expect(all[0]?.reviews).toEqual(rawPr().reviews);
  });

  it('handles more numbers than one IN list can hold', async () => {
    const { store } = await freshRepo();
    const count = IN_CHUNK * 2 + 5;
    const prs = Array.from({ length: count }, (_, i) => rawPr({ number: i + 1 }));
    await store.upsert(prs);
    const known = await store.updatedAtByNumber(prs.map((pr) => pr.number));
    expect(known.size).toBe(count);
  });

  it('keeps repos isolated', async () => {
    const a = await freshRepo();
    const b = await freshRepo();
    await a.store.upsert([rawPr({ number: 7 })]);
    expect(await b.store.updatedAtByNumber([7])).toEqual(new Map());
    expect(await b.store.all()).toEqual([]);
    const rows = await b.db.select().from(pullRequests).all();
    expect(rows.some((r) => r.repoId === a.repo.id)).toBe(true);
  });

  it('markSynced stamps the repo row and takes the first coverage bound as given', async () => {
    const { store, db, repo } = await freshRepo();
    await store.markSynced('2026-05-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', false, true);
    expect(await store.meta()).toEqual({
      repo: `acme/${repo.name}`,
      syncedAt: '2026-05-01T00:00:00.000Z',
      coverageSince: '2026-04-01T00:00:00.000Z',
      openPrsSyncedAt: null,
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: null,
    });
    const row = await getRepoByName(db, 'acme', repo.name);
    expect(row?.lastSyncedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(row?.coverageSince).toBe('2026-04-01T00:00:00.000Z');
    expect(row?.openPrsSyncedAt).toBeNull();
  });

  it('markSynced stamps open_prs_synced_at on a complete walk and keeps it across incomplete ones', async () => {
    const { store, db, repo } = await freshRepo();
    await store.markSynced('2026-05-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', true, true);
    expect((await store.meta()).openPrsSyncedAt).toBe('2026-05-01T00:00:00.000Z');
    await store.markSynced('2026-05-02T00:00:00.000Z', '2026-04-01T00:00:00.000Z', false, true);
    expect(await store.meta()).toMatchObject({
      syncedAt: '2026-05-02T00:00:00.000Z',
      openPrsSyncedAt: '2026-05-01T00:00:00.000Z',
    });
    await store.markSynced('2026-05-03T00:00:00.000Z', null, true, true);
    expect((await store.meta()).openPrsSyncedAt).toBe('2026-05-03T00:00:00.000Z');
    const row = await getRepoByName(db, 'acme', repo.name);
    expect(row?.openPrsSyncedAt).toBe('2026-05-03T00:00:00.000Z');
  });

  it('markSynced only widens coverage: earlier wins and null beats any instant', async () => {
    const { store } = await freshRepo();
    const coverage = async () => (await store.meta()).coverageSince;
    await store.markSynced('2026-05-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', false, true);
    await store.markSynced('2026-05-02T00:00:00.000Z', '2026-04-20T00:00:00.000Z', false, true);
    expect(await coverage()).toBe('2026-04-01T00:00:00.000Z');
    await store.markSynced('2026-05-03T00:00:00.000Z', '2026-03-01T00:00:00.000Z', false, true);
    expect(await coverage()).toBe('2026-03-01T00:00:00.000Z');
    await store.markSynced('2026-05-04T00:00:00.000Z', null, false, true);
    expect(await coverage()).toBeNull();
    await store.markSynced('2026-05-05T00:00:00.000Z', '2026-04-01T00:00:00.000Z', false, true);
    expect(await store.meta()).toMatchObject({
      syncedAt: '2026-05-05T00:00:00.000Z',
      coverageSince: null,
    });
  });

  it('a first sync with full coverage stays null afterwards', async () => {
    const { store } = await freshRepo();
    await store.markSynced('2026-05-01T00:00:00.000Z', null, false, true);
    await store.markSynced('2026-05-02T00:00:00.000Z', '2026-04-01T00:00:00.000Z', false, true);
    expect((await store.meta()).coverageSince).toBeNull();
  });

  it('markStarted flags the repo as interrupted until markSynced clears it', async () => {
    const { store, db, repo } = await freshRepo();
    await store.markSynced('2026-05-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', true, true);
    await store.markStarted('2026-05-02T00:00:00.000Z');
    expect(await store.meta()).toEqual({
      repo: `acme/${repo.name}`,
      syncedAt: '2026-05-01T00:00:00.000Z',
      coverageSince: '2026-04-01T00:00:00.000Z',
      openPrsSyncedAt: '2026-05-01T00:00:00.000Z',
      interrupted: true,
      syncStartedAt: '2026-05-02T00:00:00.000Z',
      reconciledAt: null,
    });
    expect((await getRepoById(db, repo.id))?.syncStartedAt).toBe('2026-05-02T00:00:00.000Z');
    // A metadata refresh in between must not clear it.
    await upsertRepo(db, { id: repo.id, owner: 'acme', name: repo.name, totalPrs: 3 });
    expect((await store.meta()).interrupted).toBe(true);
    await store.markSynced('2026-05-03T00:00:00.000Z', '2026-04-01T00:00:00.000Z', false, true);
    expect(await store.meta()).toMatchObject({
      interrupted: false,
      reconciledAt: '2026-05-02T00:00:00.000Z',
    });
    const row = await getRepoById(db, repo.id);
    expect(row?.syncStartedAt).toBeNull();
    expect(row?.reconciledAt).toBe('2026-05-02T00:00:00.000Z');
  });

  it('an incomplete markSynced moves syncedAt and coverage but keeps the in-flight and reconciled stamps', async () => {
    const { store, db, repo } = await freshRepo();
    await store.markStarted('2026-05-01T00:00:00.000Z');
    await store.markSynced('2026-05-01T00:05:00.000Z', '2026-04-01T00:00:00.000Z', true, true);
    await store.markStarted('2026-05-02T00:00:00.000Z');
    await store.markSynced('2026-05-02T00:05:00.000Z', '2026-03-01T00:00:00.000Z', false, false);
    expect(await store.meta()).toEqual({
      repo: `acme/${repo.name}`,
      syncedAt: '2026-05-02T00:05:00.000Z',
      coverageSince: '2026-03-01T00:00:00.000Z',
      openPrsSyncedAt: '2026-05-01T00:05:00.000Z',
      interrupted: true,
      syncStartedAt: '2026-05-02T00:00:00.000Z',
      reconciledAt: '2026-05-01T00:00:00.000Z',
    });
    expect((await getRepoById(db, repo.id))?.syncStartedAt).toBe('2026-05-02T00:00:00.000Z');
    // The next complete run keeps the cut run's start: nothing updated since
    // then had been reconciled until now.
    await store.markStarted('2026-05-03T00:00:00.000Z');
    expect((await store.meta()).syncStartedAt).toBe('2026-05-02T00:00:00.000Z');
    await store.markSynced('2026-05-03T00:05:00.000Z', '2026-03-01T00:00:00.000Z', true, true);
    expect(await store.meta()).toMatchObject({
      syncedAt: '2026-05-03T00:05:00.000Z',
      openPrsSyncedAt: '2026-05-03T00:05:00.000Z',
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: '2026-05-02T00:00:00.000Z',
    });
    // Once cleared, the next start takes.
    await store.markStarted('2026-05-04T00:00:00.000Z');
    expect((await getRepoById(db, repo.id))?.syncStartedAt).toBe('2026-05-04T00:00:00.000Z');
  });

  it('a retried complete markSynced keeps reconciled_at', async () => {
    const { store, db, repo } = await freshRepo();
    await store.markStarted('2026-05-01T00:00:00.000Z');
    await store.markSynced('2026-05-01T00:05:00.000Z', '2026-04-01T00:00:00.000Z', true, true);
    expect((await store.meta()).reconciledAt).toBe('2026-05-01T00:00:00.000Z');
    // A Workflow step retry after a later update failed runs the completion again.
    await store.markSynced('2026-05-01T00:05:00.000Z', '2026-04-01T00:00:00.000Z', true, true);
    expect(await store.meta()).toEqual({
      repo: `acme/${repo.name}`,
      syncedAt: '2026-05-01T00:05:00.000Z',
      coverageSince: '2026-04-01T00:00:00.000Z',
      openPrsSyncedAt: '2026-05-01T00:05:00.000Z',
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: '2026-05-01T00:00:00.000Z',
    });
    const row = await getRepoById(db, repo.id);
    expect(row?.reconciledAt).toBe('2026-05-01T00:00:00.000Z');
    expect(row?.syncStartedAt).toBeNull();
  });
});

describe('upsertRepo', () => {
  it('refreshes metadata without clearing sync bookkeeping', async () => {
    const { db, repo, store } = await freshRepo();
    await store.markSynced('2026-05-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', true, true);
    const updated = await upsertRepo(db, {
      id: repo.id,
      owner: 'acme',
      name: repo.name,
      totalPrs: 42,
    });
    expect(updated.totalPrs).toBe(42);
    expect(updated.lastSyncedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(updated.coverageSince).toBe('2026-04-01T00:00:00.000Z');
    expect(updated.openPrsSyncedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('lets a new repo take over a name and restores the old one when it resurfaces', async () => {
    const { db, repo: old, store } = await freshRepo();
    await store.markSynced('2026-05-01T00:00:00.000Z', null, true, true);

    const newcomer = await upsertRepo(db, {
      id: `${old.id}-new`,
      owner: old.owner,
      name: old.name,
      totalPrs: 1,
    });
    expect(newcomer.id).toBe(`${old.id}-new`);
    expect((await getRepoByName(db, old.owner, old.name))?.id).toBe(newcomer.id);

    const parked = await upsertRepo(db, {
      id: old.id,
      owner: STALE_OWNER,
      name: old.id,
      totalPrs: 0,
    });
    expect(parked.lastSyncedAt).toBe('2026-05-01T00:00:00.000Z');

    const restored = await upsertRepo(db, {
      id: old.id,
      owner: 'acme',
      name: 'renamed',
      totalPrs: 0,
    });
    expect(restored.name).toBe('renamed');
    expect(restored.lastSyncedAt).toBe('2026-05-01T00:00:00.000Z');
    expect((await getRepoByName(db, old.owner, old.name))?.id).toBe(newcomer.id);
  });
});

describe('parked rows', () => {
  const now = '2026-05-01T12:00:00.000Z';
  let userSeq = 900;

  /** A repo that a user has opened, then displaced by a newcomer at the same name. */
  async function parkedRepo() {
    const { db, repo: old } = await freshRepo();
    const user = await upsertUser(db, {
      id: ++userSeq,
      login: `viewer${userSeq}`,
      avatarUrl: null,
      now,
    });
    await touchRepoView(db, { repoId: old.id, userId: user.id, now });
    const newcomer = await upsertRepo(db, {
      id: `${old.id}-new`,
      owner: old.owner,
      name: old.name,
      totalPrs: 1,
    });
    const parked = await getRepoById(db, old.id);
    expect(parked).toMatchObject({ owner: STALE_OWNER, name: old.id });
    return { db, user, old, newcomer };
  }

  it('getRepoByName never resolves a row by its placeholder name', async () => {
    const { db, old } = await parkedRepo();
    expect(await getRepoByName(db, STALE_OWNER, old.id)).toBeUndefined();
    // The row itself is still there, reachable by id.
    expect((await getRepoById(db, old.id))?.id).toBe(old.id);
  });

  it("listRepoViews leaves the parked row out of the user's recent repos", async () => {
    const { db, user, old, newcomer } = await parkedRepo();
    await touchRepoView(db, { repoId: newcomer.id, userId: user.id, now });
    const rows = await listRepoViews(db, user.id);
    expect(rows.map((r) => r.repoId)).toEqual([newcomer.id]);
    expect(rows.some((r) => r.repoId === old.id || r.owner === STALE_OWNER)).toBe(false);
  });

  it('listReposWithLastView keeps the parked row, flagged, so retention can still sweep it', async () => {
    const { db, old, newcomer } = await parkedRepo();
    const rows = await listReposWithLastView(db);
    expect(rows.find((r) => r.id === newcomer.id)?.parked).toBe(false);
    expect(rows.find((r) => r.id === old.id)?.parked).toBe(true);
  });

  it('lists the row again once it is restored under a real name', async () => {
    const { db, user, old } = await parkedRepo();
    await upsertRepo(db, { id: old.id, owner: 'acme', name: 'renamed', totalPrs: 0 });
    expect((await listRepoViews(db, user.id)).map((r) => r.repoId)).toEqual([old.id]);
    expect((await listReposWithLastView(db)).map((r) => r.id)).toContain(old.id);
    expect((await getRepoByName(db, 'acme', 'renamed'))?.id).toBe(old.id);
  });
});
