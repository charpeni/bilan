import { describe, expect, it } from 'vitest';

import {
  clearedCookieOptions,
  generateSessionId,
  isPlainHttp,
  SESSION_TTL_MS,
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
