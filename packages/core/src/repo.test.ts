import { describe, expect, it } from 'vitest';

import { parseRepo } from './repo.ts';

describe('parseRepo', () => {
  it.each([
    ['acme/widgets', { owner: 'acme', name: 'widgets' }],
    ['github.com/acme/widgets', { owner: 'acme', name: 'widgets' }],
    ['https://github.com/acme/widgets.git', { owner: 'acme', name: 'widgets' }],
    ['https://github.com/acme/my.repo/', { owner: 'acme', name: 'my.repo' }],
    ['acme-org/.github', { owner: 'acme-org', name: '.github' }],
    ['user_enterprise/a..b', { owner: 'user_enterprise', name: 'a..b' }],
  ])('parses %s', (input, expected) => {
    expect(parseRepo(input)).toEqual(expected);
  });

  it('rejects anything else', () => {
    expect(() => parseRepo('widgets')).toThrow(/owner\/name/);
    expect(() => parseRepo('a/b/c')).toThrow();
  });

  it.each([
    '../widgets',
    './widgets',
    'acme/..',
    'acme/.',
    'ac.me/widgets',
    '-acme/widgets',
    'acme-/widgets',
  ])('rejects unsafe repository %s', (input) => {
    expect(() => parseRepo(input)).toThrow(/owner\/name/);
  });
});
