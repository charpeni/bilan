import { expect, it } from 'vitest';

import { filterVisibleViews } from './views.ts';

import type { AccessDecision } from './access.ts';

interface Entry {
  repoId: string;
  isPrivate: boolean;
}

const entries: Entry[] = [
  { repoId: 'R_public_ok', isPrivate: false },
  { repoId: 'R_public_gone', isPrivate: false },
  { repoId: 'R_private_ok', isPrivate: true },
  { repoId: 'R_private_lost', isPrivate: true },
  { repoId: 'R_down', isPrivate: false },
  { repoId: 'R_replaced', isPrivate: false },
];

const decisions: Record<string, AccessDecision> = {
  R_public_ok: { kind: 'ok' },
  R_public_gone: { kind: 'not-found' },
  R_private_ok: { kind: 'ok' },
  R_private_lost: { kind: 'not-found' },
  R_down: { kind: 'unavailable' },
  R_replaced: {
    kind: 'replaced',
    source: {
      source: 'server',
      meta: {
        id: 'R_new',
        isPrivate: false,
        viewerPermission: null,
        pullRequests: { totalCount: 0 },
      },
    },
  },
};

it('keeps only the entries the check allows, public ones included, in order', async () => {
  const checked: string[] = [];
  const kept = await filterVisibleViews(entries, async (entry) => {
    checked.push(entry.repoId);
    return decisions[entry.repoId] ?? { kind: 'not-found' };
  });
  expect(kept.map((entry) => entry.repoId)).toEqual(['R_public_ok', 'R_private_ok']);
  // Public entries are checked too: they are not trusted from the row alone.
  expect(checked).toEqual(entries.map((entry) => entry.repoId));
});

it('is empty for an empty list without calling the check', async () => {
  let calls = 0;
  expect(
    await filterVisibleViews([], async () => {
      calls++;
      return { kind: 'ok' };
    }),
  ).toEqual([]);
  expect(calls).toBe(0);
});
