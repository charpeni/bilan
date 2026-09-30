import { describe, expect, it } from 'vitest';

import { resolveToken } from './token.ts';

describe('resolveToken', () => {
  it.each(['', '   ', 'a b'])(
    'rejects an invalid explicit token without falling back',
    async (token) => {
      await expect(resolveToken(token, { GITHUB_TOKEN: 'fallback' })).rejects.toThrow(/--token/);
    },
  );

  it('trims token values and skips empty environment values', async () => {
    await expect(resolveToken(' abc ', {})).resolves.toEqual({ token: 'abc', source: '--token' });
    await expect(
      resolveToken(undefined, { GITHUB_TOKEN: '  ', GH_TOKEN: ' abc\n' }),
    ).resolves.toEqual({ token: 'abc', source: 'GH_TOKEN' });
  });

  it('prefers the explicit token', async () => {
    await expect(resolveToken('abc', { GITHUB_TOKEN: 'env' })).resolves.toEqual({
      token: 'abc',
      source: '--token',
    });
  });

  it('falls back to GITHUB_TOKEN then GH_TOKEN', async () => {
    await expect(resolveToken(undefined, { GITHUB_TOKEN: 'a', GH_TOKEN: 'b' })).resolves.toEqual({
      token: 'a',
      source: 'GITHUB_TOKEN',
    });
    await expect(resolveToken(undefined, { GH_TOKEN: 'b' })).resolves.toEqual({
      token: 'b',
      source: 'GH_TOKEN',
    });
  });
});
