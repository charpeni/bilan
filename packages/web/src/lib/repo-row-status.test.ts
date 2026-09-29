import { describe, expect, it } from 'vitest';

import {
  liveStage,
  NEVER_TEXT,
  PARTIAL_TEXT,
  repoRowStatus,
  rowStatusFromProbe,
  syncingText,
} from './repo-row-status.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const base = {
  lastSyncedAt: null,
  coverageSince: null,
  syncStartedAt: null,
  activeJob: null,
  storedPrs: null,
  lastJobStatus: null,
};

describe('repoRowStatus', () => {
  it('reads a running first sync as progress with its stage', () => {
    const status = repoRowStatus(
      {
        ...base,
        syncStartedAt: '2026-09-28T11:59:00Z',
        activeJob: { status: 'running', createdAt: '2026-09-28T11:59:00Z' },
        storedPrs: 1200,
        lastJobStatus: 'running',
      },
      NOW,
    );
    expect(status).toEqual({
      kind: 'syncing',
      text: 'Syncing · 1,200 pull requests read · stage 1 of 2',
      count: 1200,
      stage: { current: 1, total: 2 },
    });
  });

  it('moves to stage 2 once the interim payload is published', () => {
    const status = repoRowStatus(
      {
        ...base,
        lastSyncedAt: '2026-09-28T11:59:30Z',
        coverageSince: '2026-09-21T11:59:30Z',
        syncStartedAt: '2026-09-28T11:59:00Z',
        activeJob: { status: 'running', createdAt: '2026-09-28T11:59:00Z' },
        storedPrs: 40,
        lastJobStatus: 'running',
      },
      NOW,
    );
    expect(status.text).toBe('Syncing · 40 pull requests read · stage 2 of 2');
  });

  it('reads a refresh of a synced repo as progress without a stage', () => {
    const status = repoRowStatus(
      {
        ...base,
        lastSyncedAt: '2026-09-28T10:00:00Z',
        syncStartedAt: '2026-09-28T11:59:00Z',
        activeJob: { status: 'running', createdAt: '2026-09-28T11:59:00Z' },
        storedPrs: 1,
        lastJobStatus: 'running',
      },
      NOW,
    );
    expect(status.text).toBe('Syncing · 1 pull request read');
  });

  it('asks for another run after a partial one', () => {
    expect(
      repoRowStatus(
        { ...base, lastSyncedAt: '2026-09-28T10:00:00Z', lastJobStatus: 'partial' },
        NOW,
      ),
    ).toEqual({ kind: 'partial', text: PARTIAL_TEXT });
  });

  it('says when and how much was synced otherwise', () => {
    expect(
      repoRowStatus(
        {
          ...base,
          lastSyncedAt: '2026-09-28T11:48:00Z',
          coverageSince: '2026-08-29T11:48:00Z',
          lastJobStatus: 'complete',
        },
        NOW,
      ),
    ).toEqual({ kind: 'synced', text: 'Synced 12 min ago · last 30 days', stale: false });
    expect(
      repoRowStatus(
        { ...base, lastSyncedAt: '2026-09-28T09:00:00Z', lastJobStatus: 'complete' },
        NOW,
      ),
    ).toEqual({ kind: 'synced', text: 'Synced 3 h ago · full history', stale: true });
  });

  it('says never for a row without a payload', () => {
    expect(repoRowStatus(base, NOW)).toEqual({ kind: 'never', text: NEVER_TEXT });
  });
});

describe('liveStage', () => {
  it('advances when a payload newer than the baseline appears while the job runs', () => {
    expect(liveStage({ current: 1, total: 2 }, null, '2026-09-28T11:59:30Z')).toEqual({
      current: 2,
      total: 2,
    });
    expect(liveStage({ current: 1, total: 2 }, null, null)).toEqual({ current: 1, total: 2 });
    expect(liveStage({ current: 2, total: 2 }, 'a', 'b')).toEqual({ current: 2, total: 2 });
    expect(liveStage(null, null, 'x')).toBeNull();
  });
});

const probe = (over: Partial<Parameters<typeof rowStatusFromProbe>[0]>) => ({
  status: 202,
  syncedAt: null,
  syncActive: true,
  prsStored: 75,
  coverageSince: null,
  ...over,
});

describe('rowStatusFromProbe', () => {
  it('counts while the job runs', () => {
    expect(rowStatusFromProbe(probe({}), { current: 1, total: 2 }, null, NOW)).toEqual({
      kind: 'syncing',
      text: syncingText(75, { current: 1, total: 2 }),
      count: 75,
      stage: { current: 1, total: 2 },
    });
  });

  it('settles on the final chip once nothing is active', () => {
    expect(
      rowStatusFromProbe(
        probe({
          status: 200,
          syncActive: false,
          syncedAt: '2026-09-28T11:59:00Z',
          coverageSince: '2026-08-29T11:59:00Z',
        }),
        { current: 1, total: 2 },
        null,
        NOW,
      ),
    ).toEqual({ kind: 'synced', text: 'Synced 1 min ago · last 30 days', stale: false });
    expect(rowStatusFromProbe(probe({ status: 404, syncActive: false }), null, null, NOW)).toEqual({
      kind: 'never',
      text: NEVER_TEXT,
    });
  });

  it('gives up on an answer it cannot read', () => {
    expect(rowStatusFromProbe(probe({ status: 401 }), null, null, NOW)).toBeNull();
  });
});
