import { GithubClient } from '@bilan/core';
import { createSession, upsertUser } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { getDb } from '../../../lib/db.ts';
import { json } from '../../../lib/http.ts';
import {
  callbackFlow,
  decodeOauthState,
  githubProvider,
  loginHref,
  OAUTH_COOKIE,
  tokenGrant,
} from '../../../lib/oauth.ts';
import {
  generateSessionId,
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionExpiry,
} from '../../../lib/session.ts';
import { storeUserToken, tokenKey } from '../../../lib/tokens.ts';

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const stored = decodeOauthState(cookies.get(OAUTH_COOKIE)?.value);
  cookies.delete(OAUTH_COOKIE, { path: '/' });
  const code = url.searchParams.get('code');
  const flow = callbackFlow({
    code,
    state: url.searchParams.get('state'),
    setupAction: url.searchParams.get('setup_action'),
    installationId: url.searchParams.get('installation_id'),
    stored,
  });
  // Installation callbacks have no browser-bound state. Discard their code
  // and start a normal authorization transaction in the visiting browser.
  if (flow === 'restart') return redirect(loginHref('/repositories'), 302);
  if (flow === 'reject' || code === null) {
    return json({ message: 'OAuth state mismatch or expired; start the sign-in again' }, 400);
  }
  const next = stored?.next ?? '/repositories';

  try {
    await tokenKey(env);
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : String(error) }, 503);
  }

  let tokens;
  try {
    tokens = await githubProvider(env, url.origin).validateAuthorizationCode(code);
  } catch (error) {
    return json(
      { message: `GitHub refused the code: ${error instanceof Error ? error.message : error}` },
      502,
    );
  }
  // Read before the viewer call so the expiry is measured from when GitHub issued the token.
  const grant = tokenGrant(tokens);
  const viewer = await new GithubClient({ token: grant.accessToken }).viewer();

  const db = getDb(env);
  const now = new Date().toISOString();
  const userId = viewer.databaseId;
  await upsertUser(db, { id: userId, login: viewer.login, avatarUrl: viewer.avatarUrl, now });
  await storeUserToken(env, userId, grant, now);

  const sessionId = generateSessionId();
  const expiresAt = sessionExpiry();
  await createSession(db, { id: sessionId, userId, expiresAt });
  cookies.set(SESSION_COOKIE, sessionId, sessionCookieOptions(url, expiresAt));
  return redirect(next, 302);
};
