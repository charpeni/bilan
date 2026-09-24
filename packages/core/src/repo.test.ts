import { describe, expect, it } from 'vitest';

import { parseRepo } from './repo.ts';

describe('parseRepo', () => {
  it.each([
    ['acme/widgets', { owner: 'acme', name: 'widgets' }],
    ['github.com/acme/widgets', { owner: 'acme', name: 'widgets' }],
    ['https://github.com/acme/widgets.git', { owner: 'acme', name: 'widgets' }],
    ['https://github.com/acme/my.repo/', { owner: 'acme', name: 'my.repo' }],
  ])('parses %s', (input, expected) => {
    expect(parseRepo(input)).toEqual(expected);
  });

  it('rejects anything else', () => {
    expect(() => parseRepo('widgets')).toThrow(/owner\/name/);
    expect(() => parseRepo('a/b/c')).toThrow();
  });
});
