import { bytesToBase64Url, randomBytes } from './encoding.ts';

import type { AstroCookieSetOptions } from 'astro';

export const SESSION_COOKIE = 'bilan_session';
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

/** Only plain http on localhost gets a non-Secure cookie, so `wrangler dev` works. */
export function isLocalhost(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

export function sessionCookieOptions(url: URL, expiresAt: string): AstroCookieSetOptions {
  return {
    httpOnly: true,
    secure: !isLocalhost(url),
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  };
}

export function clearedCookieOptions(url: URL): AstroCookieSetOptions {
  return { httpOnly: true, secure: !isLocalhost(url), sameSite: 'lax', path: '/' };
}
