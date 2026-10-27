import { describe, expect, it } from 'vitest';

import {
  clearedCookieOptions,
  generateSessionId,
  isPlainHttp,
  PLAIN_HTTP_SESSION_COOKIE,
  readSessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookieName,
  sessionCookieOptions,
  sessionExpiry,
} from './session.ts';

describe('session ids', () => {
  it('are 32 random bytes in base64url', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionId()).not.toBe(id);
  });

  it('expire 30 days out', () => {
    const now = Date.parse('2026-05-01T00:00:00Z');
    expect(sessionExpiry(now)).toBe('2026-05-31T00:00:00.000Z');
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('cookie options', () => {
  it('are HttpOnly, Lax, site-wide, and Secure everywhere but localhost', () => {
    const options = sessionCookieOptions(
      new URL('https://bilan.example/x'),
      '2026-05-31T00:00:00.000Z',
    );
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date('2026-05-31T00:00:00.000Z'),
    });
    expect(sessionCookieOptions(new URL('http://localhost:8788/'), '2026-05-31').secure).toBe(
      false,
    );
    expect(clearedCookieOptions(new URL('http://127.0.0.1:8788/'))).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('treats any plain-http origin as local development', () => {
    expect(isPlainHttp(new URL('http://localhost/'))).toBe(true);
    expect(isPlainHttp(new URL('http://127.0.0.1/'))).toBe(true);
    expect(isPlainHttp(new URL('http://192.168.4.244:8788/'))).toBe(true);
    expect(isPlainHttp(new URL('https://bilan.example/'))).toBe(false);
  });
});

/** A minimal `AstroCookies.get` over fixed values. */
function jar(values: Record<string, string>) {
  return {
    get: (name: string) => {
      const value = values[name];
      return value === undefined ? undefined : { value };
    },
  };
}

describe('session cookie name', () => {
  const https = new URL('https://bilan.example/x');
  const http = new URL('http://localhost:8788/x');

  it('is __Host- over https and plain over http, where __Host- cannot be set', () => {
    expect(SESSION_COOKIE).toBe('__Host-bilan_session');
    expect(sessionCookieName(https)).toBe(SESSION_COOKIE);
    expect(sessionCookieName(http)).toBe(PLAIN_HTTP_SESSION_COOKIE);
  });

  it('prefers the __Host- cookie over https', () => {
    const cookies = jar({ [SESSION_COOKIE]: 'new', [PLAIN_HTTP_SESSION_COOKIE]: 'old' });
    expect(readSessionCookie(https, cookies)).toEqual({ sessionId: 'new', legacy: false });
  });

  it('accepts a session from before the rename over https, flagged for moving', () => {
    const cookies = jar({ [PLAIN_HTTP_SESSION_COOKIE]: 'old' });
    expect(readSessionCookie(https, cookies)).toEqual({ sessionId: 'old', legacy: true });
  });

  it('reads only the plain name over http', () => {
    expect(readSessionCookie(http, jar({ [PLAIN_HTTP_SESSION_COOKIE]: 'dev' }))).toEqual({
      sessionId: 'dev',
      legacy: false,
    });
    expect(readSessionCookie(http, jar({ [SESSION_COOKIE]: 'stray' }))).toBeNull();
  });

  it('is null without a session cookie', () => {
    expect(readSessionCookie(https, jar({}))).toBeNull();
    expect(readSessionCookie(https, jar({ [SESSION_COOKIE]: '' }))).toBeNull();
  });
});
