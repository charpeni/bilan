import { OAuth2Tokens } from 'arctic';
import { describe, expect, it } from 'vitest';

import {
  LOGIN_SCOPES,
  callbackFlow,
  callbackUrl,
  decodeOauthState,
  encodeOauthState,
  githubProvider,
  installUrl,
  isOauthConfigured,
  loginHref,
  safeNext,
  statesMatch,
  tokenGrant,
} from './oauth.ts';

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/me')).toBe('/me');
    expect(safeNext('/acme/repo?x=1#y')).toBe('/acme/repo?x=1#y');
  });

  it('falls back for anything that could leave the origin', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'me',
      '//evil.com',
      '/\\evil.com',
      '/\\\\evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      '/me\r\nSet-Cookie: x',
      'http:/evil.example',
      '\\/evil.example',
    ]) {
      expect(safeNext(bad)).toBe('/');
    }
    expect(safeNext('//evil.com', '/me')).toBe('/me');
  });

  it('rejects control characters the URL parser would strip into a protocol-relative URL', () => {
    for (const bad of [
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\u0000/evil.example',
      '/\u007f/evil.example',
      '/me\t',
      '/me\u001f',
    ]) {
      expect(safeNext(bad)).toBe('/');
    }
  });

  it('rejects backslashes anywhere, not only after the first slash', () => {
    for (const bad of ['/a\\evil.example', '/a/\\evil.example', '/me?x=\\evil']) {
      expect(safeNext(bad)).toBe('/');
    }
  });

  it('returns the normalised same-origin path', () => {
    expect(safeNext('/a/../me')).toBe('/me');
    expect(safeNext('/me?x=1&y=2#frag')).toBe('/me?x=1&y=2#frag');
    expect(safeNext('/acme/repo%2Fx')).toBe('/acme/repo%2Fx');
  });
});

describe('oauth state cookie', () => {
  it('round-trips and sanitises next on the way out', () => {
    const text = encodeOauthState({ state: 'abc', next: '/acme/repo' });
    expect(decodeOauthState(text)).toEqual({ state: 'abc', next: '/acme/repo' });
    expect(decodeOauthState(JSON.stringify({ state: 'abc', next: '//evil' }))).toEqual({
      state: 'abc',
      next: '/',
    });
  });

  it('rejects garbage', () => {
    expect(decodeOauthState(undefined)).toBeNull();
    expect(decodeOauthState('{')).toBeNull();
    expect(decodeOauthState('null')).toBeNull();
    expect(decodeOauthState(JSON.stringify({ next: '/me' }))).toBeNull();
    expect(decodeOauthState(JSON.stringify({ state: '' }))).toBeNull();
  });
});

describe('statesMatch', () => {
  it('compares exactly', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'ab')).toBe(false);
    expect(statesMatch('abc', null)).toBe(false);
  });
});

describe('provider', () => {
  const env = { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };

  it('needs both client id and secret', () => {
    expect(isOauthConfigured(env)).toBe(true);
    expect(isOauthConfigured({ GITHUB_CLIENT_ID: 'id' })).toBe(false);
    expect(() => githubProvider({}, 'http://localhost:8788')).toThrow(/GITHUB_CLIENT_ID/);
  });

  it('builds the authorize URL with client id and state, and never a scope', () => {
    const provider = githubProvider(env, 'http://localhost:8788');
    const url = provider.createAuthorizationURL('st4te', [...LOGIN_SCOPES]);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('id');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8788/auth/github/callback');
    expect(callbackUrl('https://bilan.example')).toBe('https://bilan.example/auth/github/callback');
  });
});

describe('links', () => {
  it('sends a viewer to login and back to where they were', () => {
    expect(loginHref('/acme/repo?x=1')).toBe('/auth/github/start?next=%2Facme%2Frepo%3Fx%3D1');
  });

  it('points at the GitHub App install screen only when a slug is configured', () => {
    expect(installUrl({ GITHUB_APP_SLUG: 'bilan' })).toBe(
      'https://github.com/apps/bilan/installations/new',
    );
    expect(installUrl({ GITHUB_APP_SLUG: ' ' })).toBeNull();
    expect(installUrl({ GITHUB_APP_SLUG: '' })).toBeNull();
  });
});

describe('tokenGrant', () => {
  const now = Date.parse('2026-05-01T12:00:00.000Z');

  it('reads an expiring GitHub App token response', () => {
    const tokens = new OAuth2Tokens({
      access_token: 'ghu_abc',
      expires_in: 28800,
      refresh_token: 'ghr_xyz',
      refresh_token_expires_in: 15811200,
      token_type: 'bearer',
      scope: '',
    });
    expect(tokenGrant(tokens, now)).toEqual({
      accessToken: 'ghu_abc',
      refreshToken: 'ghr_xyz',
      expiresAt: '2026-05-01T20:00:00.000Z',
      refreshExpiresAt: '2026-10-31T12:00:00.000Z',
    });
  });

  it('stores nulls when the app has token expiry disabled', () => {
    const tokens = new OAuth2Tokens({ access_token: 'ghu_abc', token_type: 'bearer' });
    expect(tokenGrant(tokens, now)).toEqual({
      accessToken: 'ghu_abc',
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
    });
    expect(() => tokens.accessTokenExpiresAt()).toThrow();
  });
});

describe('callbackFlow', () => {
  const stored = { state: 'abc', next: '/acme/widgets' };

  it('accepts a browser sign-in whose state matches the cookie', () => {
    expect(
      callbackFlow({ code: 'c', state: 'abc', setupAction: null, installationId: null, stored }),
    ).toBe('browser');
  });

  it('accepts an install-initiated authorization that carries no state', () => {
    expect(
      callbackFlow({
        code: 'c',
        state: null,
        setupAction: 'install',
        installationId: '165970809',
        stored: null,
      }),
    ).toBe('install');
  });

  it('rejects everything else', () => {
    expect(
      callbackFlow({ code: 'c', state: 'nope', setupAction: null, installationId: null, stored }),
    ).toBe('reject');
    expect(
      callbackFlow({ code: 'c', state: null, setupAction: null, installationId: null, stored }),
    ).toBe('reject');
    expect(
      callbackFlow({
        code: 'c',
        state: 'abc',
        setupAction: 'install',
        installationId: '1',
        stored: null,
      }),
    ).toBe('reject');
    expect(
      callbackFlow({
        code: null,
        state: null,
        setupAction: 'install',
        installationId: '1',
        stored: null,
      }),
    ).toBe('reject');
  });
});
