import { describe, expect, it } from 'vitest';

import { secureResponse } from './response-security.ts';

describe('dynamic response security', () => {
  it('prevents framing and browser storage of authenticated payloads', async () => {
    const response = secureResponse(
      new Response('private', {
        headers: { 'cache-control': 'private, max-age=60', 'content-type': 'application/json' },
      }),
      new URL('https://bilan.test/api/repos/acme/private/payload'),
      true,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(await response.text()).toBe('private');
  });

  it('does not cache OAuth responses and preserves redirect and cookie headers', () => {
    const response = secureResponse(
      new Response(null, {
        status: 302,
        headers: { location: '/repositories', 'set-cookie': 'bilan_session=fixture; HttpOnly' },
      }),
      new URL('https://bilan.test/auth/github/callback'),
      false,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/repositories');
    expect(response.headers.get('set-cookie')).toContain('bilan_session=fixture');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps public snapshot caching and does not set HSTS on local HTTP', () => {
    const response = secureResponse(
      new Response('example', {
        headers: { 'cache-control': 'public, max-age=3600' },
      }),
      new URL('http://localhost:8788/example'),
      false,
    );
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('keeps the route response itself, so a pre-gzipped payload is not gzipped again', () => {
    // Workers reads `encodeBody: 'manual'` from the response the route built;
    // a copy would lose it and compress the gzipped bytes a second time.
    const payload = new Response(new Uint8Array([0x1f, 0x8b]), {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });
    const response = secureResponse(
      payload,
      new URL('https://bilan.test/api/repos/withastro/astro/payload'),
      false,
    );
    expect(response).toBe(payload);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});
