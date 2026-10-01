import { describe, expect, it } from 'vitest';

import { allowAutoRefresh, repoPageState } from './repo-page.ts';

import type { AccessDecision } from './access.ts';
import type { Repo } from '@bilan/store-d1';

const privateRepo = {
  id: 'R_private',
  owner: 'acme',
  name: 'secret',
  isPrivate: true,
  totalPrs: 100,
  lastSyncedAt: '2026-09-29T00:00:00Z',
} as Repo;
const publicRepo = { ...privateRepo, id: 'R_public', name: 'lib', isPrivate: false } as Repo;

describe('repository presentation boundary', () => {
  it.each(['not-found', 'unavailable', 'login-required'] as const)(
    'makes a cached private row indistinguishable from an unknown row when %s',
    (kind) => {
      for (const signedIn of [true, false]) {
        const hidden = repoPageState({ kind }, privateRepo, signedIn);
        expect(hidden).toEqual(repoPageState({ kind }, undefined, signedIn));
        expect(hidden.repo).toBeUndefined();
      }
    },
  );

  it('answers login-required with the sign-in card', () => {
    expect(repoPageState({ kind: 'login-required' }, privateRepo, false)).toEqual({
      view: 'sign-in',
      repo: undefined,
    });
  });

  it.each(['unknown', 'replaced'] as const)(
    'offers an explicit first sync for %s without exposing an old row',
    (kind) => {
      const decision = { kind, source: { source: 'user', userId: 7, meta: {} } } as AccessDecision;
      expect(repoPageState(decision, privateRepo, true)).toEqual({
        view: 'syncing',
        repo: undefined,
      });
    },
  );

  it('only presents cached metadata after access is allowed', () => {
    expect(repoPageState({ kind: 'ok' }, privateRepo, true)).toEqual({
      view: 'ready',
      repo: privateRepo,
    });
  });

  it('opens a synced public repo for a signed-out viewer', () => {
    expect(repoPageState({ kind: 'ok' }, publicRepo, false)).toEqual({
      view: 'ready',
      repo: publicRepo,
    });
  });

  it('shows a signed-out viewer the sign-in card until a first payload exists', () => {
    const unsynced = { ...publicRepo, lastSyncedAt: null };
    expect(repoPageState({ kind: 'ok' }, unsynced, false)).toEqual({
      view: 'sign-in',
      repo: undefined,
    });
    expect(repoPageState({ kind: 'ok' }, unsynced, true)).toEqual({
      view: 'syncing',
      repo: unsynced,
    });
  });
});

describe('automatic refresh intent', () => {
  it.each([null, 'cross-site', 'same-site', 'none'])(
    'does not turn a %s landing into a sync POST',
    (site) => {
      const headers = site === null ? {} : { 'sec-fetch-site': site };
      expect(allowAutoRefresh(new Request('https://bilan.test/acme/repo', { headers }))).toBe(
        false,
      );
    },
  );

  it('keeps refreshes for navigation within the app', () => {
    expect(
      allowAutoRefresh(
        new Request('https://bilan.test/acme/repo', {
          headers: { 'sec-fetch-site': 'same-origin' },
        }),
      ),
    ).toBe(true);
  });
});
