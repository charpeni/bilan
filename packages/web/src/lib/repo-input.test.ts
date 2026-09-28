import { describe, expect, it } from 'vitest';

import { parseRepoInput } from './repo-input.ts';

describe('parseRepoInput', () => {
  it('reads owner/name', () => {
    expect(parseRepoInput('withastro/astro')).toEqual({ owner: 'withastro', name: 'astro' });
    expect(parseRepoInput('  cloudflare/workers-sdk  ')).toEqual({
      owner: 'cloudflare',
      name: 'workers-sdk',
    });
    expect(parseRepoInput('me/my.repo_2')).toEqual({ owner: 'me', name: 'my.repo_2' });
  });

  it('reads pasted GitHub URLs, wherever they point inside the repository', () => {
    const astro = { owner: 'withastro', name: 'astro' };
    expect(parseRepoInput('https://github.com/withastro/astro')).toEqual(astro);
    expect(parseRepoInput('github.com/withastro/astro/')).toEqual(astro);
    expect(parseRepoInput('https://www.github.com/withastro/astro')).toEqual(astro);
    expect(parseRepoInput('https://github.com/withastro/astro/pull/14512')).toEqual(astro);
    expect(parseRepoInput('https://github.com/withastro/astro/tree/main/packages')).toEqual(astro);
    expect(parseRepoInput('https://github.com/withastro/astro/pulls?q=is%3Aopen')).toEqual(astro);
    expect(parseRepoInput('https://github.com/withastro/astro#readme')).toEqual(astro);
    expect(parseRepoInput('https://github.com/withastro/astro.git')).toEqual(astro);
    expect(parseRepoInput('git@github.com:withastro/astro.git')).toEqual(astro);
  });

  it('is null for anything that is not a repository', () => {
    expect(parseRepoInput('')).toBeNull();
    expect(parseRepoInput('   ')).toBeNull();
    expect(parseRepoInput('astro')).toBeNull();
    expect(parseRepoInput('not a repo')).toBeNull();
    expect(parseRepoInput('https://github.com/withastro')).toBeNull();
    expect(parseRepoInput('owner/..')).toBeNull();
    expect(parseRepoInput('own er/name')).toBeNull();
    expect(parseRepoInput('https://gitlab.com/group/project')).toBeNull();
  });
});
