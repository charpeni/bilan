import { endSession } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { getDb } from '../../lib/db.ts';
import {
  clearedCookieOptions,
  PLAIN_HTTP_SESSION_COOKIE,
  readSessionCookie,
  sessionCookieName,
} from '../../lib/session.ts';

import type { APIRoute } from 'astro';

/**
 * Form POST only (Astro's origin check covers CSRF): drop the session row and
 * cookie, and the stored GitHub token set when no other session or running
 * sync of the user still needs it (see `endSession`).
 */
export const POST: APIRoute = async ({ url, cookies, redirect }) => {
  const cookie = readSessionCookie(url, cookies);
  if (cookie) await endSession(getDb(env), cookie.sessionId, new Date().toISOString());
  cookies.delete(sessionCookieName(url), clearedCookieOptions(url));
  // A session from before the `__Host-` name may still sit under the old one.
  cookies.delete(PLAIN_HTTP_SESSION_COOKIE, clearedCookieOptions(url));
  return redirect('/', 303);
};
