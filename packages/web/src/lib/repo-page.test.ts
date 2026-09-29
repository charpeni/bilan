import { describe, expect, it } from 'vitest';

import { repoPageState } from './repo-page.ts';

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

describe('repository presentation boundary', () => {
  it.each(['not-found', 'unavailable', 'login-required'] as const)(
    'makes a cached private row indistinguishable from an unknown row when %s',
    (kind) => {
      const hidden = repoPageState({ kind }, privateRepo);
      expect(hidden).toEqual(repoPageState({ kind }, undefined));
      expect(hidden.repo).toBeUndefined();
    },
  );

  it.each(['unknown', 'replaced'] as const)(
    'keeps an old row out of the page when access is %s',
    (kind) => {
      const decision = { kind, source: { source: 'user', userId: 7, meta: {} } } as AccessDecision;
      expect(repoPageState(decision, privateRepo)).toEqual({ view: 'syncing', repo: undefined });
    },
  );

  it('only presents cached metadata after access is allowed', () => {
    expect(repoPageState({ kind: 'ok' }, privateRepo)).toEqual({
      view: 'ready',
      repo: privateRepo,
    });
  });
});
