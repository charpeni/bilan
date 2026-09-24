import { GitHub } from 'arctic';

import type { OAuth2Tokens } from 'arctic';
import type { AstroCookieSetOptions } from 'astro';

export const OAUTH_COOKIE = 'bilan_oauth';
export const OAUTH_COOKIE_TTL_S = 10 * 60;

export interface OauthState {
  state: string;
  next: string;
}

export function isOauthConfigured(
  env: Pick<Env, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>,
): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

/**
 * The login is a GitHub App (user-to-server OAuth); arctic's GitHub provider
 * covers it since GitHub Apps share the OAuth App authorize, token, and
 * refresh endpoints. The callback URL is derived from the request so
 * localhost and production need no extra config.
 */
export function githubProvider(
  env: Pick<Env, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>,
  origin: string | null,
): GitHub {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not configured');
  }
  const redirect = origin === null ? null : callbackUrl(origin);
  return new GitHub(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, redirect);
}

export function callbackUrl(origin: string): string {
  return `${origin}/auth/github/callback`;
}

/**
 * Never any scopes: a GitHub App ignores them, its permissions are fixed on
 * the app (Pull requests: read, Metadata: read) and reach exactly the repos
 * it is installed on.
 */
export const LOGIN_SCOPES: readonly string[] = [];

/** Where to send a viewer who must (re-)sign in before landing on `next`. */
export function loginHref(next: string): string {
  return `/auth/github/start?next=${encodeURIComponent(next)}`;
}

/** The GitHub App's install screen; non-admins can request the install from there. */
export function installUrl(env: Pick<Env, 'GITHUB_APP_SLUG'>): string | null {
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (!slug) return null;
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** The origin `safeNext` resolves against; only the comparison matters, never the host. */
const NEXT_BASE = 'https://bilan.invalid';

/**
 * Only same-origin paths are valid redirect targets. The candidate must start
 * with a single `/`, contain no control characters (the URL parser strips tabs
 * and newlines, so `/\t/evil` would otherwise become `//evil`), no backslash
 * (browsers treat `/\` as `//`), and resolve against a fixed origin to that
 * same origin. The normalised path, query, and fragment are returned.
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c /* backslash */) return fallback;
  }
  let url: URL;
  try {
    url = new URL(next, NEXT_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== NEXT_BASE) return fallback;
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return fallback;
  return url.pathname + url.search + url.hash;
}

export function encodeOauthState(value: OauthState): string {
  return JSON.stringify({ state: value.state, next: value.next });
}

export function decodeOauthState(text: string | undefined): OauthState | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { state, next } = parsed as { state?: unknown; next?: unknown };
    if (typeof state !== 'string' || state === '') return null;
    return { state, next: safeNext(typeof next === 'string' ? next : null) };
  } catch {
    return null;
  }
}

export function oauthCookieOptions(secure: boolean): AstroCookieSetOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: OAUTH_COOKIE_TTL_S };
}

/** Constant-time comparison of the state echoed by GitHub with the one in the cookie. */
export function statesMatch(expected: string, actual: string | null): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

/** What the callback (or a refresh) stores for a user, before encryption. */
export interface TokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** ISO instant, or null when the app has token expiry disabled. */
  expiresAt: string | null;
  refreshExpiresAt: string | null;
}

/**
 * Read a GitHub token response without arctic's throwing accessors:
 * `expires_in`, `refresh_token`, and `refresh_token_expires_in` are all absent
 * when "Expire user authorization tokens" is off for the app.
 */
export function tokenGrant(tokens: OAuth2Tokens, now: number = Date.now()): TokenGrant {
  const data = tokens.data as Record<string, unknown>;
  const seconds = (field: string): number | null =>
    typeof data[field] === 'number' && Number.isFinite(data[field]) ? data[field] : null;
  const at = (field: string): string | null => {
    const s = seconds(field);
    return s === null ? null : new Date(now + s * 1000).toISOString();
  };
  return {
    accessToken: tokens.accessToken(),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresAt: at('expires_in'),
    refreshExpiresAt: at('refresh_token_expires_in'),
  };
}
