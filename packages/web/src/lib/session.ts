import { bytesToBase64Url, randomBytes } from './encoding.ts';

import type { AstroCookieSetOptions } from 'astro';

/**
 * The session cookie over https. Browsers only accept a `__Host-` cookie that
 * is Secure, has `Path=/` and no `Domain`, so no other host, a subdomain
 * included, can set or overwrite it (cookie tossing).
 */
export const SESSION_COOKIE = '__Host-bilan_session';
/**
 * The session cookie over plain http in local development, where a `__Host-`
 * cookie cannot be set because it must be Secure. It is also the name every
 * session used before `SESSION_COOKIE`; see `readSessionCookie`.
 */
export const PLAIN_HTTP_SESSION_COOKIE = 'bilan_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What `locals.user` carries once the middleware has resolved the session cookie. */
export interface SessionUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

/** 32 random bytes, base64url: 256 bits of entropy, cookie-safe. */
export function generateSessionId(): string {
  return bytesToBase64Url(randomBytes(32));
}

export function sessionExpiry(now: number = Date.now()): string {
  return new Date(now + SESSION_TTL_MS).toISOString();
}

/**
 * Cookies are Secure whenever the request came over https. Plain http only
 * happens in local development (`wrangler dev` on localhost or a LAN address);
 * production on Workers is always https.
 */
export function isPlainHttp(url: URL): boolean {
  return url.protocol !== 'https:';
}

/** The name the session cookie is set under for this request. */
export function sessionCookieName(url: URL): string {
  return isPlainHttp(url) ? PLAIN_HTTP_SESSION_COOKIE : SESSION_COOKIE;
}

/** The session id a request carries, and whether it came under the old name over https. */
export interface SessionCookie {
  sessionId: string;
  /** True for a session from before `SESSION_COOKIE`: the caller moves it to the new name. */
  legacy: boolean;
}

/**
 * Read the session cookie. Over https a `__Host-` cookie wins; failing that,
 * the old name is accepted so nobody is signed out by the rename. That
 * fallback can go once every older session has expired, `SESSION_TTL_MS`
 * after the rename shipped.
 */
export function readSessionCookie(
  url: URL,
  cookies: { get(name: string): { value: string } | undefined },
): SessionCookie | null {
  const name = sessionCookieName(url);
  const current = cookies.get(name)?.value;
  if (current) return { sessionId: current, legacy: false };
  if (name === PLAIN_HTTP_SESSION_COOKIE) return null;
  const legacy = cookies.get(PLAIN_HTTP_SESSION_COOKIE)?.value;
  return legacy ? { sessionId: legacy, legacy: true } : null;
}

export function sessionCookieOptions(url: URL, expiresAt: string): AstroCookieSetOptions {
  return {
    httpOnly: true,
    secure: !isPlainHttp(url),
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  };
}

export function clearedCookieOptions(url: URL): AstroCookieSetOptions {
  return { httpOnly: true, secure: !isPlainHttp(url), sameSite: 'lax', path: '/' };
}
