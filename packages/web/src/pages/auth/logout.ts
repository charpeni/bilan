import { deleteSession } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { getDb } from '../../lib/db.ts';
import { clearedCookieOptions, SESSION_COOKIE } from '../../lib/session.ts';

import type { APIRoute } from 'astro';

/** Form POST only (Astro's origin check covers CSRF): drop the session row and cookie. */
export const POST: APIRoute = async ({ url, cookies, redirect }) => {
  const sessionId = cookies.get(SESSION_COOKIE)?.value;
  if (sessionId) await deleteSession(getDb(env), sessionId);
  cookies.delete(SESSION_COOKIE, clearedCookieOptions(url));
  return redirect('/', 303);
};
