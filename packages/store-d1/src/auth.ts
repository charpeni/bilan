import { and, eq, gt, lt } from 'drizzle-orm';

import { sessions, users, userTokens } from './schema.ts';

import type { Db } from './db.ts';
import type { Session, User, UserToken } from './schema.ts';

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

export async function createSession(
  db: Db,
  session: { id: string; userId: number; expiresAt: string },
): Promise<Session> {
  return db.insert(sessions).values(session).returning().get();
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

/** The user behind an unexpired session id, or undefined. */
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
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .get();
}

/** Drop every session whose expiry is at or before `now`; returns how many went. */
export async function deleteExpiredSessions(db: Db, now: string): Promise<number> {
  const gone = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning().all();
  return gone.length;
}
