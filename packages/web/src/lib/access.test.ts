import { GithubError, RepoNotFoundError } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_CACHE_TTL_S,
  accessCacheKey,
  checkRepoAccess,
  VISIBILITY_CACHE_TTL_S,
  visibilityCacheKey,
} from './access.ts';
import { ReauthRequiredError } from './tokens.ts';

import type { AccessDecision, AccessDeps, AccessRepo } from './access.ts';
import type { SessionUser } from './session.ts';
import type { GithubRepoMeta } from '@bilan/core';

/** In-memory KV; TTLs are recorded but never expire. */
class FakeKv {
  readonly store = new Map<string, { value: string; ttl?: number }>();
  readonly puts: string[] = [];
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push(key);
    this.store.set(key, {
      value,
      ...(options?.expirationTtl === undefined ? {} : { ttl: options.expirationTtl }),
    });
  }
}

type MetaResult = Partial<GithubRepoMeta> | Error;

interface Fake extends AccessDeps {
  kv: FakeKv;
  /** Every `userRepoMeta` call. */
  calls: { owner: string; name: string; userId: number }[];
  /** Every `serverRepoMeta` call. */
  probes: { owner: string; name: string }[];
  /** Every `markPrivate` call. */
  marked: string[];
}

function setup(options: {
  /** What the viewer's token sees; defaults to the private repo with READ. */
  meta?: MetaResult;
  /** What the server token sees; defaults to the public repo `R_pub`. */
  server?: MetaResult;
  exampleRepo?: string;
}): Fake {
  const kv = new FakeKv();
  const fake: Fake = {
    kv,
    calls: [],
    probes: [],
    marked: [],
    cache: kv,
    exampleRepo: options.exampleRepo ?? 'withastro/astro',
    userRepoMeta: async (userId, ref) => {
      fake.calls.push({ ...ref, userId });
      const meta = options.meta ?? { viewerPermission: 'READ' };
      if (meta instanceof Error) throw meta;
      return {
        id: 'R_priv',
        isPrivate: true,
        viewerPermission: 'READ',
        pullRequests: { totalCount: 1 },
        ...meta,
      };
    },
    serverRepoMeta: async (ref) => {
      fake.probes.push(ref);
      const meta = options.server ?? {};
      if (meta instanceof Error) throw meta;
      return {
        id: 'R_pub',
        isPrivate: false,
        viewerPermission: null,
        pullRequests: { totalCount: 1 },
        ...meta,
      };
    },
    markPrivate: async (repoId) => {
      fake.marked.push(repoId);
    },
  };
  return fake;
}

const ok: AccessDecision = { kind: 'ok' };
const notFoundDecision: AccessDecision = { kind: 'not-found' };
const loginRequired: AccessDecision = { kind: 'login-required' };
const unavailable: AccessDecision = { kind: 'unavailable' };

const unknownRef = { owner: 'acme', name: 'new' };
const publicRepo: AccessRepo = { id: 'R_pub', owner: 'acme', name: 'lib', isPrivate: false };
const exampleRepo: AccessRepo = {
  id: 'R_pub',
  owner: 'withastro',
  name: 'astro',
  isPrivate: false,
};
const privateRepo: AccessRepo = { id: 'R_priv', owner: 'acme', name: 'secret', isPrivate: true };
const user: SessionUser = { id: 7, login: 'alice', avatarUrl: null };
const notFound = new RepoNotFoundError({ owner: 'acme', name: 'secret' });
const outage = new GithubError('boom', 502, true);
/** A transport failure core wraps: no HTTP status at all. */
const transport = new GithubError('fetch failed', null, true);

describe('signed out', () => {
  it('asks anyone to sign in for a non-example repo, cached or not, public or private', async () => {
    const deps = setup({});
    expect(await checkRepoAccess(deps, null, unknownRef)).toEqual(loginRequired);
    expect(await checkRepoAccess(deps, null, publicRepo)).toEqual(loginRequired);
    expect(await checkRepoAccess(deps, null, privateRepo)).toEqual(loginRequired);
    expect(deps.calls).toEqual([]);
    expect(deps.probes).toEqual([]);
    expect(deps.kv.puts).toEqual([]);
  });

  it('serves the example repo while it is public', async () => {
    const deps = setup({});
    expect(await checkRepoAccess(deps, null, exampleRepo)).toEqual(ok);
    expect(
      await checkRepoAccess(deps, null, { ...exampleRepo, owner: 'WithAstro', name: 'Astro' }),
    ).toEqual(ok);
    expect(deps.calls).toEqual([]);
  });

  it('resolves an unknown example repo on the server token so its first sync can start', async () => {
    const deps = setup({});
    const decision = await checkRepoAccess(deps, null, { owner: 'withastro', name: 'astro' });
    expect(decision).toEqual({
      kind: 'unknown',
      source: { source: 'server', meta: expect.objectContaining({ id: 'R_pub' }) },
    });
    expect(deps.calls).toEqual([]);
    expect(deps.probes).toEqual([{ owner: 'withastro', name: 'astro' }]);
  });

  it('hides the example repo once it is private', async () => {
    const deps = setup({ server: { isPrivate: true } });
    expect(await checkRepoAccess(deps, null, { ...exampleRepo, isPrivate: true })).toEqual(
      notFoundDecision,
    );
    const flipped = setup({ server: { isPrivate: true } });
    expect(await checkRepoAccess(flipped, null, exampleRepo)).toEqual(notFoundDecision);
    expect(flipped.marked).toEqual(['R_pub']);
    expect(flipped.calls).toEqual([]);
  });
});

describe('the answer never tells an unknown name from a cached private repo', () => {
  const targets = { unknown: unknownRef, public: publicRepo, private: privateRepo };

  it('signed out: login-required for every target, without touching GitHub or the cache', async () => {
    for (const target of Object.values(targets)) {
      const deps = setup({});
      expect(await checkRepoAccess(deps, null, target)).toEqual(loginRequired);
      expect(deps.calls).toEqual([]);
      expect(deps.probes).toEqual([]);
      expect(deps.kv.puts).toEqual([]);
    }
  });

  it('signed in, GitHub down: unavailable for every target, nothing cached', async () => {
    for (const failure of [outage, transport]) {
      for (const target of Object.values(targets)) {
        const deps = setup({ meta: failure, server: failure });
        expect(await checkRepoAccess(deps, user, target)).toEqual(unavailable);
        expect(deps.kv.puts).toEqual([]);
      }
    }
  });

  it('signed in, GitHub says no on both tokens: not-found for every target', async () => {
    for (const target of Object.values(targets)) {
      const deps = setup({ meta: notFound, server: notFound });
      expect(await checkRepoAccess(deps, user, target)).toEqual(notFoundDecision);
      // Unknown names go through the same two probes as an invisible private repo.
      expect(deps.calls).toHaveLength(1);
      expect(deps.probes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('signed in, GitHub down on the server token only: an unknown name is still unavailable', async () => {
    const deps = setup({ meta: notFound, server: outage });
    expect(await checkRepoAccess(deps, user, unknownRef)).toEqual(unavailable);
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(unavailable);
  });
});

describe('unknown repos', () => {
  it('are resolved on the user token first for a signed-in viewer', async () => {
    const deps = setup({ meta: { id: 'R_new', isPrivate: true, viewerPermission: 'WRITE' } });
    expect(await checkRepoAccess(deps, user, unknownRef)).toEqual({
      kind: 'unknown',
      source: { source: 'user', userId: 7, meta: expect.objectContaining({ id: 'R_new' }) },
    });
    expect(deps.calls).toEqual([{ owner: 'acme', name: 'new', userId: 7 }]);
    expect(deps.probes).toEqual([]);
    expect(deps.kv.puts).toEqual([]);
  });

  it('fall back to the server token for a public repo the app is not installed on', async () => {
    const deps = setup({ meta: notFound, server: { id: 'R_new' } });
    expect(await checkRepoAccess(deps, user, unknownRef)).toEqual({
      kind: 'unknown',
      source: { source: 'server', meta: expect.objectContaining({ id: 'R_new' }) },
    });
    expect(deps.calls).toHaveLength(1);
    expect(deps.probes).toEqual([{ owner: 'acme', name: 'new' }]);
  });

  it('are not found only once GitHub answered so on both tokens', async () => {
    const deps = setup({ meta: notFound, server: notFound });
    expect(await checkRepoAccess(deps, user, unknownRef)).toEqual(notFoundDecision);
    const hidden = setup({ meta: notFound, server: { id: 'R_new', isPrivate: true } });
    expect(await checkRepoAccess(hidden, user, unknownRef)).toEqual(notFoundDecision);
  });

  it('pass a re-login demand through', async () => {
    const reauth = new ReauthRequiredError(7, 'no GitHub token is stored');
    await expect(checkRepoAccess(setup({ meta: reauth }), user, unknownRef)).rejects.toBe(reauth);
  });
});

describe('public repos', () => {
  it('are open to any signed-in user once the server token confirms they are still public', async () => {
    const deps = setup({});
    expect(await checkRepoAccess(deps, user, publicRepo)).toEqual(ok);
    expect(deps.calls).toEqual([]);
    expect(deps.probes).toEqual([{ owner: 'acme', name: 'lib' }]);
    expect(deps.kv.store.get(visibilityCacheKey('R_pub'))).toEqual({
      value: 'public',
      ttl: VISIBILITY_CACHE_TTL_S,
    });
    expect(deps.marked).toEqual([]);
  });

  it('reuse the cached visibility instead of probing again', async () => {
    const deps = setup({});
    await checkRepoAccess(deps, user, publicRepo);
    expect(await checkRepoAccess(deps, user, publicRepo)).toEqual(ok);
    expect(await checkRepoAccess(deps, { ...user, id: 8 }, publicRepo)).toEqual(ok);
    expect(deps.probes).toHaveLength(1);
  });

  it('become private when GitHub now says so: row updated, viewer checked on their token', async () => {
    const deps = setup({ server: { isPrivate: true }, meta: { id: 'R_pub', isPrivate: true } });
    expect(await checkRepoAccess(deps, user, publicRepo)).toEqual(ok);
    expect(deps.marked).toEqual(['R_pub']);
    expect(deps.kv.store.get(visibilityCacheKey('R_pub'))).toEqual({
      value: 'private',
      ttl: VISIBILITY_CACHE_TTL_S,
    });
    expect(deps.calls).toEqual([{ owner: 'acme', name: 'lib', userId: 7 }]);
    expect(deps.kv.store.get(accessCacheKey(7, 'R_pub'))?.value).toBe('allowed');

    const denied = setup({ server: { isPrivate: true }, meta: notFound });
    expect(await checkRepoAccess(denied, user, publicRepo)).toEqual(notFoundDecision);
    expect(denied.marked).toEqual(['R_pub']);
    expect(denied.kv.store.get(accessCacheKey(7, 'R_pub'))).toBeUndefined();
  });

  it('are treated as private when the server token cannot see them any more', async () => {
    const deps = setup({ server: notFound, meta: notFound });
    expect(await checkRepoAccess(deps, user, publicRepo)).toEqual(notFoundDecision);
    expect(deps.marked).toEqual(['R_pub']);
    expect(deps.kv.store.get(visibilityCacheKey('R_pub'))?.value).toBe('private');
    expect(deps.calls).toHaveLength(1);
  });

  it('honour a cached private visibility even while the row still says public', async () => {
    const deps = setup({ meta: notFound, server: notFound });
    await deps.kv.put(visibilityCacheKey('R_pub'), 'private');
    expect(await checkRepoAccess(deps, user, publicRepo)).toEqual(notFoundDecision);
    expect(await checkRepoAccess(deps, null, publicRepo)).toEqual(loginRequired);
  });

  it('are unavailable, not exposed or hidden, when the visibility probe fails', async () => {
    for (const failure of [outage, transport]) {
      const deps = setup({ server: failure });
      expect(await checkRepoAccess(deps, user, publicRepo)).toEqual(unavailable);
      expect(await checkRepoAccess(deps, null, exampleRepo)).toEqual(unavailable);
      expect(deps.kv.puts).toEqual([]);
      expect(deps.marked).toEqual([]);
      expect(deps.calls).toEqual([]);
    }
  });

  it('surface non-GitHub failures of the probe', async () => {
    const deps = setup({ server: new Error('GITHUB_TOKEN is not configured') });
    await expect(checkRepoAccess(deps, user, publicRepo)).rejects.toThrow(/GITHUB_TOKEN/);
  });
});

describe('private repos', () => {
  const privateExample: AccessRepo = { ...exampleRepo, isPrivate: true };

  it('are hidden from signed-out viewers of the example repo while the server token cannot see them', async () => {
    const deps = setup({ server: { id: 'R_pub', isPrivate: true } });
    expect(await checkRepoAccess(deps, null, privateExample)).toEqual(notFoundDecision);
    const gone = setup({ server: notFound });
    expect(await checkRepoAccess(gone, null, privateExample)).toEqual(notFoundDecision);
    // Only the server token is asked, and nothing is cached for a signed-out viewer.
    expect(deps.calls).toEqual([]);
    expect(deps.probes).toEqual([{ owner: 'withastro', name: 'astro' }]);
    expect(deps.kv.puts).toEqual([]);
    expect(gone.kv.puts).toEqual([]);
  });

  it('serve the example repo to signed-out viewers once the server token sees the same repo public again', async () => {
    const deps = setup({ server: { id: 'R_pub' } });
    expect(await checkRepoAccess(deps, null, privateExample)).toEqual(ok);
    expect(deps.kv.puts).toEqual([]);
  });

  it('are unavailable to signed-out viewers of the example repo while GitHub is down', async () => {
    const deps = setup({ server: outage });
    expect(await checkRepoAccess(deps, null, privateExample)).toEqual(unavailable);
    expect(deps.kv.puts).toEqual([]);
  });

  it('ask GitHub on the user token and cache an allow for a readable repo', async () => {
    for (const permission of ['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'] as const) {
      const deps = setup({ meta: { viewerPermission: permission } });
      expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(ok);
      expect(deps.calls).toEqual([{ owner: 'acme', name: 'secret', userId: 7 }]);
      expect(deps.kv.store.get(accessCacheKey(7, 'R_priv'))).toEqual({
        value: 'allowed',
        ttl: ACCESS_CACHE_TTL_S,
      });
      expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(ok);
      expect(deps.calls).toHaveLength(1);
      expect(deps.probes).toEqual([]);
    }
  });

  it('deny without caching when GitHub reports no read permission', async () => {
    for (const permission of [null, 'NONE' as unknown as GithubRepoMeta['viewerPermission']]) {
      const deps = setup({ meta: { viewerPermission: permission } });
      expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(notFoundDecision);
      expect(deps.kv.puts).toEqual([]);
    }
  });

  it('deny without caching when neither token sees it (app not installed there, or gone)', async () => {
    const deps = setup({ meta: notFound, server: notFound });
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(notFoundDecision);
    expect(deps.kv.puts).toEqual([]);
    // The second look asks GitHub again, exactly like an unknown name would.
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(notFoundDecision);
    expect(deps.calls).toHaveLength(2);
    expect(deps.probes).toHaveLength(2);
  });

  it('a denied result is never cached, so the next look probes GitHub again', async () => {
    const deps = setup({ meta: notFound, server: notFound });
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(notFoundDecision);
    expect(deps.kv.store.get(accessCacheKey(7, 'R_priv'))).toBeUndefined();
    expect(deps.kv.puts).toEqual([]);
    // Access granted in the meantime: the next look sees it at once, no stale denial in the way.
    const granted = setup({ meta: { viewerPermission: 'READ' } });
    expect(await checkRepoAccess(granted, user, privateRepo)).toEqual(ok);
  });

  it('answer 503 alike for an unknown name and a previously denied private repo while GitHub is down', async () => {
    for (const failure of [outage, transport]) {
      const deps = setup({ meta: failure, server: failure });
      // A denial from before (a legacy `denied` entry, or simply a prior not-found) never short-circuits.
      await deps.kv.put(accessCacheKey(7, 'R_priv'), 'denied');
      expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(unavailable);
      expect(await checkRepoAccess(deps, user, unknownRef)).toEqual(unavailable);
    }
    // And a stale `denied` entry does not hide a repo GitHub now grants.
    const granted = setup({ meta: { viewerPermission: 'READ' } });
    await granted.kv.put(accessCacheKey(7, 'R_priv'), 'denied');
    expect(await checkRepoAccess(granted, user, privateRepo)).toEqual(ok);
    expect(granted.calls).toHaveLength(1);
  });

  it('serve a private row the server token now sees as public (same repo, gone public)', async () => {
    const deps = setup({ meta: notFound, server: { id: 'R_priv' } });
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(ok);
    expect(deps.kv.store.get(accessCacheKey(7, 'R_priv'))?.value).toBe('allowed');
  });

  it('honour a cached allow before touching GitHub', async () => {
    const deps = setup({ meta: notFound });
    await deps.kv.put(accessCacheKey(7, 'R_priv'), 'allowed');
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(ok);
    expect(deps.calls).toEqual([]);
    expect(deps.probes).toEqual([]);
  });

  it('cache per user and per repo', async () => {
    const deps = setup({ meta: { viewerPermission: 'READ' } });
    await checkRepoAccess(deps, user, privateRepo);
    expect(await checkRepoAccess(deps, { ...user, id: 8 }, privateRepo)).toEqual(ok);
    const other = setup({ meta: { id: 'R_other', viewerPermission: 'READ' } });
    expect(await checkRepoAccess(other, user, { ...privateRepo, id: 'R_other' })).toEqual(ok);
    expect(deps.calls).toHaveLength(2);
    expect(other.calls).toHaveLength(1);
  });

  it('pass a re-login demand through without caching anything', async () => {
    const reauth = new ReauthRequiredError(7, 'no GitHub token is stored');
    const deps = setup({ meta: reauth });
    await expect(checkRepoAccess(deps, user, privateRepo)).rejects.toBe(reauth);
    expect(deps.kv.puts).toEqual([]);
  });

  it('are unavailable, without caching, when GitHub fails to answer for the viewer', async () => {
    for (const failure of [outage, transport]) {
      const deps = setup({ meta: failure });
      expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(unavailable);
      expect(deps.kv.puts).toEqual([]);
    }
  });

  it('answer identically for an invisible private repo and an unknown one', async () => {
    const deps = setup({ meta: notFound, server: notFound });
    const invisible = await checkRepoAccess(deps, user, privateRepo);
    const unknown = await checkRepoAccess(deps, user, unknownRef);
    expect(invisible).toEqual(unknown);
  });
});

describe('a different repo at a cached name', () => {
  it('is reported as replaced with the newcomer on the user token, never as the old row', async () => {
    const deps = setup({ meta: { id: 'R_replacement', viewerPermission: 'ADMIN' } });
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual({
      kind: 'replaced',
      source: {
        source: 'user',
        userId: 7,
        meta: expect.objectContaining({ id: 'R_replacement' }),
      },
    });
    // Nothing is cached for either id: the newcomer gets its own row on sync.
    expect(deps.kv.puts).toEqual([]);
  });

  it('is reported as replaced for a public row too, after the row is marked private', async () => {
    const deps = setup({ server: { id: 'R_replacement' }, meta: notFound });
    expect(await checkRepoAccess(deps, user, publicRepo)).toEqual({
      kind: 'replaced',
      source: { source: 'server', meta: expect.objectContaining({ id: 'R_replacement' }) },
    });
    expect(deps.marked).toEqual(['R_pub']);
    expect(deps.kv.store.get(accessCacheKey(7, 'R_pub'))).toBeUndefined();
  });

  it('stays not-found when the newcomer is invisible too', async () => {
    const deps = setup({ meta: notFound, server: { id: 'R_replacement', isPrivate: true } });
    expect(await checkRepoAccess(deps, user, privateRepo)).toEqual(notFoundDecision);
    expect(deps.kv.puts).toEqual([]);
  });

  it('is never decided for signed-out viewers of a non-example name', async () => {
    const deps = setup({ meta: { id: 'R_replacement' }, server: { id: 'R_replacement' } });
    expect(await checkRepoAccess(deps, null, privateRepo)).toEqual(loginRequired);
    expect(deps.probes).toEqual([]);
  });

  describe('the example name, signed out', () => {
    const privateExample: AccessRepo = { ...exampleRepo, isPrivate: true };

    it('is reported as replaced on the server token when the newcomer is public', async () => {
      // The row bilan holds is private (or was flipped so by the visibility check).
      const deps = setup({ server: { id: 'R_replacement' } });
      expect(await checkRepoAccess(deps, null, privateExample)).toEqual({
        kind: 'replaced',
        source: { source: 'server', meta: expect.objectContaining({ id: 'R_replacement' }) },
      });
      expect(deps.calls).toEqual([]);
      expect(deps.probes).toEqual([{ owner: 'withastro', name: 'astro' }]);
      expect(deps.kv.puts).toEqual([]);

      // A public row whose name another public repo took over: the visibility
      // check marks the row private, then the probe reports the newcomer.
      const flipped = setup({ server: { id: 'R_replacement' } });
      expect(await checkRepoAccess(flipped, null, exampleRepo)).toEqual({
        kind: 'replaced',
        source: { source: 'server', meta: expect.objectContaining({ id: 'R_replacement' }) },
      });
      expect(flipped.marked).toEqual(['R_pub']);
    });

    it('stays not-found when the newcomer is private or the name is gone', async () => {
      const hidden = setup({ server: { id: 'R_replacement', isPrivate: true } });
      expect(await checkRepoAccess(hidden, null, privateExample)).toEqual(notFoundDecision);
      const gone = setup({ server: notFound });
      expect(await checkRepoAccess(gone, null, privateExample)).toEqual(notFoundDecision);
      expect(hidden.kv.puts).toEqual([]);
      expect(gone.kv.puts).toEqual([]);
    });
  });
});
