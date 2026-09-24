import { describe, expect, it } from 'vitest';

import {
  PRIVATE_RETENTION_DAYS,
  retentionCutoff,
  selectExpiredPrivateRepos,
  sweepRetention,
} from './retention.ts';

import type { RetentionDeps } from './retention.ts';
import type { RepoLastView } from '@bilan/store-d1';

const now = Date.parse('2026-05-01T00:00:00Z');

describe('retention', () => {
  it('cuts off 90 days back', () => {
    expect(PRIVATE_RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(now)).toBe('2026-01-31T00:00:00.000Z');
  });

  it('selects private repos with no view since the cutoff, never public ones', () => {
    const cutoff = retentionCutoff(now);
    expect(
      selectExpiredPrivateRepos(
        [
          { id: 'never', isPrivate: true, parked: false, lastViewedAt: null },
          { id: 'old', isPrivate: true, parked: false, lastViewedAt: '2026-01-30T23:59:59.000Z' },
          { id: 'fresh', isPrivate: true, parked: false, lastViewedAt: '2026-04-30T00:00:00.000Z' },
          { id: 'edge', isPrivate: true, parked: false, lastViewedAt: cutoff },
          {
            id: 'public-old',
            isPrivate: false,
            parked: false,
            lastViewedAt: '2025-01-01T00:00:00.000Z',
          },
          { id: 'public-never', isPrivate: false, parked: false, lastViewedAt: null },
        ],
        cutoff,
      ),
    ).toEqual(['never', 'old']);
  });
});

describe('parked rows', () => {
  it('expire on the same rule whatever their visibility', () => {
    const cutoff = '2026-06-01T00:00:00.000Z';
    const rows = [
      {
        id: 'stale-public',
        isPrivate: false,
        parked: true,
        lastViewedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'stale-recent',
        isPrivate: false,
        parked: true,
        lastViewedAt: '2026-07-01T00:00:00.000Z',
      },
      { id: 'live-public', isPrivate: false, parked: false, lastViewedAt: null },
    ];
    expect(selectExpiredPrivateRepos(rows, cutoff)).toEqual(['stale-public']);
  });
});

const expired = (id: string): RepoLastView => ({
  id,
  isPrivate: true,
  parked: false,
  lastViewedAt: null,
});

function fakeDeps(options: { failPayloads?: string[]; keepRows?: string[] } = {}) {
  const calls: string[] = [];
  const deps: RetentionDeps = {
    listRepos: () => Promise.resolve([expired('R_a'), expired('R_b'), expired('R_c')]),
    isExpired: async () => true,
    deletePayloads: (repoId) => {
      calls.push(`payloads:${repoId}`);
      if (options.failPayloads?.includes(repoId)) {
        return Promise.reject(new Error('R2 unavailable'));
      }
      return Promise.resolve();
    },
    deleteRepoIfExpired: (repoId) => {
      calls.push(`row:${repoId}`);
      return Promise.resolve(!options.keepRows?.includes(repoId));
    },
    deleteExpiredSessions: () => Promise.resolve(2),
  };
  return { deps, calls };
}

describe('sweepRetention', () => {
  it('removes payloads before the row, for every candidate', async () => {
    const { deps, calls } = fakeDeps();
    const result = await sweepRetention(deps, now);
    expect(result).toEqual({ deletedRepos: ['R_a', 'R_b', 'R_c'], deletedSessions: 2 });
    expect(calls).toEqual([
      'payloads:R_a',
      'row:R_a',
      'payloads:R_b',
      'row:R_b',
      'payloads:R_c',
      'row:R_c',
    ]);
  });

  it('keeps the row of a repo whose payload cleanup failed and does not report it deleted', async () => {
    const { deps, calls } = fakeDeps({ failPayloads: ['R_b'] });
    const result = await sweepRetention(deps, now);
    expect(result.deletedRepos).toEqual(['R_a', 'R_c']);
    // The row delete never ran for R_b: the next sweep nominates it again.
    expect(calls).not.toContain('row:R_b');
    expect(calls).toEqual(['payloads:R_a', 'row:R_a', 'payloads:R_b', 'payloads:R_c', 'row:R_c']);
  });

  it('does not report a candidate the conditional delete refused', async () => {
    const { deps } = fakeDeps({ keepRows: ['R_c'] });
    expect((await sweepRetention(deps, now)).deletedRepos).toEqual(['R_a', 'R_b']);
  });
});

describe('sweepRetention eligibility recheck', () => {
  it('leaves the payloads of a repo that stopped being eligible during the sweep', async () => {
    const calls: string[] = [];
    const result = await sweepRetention(
      {
        listRepos: async () => [
          { id: 'A', isPrivate: true, parked: false, lastViewedAt: null },
          { id: 'B', isPrivate: true, parked: false, lastViewedAt: null },
        ],
        isExpired: async (id) => id === 'A',
        deletePayloads: async (id) => {
          calls.push(`payloads:${id}`);
        },
        deleteRepoIfExpired: async (id) => {
          calls.push(`row:${id}`);
          return true;
        },
        deleteExpiredSessions: async () => 0,
      },
      Date.parse('2026-09-01T00:00:00Z'),
    );
    expect(calls).toEqual(['payloads:A', 'row:A']);
    expect(result.deletedRepos).toEqual(['A']);
  });
});
