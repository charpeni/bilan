import { getSessionUser } from '@bilan/store-d1';
import { defineMiddleware, sequence } from 'astro:middleware';
import { env } from 'cloudflare:workers';

import { getDb } from './lib/db.ts';
import { githubUnavailable, json } from './lib/http.ts';
import { loginHref } from './lib/oauth.ts';
import { secureResponse } from './lib/response-security.ts';
import { SESSION_COOKIE } from './lib/session.ts';
import { GithubUnavailableError, ReauthRequiredError } from './lib/tokens.ts';

/**
 * Resolve the session cookie to `locals.user` for every request (unknown or
 * expired → null). When a route needs the viewer's GitHub token and it is gone
 * or no longer refreshable, send pages back through login and give APIs a 401.
 * When GitHub could not say whether it still is (refresh failed on a network
 * error or 5xx), answer 503 and keep the stored grant.
 */
const session = defineMiddleware(async (context, next) => {
  context.locals.user = null;
  const sessionId = context.cookies.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    const row = await getSessionUser(getDb(env), sessionId, new Date().toISOString());
    if (row) {
      context.locals.user = {
        id: row.id,
        login: row.login,
        avatarUrl: row.avatarUrl,
      };
    }
  }
  try {
    return await next();
  } catch (error) {
    const { url } = context;
    const isApi = url.pathname.startsWith('/api/');
    if (error instanceof GithubUnavailableError) {
      if (isApi) return githubUnavailable();
      return new Response('GitHub is unavailable right now; try again in a minute.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
      });
    }
    if (!(error instanceof ReauthRequiredError)) throw error;
    if (isApi) {
      return json({ message: error.message }, 401, { 'cache-control': 'no-store' });
    }
    return context.redirect(loginHref(url.pathname + url.search), 302);
  }
});

export const onRequest = sequence(
  defineMiddleware(async (context, next) => {
    const response = await next();
    return secureResponse(response, context.url, context.locals.user !== null);
  }),
  session,
);
