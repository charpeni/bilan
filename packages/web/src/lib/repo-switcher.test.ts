import { describe, expect, it } from 'vitest';

import { repoHref, switcherMatches, switcherTarget } from './repo-switcher.ts';

const recent = [
  { owner: 'withastro', name: 'astro' },
  { owner: 'Acme', name: 'payments-api' },
  { owner: 'cloudflare', name: 'workers-sdk' },
  { owner: 'acme', name: 'web' },
];

describe('switcherMatches', () => {
  it('keeps every repository, in order, while the field is empty', () => {
    expect(switcherMatches('', recent)).toEqual(recent);
    expect(switcherMatches('   ', recent)).toEqual(recent);
  });

  it('matches anywhere in owner/name, case-insensitively', () => {
    expect(switcherMatches('ACME', recent).map((r) => r.name)).toEqual(['payments-api', 'web']);
    expect(switcherMatches('sdk', recent).map((r) => r.name)).toEqual(['workers-sdk']);
    expect(switcherMatches('withastro/ast', recent).map((r) => r.name)).toEqual(['astro']);
    expect(switcherMatches('nothing', recent)).toEqual([]);
  });

  it('reads a pasted GitHub URL as the repository it names', () => {
    expect(switcherMatches('https://github.com/acme/web/pull/3', recent)).toEqual([
      { owner: 'acme', name: 'web' },
    ]);
  });
});

describe('switcherTarget', () => {
  it('opens the listed repository named exactly, with its own spelling', () => {
    expect(switcherTarget('acme/payments-api', recent)).toEqual({
      owner: 'Acme',
      name: 'payments-api',
    });
    expect(switcherTarget('https://github.com/withastro/astro/tree/main', recent)).toEqual({
      owner: 'withastro',
      name: 'astro',
    });
  });

  it('opens the first match while the text filters the list', () => {
    expect(switcherTarget('acme', recent)).toEqual({ owner: 'Acme', name: 'payments-api' });
    expect(switcherTarget('withastro/ast', recent)).toEqual({ owner: 'withastro', name: 'astro' });
  });

  it('passes over the current page for another match, unless it is the only one or named', () => {
    expect(switcherTarget('a', recent, 'withastro/astro')).toEqual({
      owner: 'Acme',
      name: 'payments-api',
    });
    expect(switcherTarget('astro', recent, 'withastro/astro')).toEqual({
      owner: 'withastro',
      name: 'astro',
    });
    expect(switcherTarget('withastro/astro', recent, 'withastro/astro')).toEqual({
      owner: 'withastro',
      name: 'astro',
    });
  });

  it('opens any other repository named by owner/name or a GitHub URL', () => {
    expect(switcherTarget('vercel/turborepo', recent)).toEqual({
      owner: 'vercel',
      name: 'turborepo',
    });
    expect(switcherTarget('https://github.com/vercel/next.js/pull/1', [])).toEqual({
      owner: 'vercel',
      name: 'next.js',
    });
  });

  it('is null when the text is empty, or neither matches nor names a repository', () => {
    expect(switcherTarget('', recent)).toBeNull();
    expect(switcherTarget('nothing', recent)).toBeNull();
    expect(switcherTarget('astro', [])).toBeNull();
  });
});

describe('repoHref', () => {
  it('is the dashboard path, each part encoded', () => {
    expect(repoHref({ owner: 'withastro', name: 'astro' })).toBe('/withastro/astro');
    expect(repoHref({ owner: 'me', name: 'a#b' })).toBe('/me/a%23b');
  });
});
