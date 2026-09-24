import { generateState } from 'arctic';
import { env } from 'cloudflare:workers';

import { json } from '../../../lib/http.ts';
import {
  encodeOauthState,
  githubProvider,
  isOauthConfigured,
  LOGIN_SCOPES,
  OAUTH_COOKIE,
  oauthCookieOptions,
  safeNext,
} from '../../../lib/oauth.ts';
import { isLocalhost } from '../../../lib/session.ts';

import type { APIRoute } from 'astro';

/**
 * `?next=/owner/name` is where to land after login (same-origin paths only);
 * it rides along in a short-lived cookie with the CSRF state. No scopes are
 * ever requested: the GitHub App's permissions are fixed on the app.
 */
export const GET: APIRoute = ({ url, cookies, redirect }) => {
  if (!isOauthConfigured(env)) {
    return json({ message: 'GitHub login is not configured on this deployment' }, 503);
  }
  const next = safeNext(url.searchParams.get('next'));
  const state = generateState();
  cookies.set(
    OAUTH_COOKIE,
    encodeOauthState({ state, next }),
    oauthCookieOptions(!isLocalhost(url)),
  );
  const authorize = githubProvider(env, url.origin).createAuthorizationURL(state, [
    ...LOGIN_SCOPES,
  ]);
  return redirect(authorize.toString(), 302);
};
