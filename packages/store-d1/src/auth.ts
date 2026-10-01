import { and, eq, gt, lt } from 'drizzle-orm';

import { sessions, users, userTokens } from './schema.ts';

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

/** Forget a user's tokens, e.g. once GitHub rejects them; the next visit signs in again. */
export async function deleteUserToken(db: Db, userId: number): Promise<void> {
  await db.delete(userTokens).where(eq(userTokens.userId, userId));
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

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, await sessionKey(id)));
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
