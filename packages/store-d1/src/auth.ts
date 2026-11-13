import { and, eq, gt, inArray, lt, ne, notExists, sql } from 'drizzle-orm';

import { sessions, syncJobs, users, userTokens } from './schema.ts';

import type { Db } from './db.ts';
import type { User, UserToken } from './schema.ts';

/** A signed-in user as the web app sees it: the `users` row behind an unexpired session. */
export interface SessionUserRow {
  id: number;
  login: string;
  avatarUrl: string | null;
  expiresAt: string;
}

export async function upsertUser(
  db: Db,
  user: { id: number; login: string; avatarUrl: string | null; now: string },
): Promise<User> {
  return db
    .insert(users)
    .values({ id: user.id, login: user.login, avatarUrl: user.avatarUrl, createdAt: user.now })
    .onConflictDoUpdate({
      target: users.id,
      set: { login: user.login, avatarUrl: user.avatarUrl },
    })
    .returning()
    .get();
}

export async function getUserToken(db: Db, userId: number): Promise<UserToken | undefined> {
  return db.select().from(userTokens).where(eq(userTokens.userId, userId)).get();
}

export interface StoredTokenInput {
  userId: number;
  encryptedToken: string;
  encryptedRefreshToken: string | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  now: string;
}

/** Replace the stored token set (access + refresh + expiries) of a user. */
export async function upsertUserToken(db: Db, token: StoredTokenInput): Promise<UserToken> {
  const columns = {
    encryptedToken: token.encryptedToken,
    encryptedRefreshToken: token.encryptedRefreshToken,
    expiresAt: token.expiresAt,
    refreshExpiresAt: token.refreshExpiresAt,
    scopes: null,
    createdAt: token.now,
  };
  return db
    .insert(userTokens)
    .values({ userId: token.userId, ...columns })
    .onConflictDoUpdate({ target: userTokens.userId, set: columns })
    .returning()
    .get();
}

/**
 * The key a session is stored under: the hex SHA-256 of its id. The id itself
 * lives only in the browser's cookie, so a copy of the table cannot be turned
 * back into a cookie. Ids are 256 random bits, so a plain hash is enough.
 */
async function sessionKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Store a session; `id` is the cookie value, stored only as its hash (see `sessionKey`). */
export async function createSession(
  db: Db,
  session: { id: string; userId: number; expiresAt: string },
): Promise<void> {
  await db
    .insert(sessions)
    .values({ ...session, id: await sessionKey(session.id) })
    .run();
}

/**
 * The conditions under which a stored token set has outlived its use: its user
 * has no unexpired session (other than `exceptSession`, the hashed id being
 * ended) and no queued or running sync, which re-reads the token every step.
 * The sign-in callback creates the session before it stores the token, so a
 * set stored by a concurrent sign-in always has a session these see.
 */
function tokenUnused(db: Db, now: string, exceptSession?: string) {
  return and(
    notExists(
      db
        .select({ one: sql`1` })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userTokens.userId),
            gt(sessions.expiresAt, now),
            exceptSession === undefined ? undefined : ne(sessions.id, exceptSession),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(syncJobs)
        .where(
          and(
            eq(syncJobs.requestedBy, userTokens.userId),
            inArray(syncJobs.status, ['queued', 'running']),
          ),
        ),
    ),
  );
}

/**
 * Sign out: drop the session (`id` is the cookie value) and, when it was the
 * user's last unexpired one, their stored token set too. The token delete is
 * one conditional statement (see `tokenUnused`), run in the same batch before
 * the session goes, so it finds the user through the session row; a set still
 * needed by a sync is left for the nightly `deleteUnusedUserTokens`.
 */
export async function endSession(db: Db, id: string, now: string): Promise<void> {
  const key = await sessionKey(id);
  await db.batch([
    db
      .delete(userTokens)
      .where(
        and(
          eq(
            userTokens.userId,
            db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.id, key)),
          ),
          tokenUnused(db, now, key),
        ),
      ),
    db.delete(sessions).where(eq(sessions.id, key)),
  ]);
}

/** The user behind an unexpired session id (the cookie value), or undefined. */
export async function getSessionUser(
  db: Db,
  sessionId: string,
  now: string,
): Promise<SessionUserRow | undefined> {
  return db
    .select({
      id: users.id,
      login: users.login,
      avatarUrl: users.avatarUrl,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, await sessionKey(sessionId)), gt(sessions.expiresAt, now)))
    .get();
}

/** Drop every session whose expiry is at or before `now`; returns how many went. */
export async function deleteExpiredSessions(db: Db, now: string): Promise<number> {
  const gone = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning().all();
  return gone.length;
}

/**
 * Drop the token set of every user with no unexpired session and no queued or
 * running sync, in one conditional statement; returns how many went.
 */
export async function deleteUnusedUserTokens(db: Db, now: string): Promise<number> {
  const gone = await db
    .delete(userTokens)
    .where(tokenUnused(db, now))
    .returning({ userId: userTokens.userId })
    .all();
  return gone.length;
}
