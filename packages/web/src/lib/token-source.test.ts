import { GithubError, RepoNotFoundError } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import { resolveTokenSource } from './token-source.ts';
import { ReauthRequiredError } from './tokens.ts';

import type { TokenSourceDeps } from './token-source.ts';
import type { GithubRepoMeta } from '@bilan/core';

const ref = { owner: 'acme', name: 'lib' };
const notFound = new RepoNotFoundError(ref);
const user = { id: 7 };

function meta(
  isPrivate: boolean,
  viewerPermission: GithubRepoMeta['viewerPermission'] = 'READ',
): GithubRepoMeta {
  return {
    id: isPrivate ? 'R_priv' : 'R_pub',
    isPrivate,
    viewerPermission,
    pullRequests: { totalCount: 3 },
  };
}

function setup(options: {
  user?: GithubRepoMeta | Error;
  server?: GithubRepoMeta | Error;
  exampleRepo?: string;
}) {
  const calls: string[] = [];
  const answer = (
    which: 'user' | 'server',
    value: GithubRepoMeta | Error | undefined,
  ): Promise<GithubRepoMeta> => {
    calls.push(which);
    if (value === undefined) return Promise.reject(new Error(`${which} probe not expected`));
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  };
  const deps: TokenSourceDeps = {
    exampleRepo: options.exampleRepo ?? 'withastro/astro',
    userRepoMeta: () => answer('user', options.user),
    serverRepoMeta: () => answer('server', options.server),
  };
  return { deps, calls };
}

describe('signed in', () => {
  it('uses the user token when it sees the repo, private or not, without asking the server token', async () => {
    for (const m of [meta(true), meta(false), meta(true, null)]) {
      const { deps, calls } = setup({ user: m });
      expect(await resolveTokenSource(deps, user, ref)).toEqual({
        source: 'user',
        userId: 7,
        meta: m,
      });
      expect(calls).toEqual(['user']);
    }
  });

  it('falls back to the server token for a public repo the app is not installed on', async () => {
    const { deps, calls } = setup({ user: notFound, server: meta(false, null) });
    expect(await resolveTokenSource(deps, user, ref)).toEqual({
      source: 'server',
      meta: meta(false, null),
    });
    expect(calls).toEqual(['user', 'server']);
  });

  it('reports not-found when neither token sees it', async () => {
    const { deps, calls } = setup({ user: notFound, server: notFound });
    expect(await resolveTokenSource(deps, user, ref)).toEqual({ source: 'not-found' });
    expect(calls).toEqual(['user', 'server']);
  });

  it('never serves a private repo on the server token', async () => {
    const { deps } = setup({ user: notFound, server: meta(true, 'ADMIN') });
    expect(await resolveTokenSource(deps, user, ref)).toEqual({ source: 'not-found' });
  });

  it('answers identically for an invisible private repo and a nonexistent one', async () => {
    const hidden = setup({ user: notFound, server: meta(true) });
    const missing = setup({ user: notFound, server: notFound });
    expect(await resolveTokenSource(hidden.deps, user, ref)).toEqual(
      await resolveTokenSource(missing.deps, user, ref),
    );
  });

  it('lets a re-login demand and other GitHub failures through', async () => {
    const reauth = new ReauthRequiredError(7, 'expired');
    await expect(resolveTokenSource(setup({ user: reauth }).deps, user, ref)).rejects.toBe(reauth);
    const outage = new GithubError('boom', 502, true);
    await expect(resolveTokenSource(setup({ user: outage }).deps, user, ref)).rejects.toBe(outage);
    await expect(
      resolveTokenSource(setup({ user: notFound, server: outage }).deps, user, ref),
    ).rejects.toBe(outage);
  });
});

describe('signed out', () => {
  it('reads only the example repo, on the server token', async () => {
    const { deps, calls } = setup({ server: meta(false, null) });
    const example = { owner: 'WithAstro', name: 'Astro' };
    expect(await resolveTokenSource(deps, null, example)).toEqual({
      source: 'server',
      meta: meta(false, null),
    });
    expect(calls).toEqual(['server']);
  });

  it('asks anyone else to sign in without touching GitHub', async () => {
    const { deps, calls } = setup({});
    expect(await resolveTokenSource(deps, null, ref)).toEqual({ source: 'login-required' });
    expect(calls).toEqual([]);
  });
});
