import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteUserToken,
  getSessionUser,
  getUserToken,
  upsertUser,
  upsertUserToken,
} from '../src/auth.ts';
import { createDb } from '../src/db.ts';
import { getRepoById, upsertRepo } from '../src/repos.ts';
import { pullRequests, syncJobs } from '../src/schema.ts';
import { deleteRepo, listReposWithLastView, listRepoViews, touchRepoView } from '../src/views.ts';

const now = '2026-05-01T12:00:00.000Z';
let seq = 100;

const noExpiry = (encryptedToken: string) => ({
  encryptedToken,
  encryptedRefreshToken: null,
  expiresAt: null,
  refreshExpiresAt: null,
});

async function freshUser() {
  const db = createDb(env.DB);
  const id = ++seq;
  const user = await upsertUser(db, { id, login: `user${id}`, avatarUrl: null, now });
  return { db, user };
}

describe('users and tokens', () => {
  it('upserts a user by id, refreshing login and avatar', async () => {
    const { db, user } = await freshUser();
    const again = await upsertUser(db, {
      id: user.id,
      login: 'renamed',
      avatarUrl: 'https://a/b.png',
      now: '2026-06-01T00:00:00.000Z',
    });
    expect(again).toMatchObject({ id: user.id, login: 'renamed', avatarUrl: 'https://a/b.png' });
    expect(again.createdAt).toBe(now);
  });

  it('stores one token set per user, replaces it on upsert, and forgets it on delete', async () => {
    const { db, user } = await freshUser();
    expect(await getUserToken(db, user.id)).toBeUndefined();
    await upsertUserToken(db, { userId: user.id, ...noExpiry('a'), now });
    expect(await getUserToken(db, user.id)).toMatchObject({
      encryptedToken: 'a',
      encryptedRefreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
    });
    await upsertUserToken(db, {
      userId: user.id,
      encryptedToken: 'b',
      encryptedRefreshToken: 'r',
      expiresAt: '2026-05-01T20:00:00.000Z',
      refreshExpiresAt: '2026-11-01T12:00:00.000Z',
      now,
    });
    expect(await getUserToken(db, user.id)).toMatchObject({
      encryptedToken: 'b',
      encryptedRefreshToken: 'r',
      expiresAt: '2026-05-01T20:00:00.000Z',
      refreshExpiresAt: '2026-11-01T12:00:00.000Z',
      scopes: null,
    });
    await deleteUserToken(db, user.id);
    expect(await getUserToken(db, user.id)).toBeUndefined();
  });
});

describe('sessions', () => {
  it('resolves an unexpired session to its user', async () => {
    const { db, user } = await freshUser();
    await upsertUserToken(db, { userId: user.id, ...noExpiry('x'), now });
    await createSession(db, { id: `s-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
    expect(await getSessionUser(db, `s-${user.id}`, now)).toEqual({
      id: user.id,
      login: user.login,
      avatarUrl: null,
      expiresAt: '2026-06-01',
    });
    expect(await getSessionUser(db, `s-${user.id}`, '2026-07-01')).toBeUndefined();
    expect(await getSessionUser(db, 'nope', now)).toBeUndefined();
  });

  it('works without a stored token', async () => {
    const { db, user } = await freshUser();
    await createSession(db, { id: `t-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
    expect((await getSessionUser(db, `t-${user.id}`, now))?.id).toBe(user.id);
  });

  it('deletes a session by id and sweeps expired ones', async () => {
    const { db, user } = await freshUser();
    await createSession(db, { id: `d-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
    await createSession(db, { id: `e-${user.id}`, userId: user.id, expiresAt: '2026-04-01' });
    await deleteSession(db, `d-${user.id}`);
    expect(await getSessionUser(db, `d-${user.id}`, now)).toBeUndefined();
    expect(await deleteExpiredSessions(db, now)).toBeGreaterThanOrEqual(1);
    expect(await getSessionUser(db, `e-${user.id}`, '2026-01-01')).toBeUndefined();
  });
});

describe('repo views', () => {
  it('records the latest view per user and lists them newest first', async () => {
    const { db, user } = await freshUser();
    const a = await upsertRepo(db, { id: `R_v${seq}a`, owner: 'acme', name: `va${seq}` });
    const b = await upsertRepo(db, { id: `R_v${seq}b`, owner: 'acme', name: `vb${seq}` });
    await touchRepoView(db, { repoId: a.id, userId: user.id, now: '2026-05-01T00:00:00Z' });
    await touchRepoView(db, { repoId: b.id, userId: user.id, now: '2026-05-02T00:00:00Z' });
    await touchRepoView(db, { repoId: a.id, userId: user.id, now: '2026-05-03T00:00:00Z' });
    const views = await listRepoViews(db, user.id);
    expect(views.map((v) => [v.name, v.lastViewedAt])).toEqual([
      [a.name, '2026-05-03T00:00:00Z'],
      [b.name, '2026-05-02T00:00:00Z'],
    ]);
    expect(views[0]).toMatchObject({ owner: 'acme', isPrivate: false, lastSyncedAt: null });
  });

  it('reports the last view of every repo, null for never opened', async () => {
    const { db, user } = await freshUser();
    const a = await upsertRepo(db, { id: `R_l${seq}a`, owner: 'acme', name: `la${seq}` });
    const b = await upsertRepo(db, { id: `R_l${seq}b`, owner: 'acme', name: `lb${seq}` });
    await touchRepoView(db, { repoId: a.id, userId: user.id, now });
    const rows = await listReposWithLastView(db);
    expect(rows.find((r) => r.id === a.id)?.lastViewedAt).toBe(now);
    expect(rows.find((r) => r.id === b.id)?.lastViewedAt).toBeNull();
  });

  it('deleteRepo removes the repo and everything under it', async () => {
    const { db, user } = await freshUser();
    const repo = await upsertRepo(db, { id: `R_d${seq}`, owner: 'acme', name: `d${seq}` });
    await db
      .insert(pullRequests)
      .values({ repoId: repo.id, number: 1, updatedAt: now, data: '{}' });
    await db.insert(syncJobs).values({
      id: `job-${repo.id}`,
      repoId: repo.id,
      mode: 'incremental',
      status: 'complete',
      createdAt: now,
    });
    await touchRepoView(db, { repoId: repo.id, userId: user.id, now });
    await deleteRepo(db, repo.id);
    expect(await getRepoById(db, repo.id)).toBeUndefined();
    expect(await listRepoViews(db, user.id)).toEqual([]);
    expect(await db.select().from(pullRequests).all()).not.toContainEqual(
      expect.objectContaining({ repoId: repo.id }),
    );
    expect(await db.select().from(syncJobs).all()).not.toContainEqual(
      expect.objectContaining({ repoId: repo.id }),
    );
  });
});
