import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  createSession,
  deleteExpiredSessions,
  deleteUnusedUserTokens,
  endSession,
  getSessionUser,
  getUserToken,
  upsertUser,
  upsertUserToken,
} from '../src/auth.ts';
import { createDb } from '../src/db.ts';
import { getRepoById, upsertRepo } from '../src/repos.ts';
import { pullRequests, sessions, syncJobs } from '../src/schema.ts';
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

  it('stores one token set per user and replaces it on upsert', async () => {
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

  it('stores only the SHA-256 of the session id, never the cookie value', async () => {
    const { db, user } = await freshUser();
    const id = `h-${user.id}`;
    await createSession(db, { id, userId: user.id, expiresAt: '2026-06-01' });
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id)).all();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(rows.map((row) => row.id)).toEqual([hex]);
    // The stored key is not a usable cookie value.
    expect(await getSessionUser(db, hex, now)).toBeUndefined();
    expect((await getSessionUser(db, id, now))?.id).toBe(user.id);
  });

  it('works without a stored token', async () => {
    const { db, user } = await freshUser();
    await createSession(db, { id: `t-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
    expect((await getSessionUser(db, `t-${user.id}`, now))?.id).toBe(user.id);
  });

  it('ends a session by id and sweeps expired ones', async () => {
    const { db, user } = await freshUser();
    await createSession(db, { id: `d-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
    await createSession(db, { id: `e-${user.id}`, userId: user.id, expiresAt: '2026-04-01' });
    await endSession(db, `d-${user.id}`, now);
    expect(await getSessionUser(db, `d-${user.id}`, now)).toBeUndefined();
    expect(await deleteExpiredSessions(db, now)).toBeGreaterThanOrEqual(1);
    expect(await getSessionUser(db, `e-${user.id}`, '2026-01-01')).toBeUndefined();
  });
});

async function syncJob(db: ReturnType<typeof createDb>, userId: number, status: string) {
  const repo = await upsertRepo(db, { id: `R_t${userId}`, owner: 'acme', name: `t${userId}` });
  await db.insert(syncJobs).values({
    id: `job-${userId}`,
    repoId: repo.id,
    requestedBy: userId,
    mode: 'incremental',
    status,
    createdAt: now,
  });
}

/** A user with a stored token set and an unexpired session `s-<id>`. */
async function signedIn() {
  const { db, user } = await freshUser();
  await createSession(db, { id: `s-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
  await upsertUserToken(db, { userId: user.id, ...noExpiry(`tok-${user.id}`), now });
  return { db, user };
}

describe('token sets on sign-out', () => {
  it('go with the last unexpired session', async () => {
    const { db, user } = await signedIn();
    // An expired session does not keep the set.
    await createSession(db, { id: `old-${user.id}`, userId: user.id, expiresAt: '2026-04-01' });
    await endSession(db, `s-${user.id}`, now);
    expect(await getSessionUser(db, `s-${user.id}`, now)).toBeUndefined();
    expect(await getUserToken(db, user.id)).toBeUndefined();
  });

  it('stay while another session of the user is unexpired', async () => {
    const { db, user } = await signedIn();
    await createSession(db, { id: `other-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
    await endSession(db, `s-${user.id}`, now);
    expect(await getSessionUser(db, `s-${user.id}`, now)).toBeUndefined();
    expect(await getUserToken(db, user.id)).toBeDefined();
  });

  it.each(['queued', 'running'])('stay while a sync of the user is %s', async (status) => {
    const { db, user } = await signedIn();
    await syncJob(db, user.id, status);
    await endSession(db, `s-${user.id}`, now);
    expect(await getSessionUser(db, `s-${user.id}`, now)).toBeUndefined();
    expect(await getUserToken(db, user.id)).toBeDefined();
  });

  it('go when the user only has finished syncs', async () => {
    const { db, user } = await signedIn();
    await syncJob(db, user.id, 'complete');
    await endSession(db, `s-${user.id}`, now);
    expect(await getUserToken(db, user.id)).toBeUndefined();
  });

  it('survive a sign-in that landed concurrently (session stored before the token)', async () => {
    const { db, user } = await signedIn();
    await createSession(db, { id: `new-${user.id}`, userId: user.id, expiresAt: '2026-06-01' });
    await upsertUserToken(db, { userId: user.id, ...noExpiry(`fresh-${user.id}`), now });
    await endSession(db, `s-${user.id}`, now);
    expect((await getUserToken(db, user.id))?.encryptedToken).toBe(`fresh-${user.id}`);
  });

  it('are untouched when the session id is unknown', async () => {
    const { db, user } = await freshUser();
    await upsertUserToken(db, { userId: user.id, ...noExpiry('lone'), now });
    await endSession(db, `unknown-${user.id}`, now);
    expect(await getUserToken(db, user.id)).toBeDefined();
  });
});

describe('deleteUnusedUserTokens', () => {
  it('drops the sets of users with no unexpired session and no active sync', async () => {
    const active = await signedIn();
    const expired = await signedIn();
    await endSession(expired.db, `s-${expired.user.id}`, '2026-07-01');
    await createSession(expired.db, {
      id: `x-${expired.user.id}`,
      userId: expired.user.id,
      expiresAt: '2026-04-01',
    });
    await upsertUserToken(expired.db, { userId: expired.user.id, ...noExpiry('e'), now });
    const never = await freshUser();
    await upsertUserToken(never.db, { userId: never.user.id, ...noExpiry('n'), now });
    const queued = await freshUser();
    await upsertUserToken(queued.db, { userId: queued.user.id, ...noExpiry('q'), now });
    await syncJob(queued.db, queued.user.id, 'queued');
    const running = await freshUser();
    await upsertUserToken(running.db, { userId: running.user.id, ...noExpiry('r'), now });
    await syncJob(running.db, running.user.id, 'running');
    const done = await freshUser();
    await upsertUserToken(done.db, { userId: done.user.id, ...noExpiry('d'), now });
    await syncJob(done.db, done.user.id, 'errored');

    expect(await deleteUnusedUserTokens(active.db, now)).toBeGreaterThanOrEqual(3);
    expect(await getUserToken(active.db, active.user.id)).toBeDefined();
    expect(await getUserToken(active.db, queued.user.id)).toBeDefined();
    expect(await getUserToken(active.db, running.user.id)).toBeDefined();
    expect(await getUserToken(active.db, expired.user.id)).toBeUndefined();
    expect(await getUserToken(active.db, never.user.id)).toBeUndefined();
    expect(await getUserToken(active.db, done.user.id)).toBeUndefined();
    // Nothing left to drop for these users on a second pass.
    await deleteUnusedUserTokens(active.db, now);
    expect(await getUserToken(active.db, queued.user.id)).toBeDefined();
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
    // With a limit, only the most recently viewed ones.
    expect((await listRepoViews(db, user.id, 1)).map((v) => v.name)).toEqual([a.name]);
    expect(await listRepoViews(db, user.id, 5)).toHaveLength(2);
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
