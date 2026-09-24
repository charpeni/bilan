import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEPTH,
  SYNC_DEPTHS,
  coverageAfterRun,
  coverageAfterSync,
  depthToSince,
  isSyncDepth,
  openPrsComplete,
  runComplete,
  trustUnchangedFrom,
  trustUnchangedFromOpen,
  widenCoverage,
} from './depth.ts';

const now = new Date('2026-05-01T12:00:00Z');

it('maps a day depth to now minus that many days', () => {
  expect(depthToSince('30d', now)?.toISOString()).toBe('2026-04-01T12:00:00.000Z');
  expect(depthToSince('90d', now)?.toISOString()).toBe('2026-01-31T12:00:00.000Z');
  expect(depthToSince('180d', now)?.toISOString()).toBe('2025-11-02T12:00:00.000Z');
});

it('has no bound for all', () => {
  expect(depthToSince('all', now)).toBeUndefined();
});

it('defaults to the current time', () => {
  const before = Date.now();
  const since = depthToSince('30d');
  expect(since).toBeDefined();
  expect(since!.getTime()).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000);
  expect(since!.getTime()).toBeLessThanOrEqual(Date.now() - 30 * 24 * 60 * 60 * 1000);
});

it('validates depth strings', () => {
  for (const depth of SYNC_DEPTHS) expect(isSyncDepth(depth)).toBe(true);
  expect(isSyncDepth(DEFAULT_DEPTH)).toBe(true);
  expect(isSyncDepth('60d')).toBe(false);
  expect(isSyncDepth('')).toBe(false);
  expect(isSyncDepth(30)).toBe(false);
  expect(isSyncDepth(undefined)).toBe(false);
});

describe('coverageAfterSync', () => {
  const syncedAt = '2026-05-01T12:00:00.000Z';
  const since = '2026-04-01T12:00:00.000Z';
  const oldest = Date.parse('2026-04-20T00:00:00.000Z');

  it('is full history when every page was walked, whatever the depth', () => {
    expect(coverageAfterSync({ stop: 'exhausted', since, oldestReached: oldest, syncedAt })).toBe(
      null,
    );
    expect(
      coverageAfterSync({ stop: 'exhausted', since: undefined, oldestReached: oldest, syncedAt }),
    ).toBe(null);
  });

  it('is the requested bound when the walk stopped at since', () => {
    expect(coverageAfterSync({ stop: 'since', since, oldestReached: oldest, syncedAt })).toBe(
      since,
    );
  });

  it('only claims one millisecond after the oldest page reached for any earlier stop', () => {
    // The oldest `updatedAt` fetched may be shared by a PR on the next, unfetched
    // page, so the bound excludes it: `oldestReached + 1`.
    for (const stop of ['already-synced', 'max-prs', 'max-pages'] as const) {
      expect(coverageAfterSync({ stop, since, oldestReached: oldest, syncedAt })).toBe(
        '2026-04-20T00:00:00.001Z',
      );
    }
    expect(coverageAfterSync({ stop: 'max-prs', since, oldestReached: null, syncedAt })).toBe(
      syncedAt,
    );
  });

  it('is not pulled up by the open pass: open completeness is tracked on its own', () => {
    expect(coverageAfterSync({ stop: 'since', since, oldestReached: oldest, syncedAt })).toBe(
      since,
    );
  });
});

describe('openPrsComplete', () => {
  it('is true when the main pass walked the whole history, whatever the open pass did', () => {
    expect(openPrsComplete('exhausted', null)).toBe(true);
    expect(openPrsComplete('exhausted', 'max-pages')).toBe(true);
  });

  it('is true when the open pass reached its end or proved the rest unchanged', () => {
    expect(openPrsComplete('since', 'exhausted')).toBe(true);
    expect(openPrsComplete('since', 'already-synced')).toBe(true);
    expect(openPrsComplete('already-synced', 'exhausted')).toBe(true);
  });

  it('is false when the open pass was cut short or never ran', () => {
    expect(openPrsComplete('since', 'max-prs')).toBe(false);
    expect(openPrsComplete('since', 'max-pages')).toBe(false);
    expect(openPrsComplete('since', null)).toBe(false);
    expect(openPrsComplete('max-prs', null)).toBe(false);
    expect(openPrsComplete('max-pages', null)).toBe(false);
  });
});

describe('runComplete', () => {
  const since = '2026-04-01T12:00:00.000Z';

  it('is true when the main pass reached its goal and no open pass was needed', () => {
    expect(runComplete({ stop: 'exhausted', openStop: null, since })).toBe(true);
    expect(runComplete({ stop: 'exhausted', openStop: null, since: undefined })).toBe(true);
    expect(runComplete({ stop: 'already-synced', openStop: null, since: undefined })).toBe(true);
  });

  it('is true when both passes reached their goal', () => {
    for (const stop of ['since', 'already-synced'] as const) {
      expect(runComplete({ stop, openStop: 'exhausted', since })).toBe(true);
      expect(runComplete({ stop, openStop: 'already-synced', since })).toBe(true);
    }
  });

  it('is false when the main pass was cut by the budget, whatever the open pass did', () => {
    for (const stop of ['max-prs', 'max-pages'] as const) {
      expect(runComplete({ stop, openStop: null, since })).toBe(false);
      expect(runComplete({ stop, openStop: 'exhausted', since })).toBe(false);
      expect(runComplete({ stop, openStop: null, since: undefined })).toBe(false);
    }
  });

  it('is false when a needed open pass was cut short or never ran', () => {
    expect(runComplete({ stop: 'since', openStop: 'max-prs', since })).toBe(false);
    expect(runComplete({ stop: 'since', openStop: 'max-pages', since })).toBe(false);
    expect(runComplete({ stop: 'since', openStop: null, since })).toBe(false);
    expect(runComplete({ stop: 'already-synced', openStop: null, since })).toBe(false);
  });
});

describe('widenCoverage', () => {
  it('keeps the earlier bound and treats null as full history', () => {
    const a = '2026-04-01T00:00:00.000Z';
    const b = '2026-01-01T00:00:00.000Z';
    expect(widenCoverage(a, b)).toBe(b);
    expect(widenCoverage(b, a)).toBe(b);
    expect(widenCoverage(null, a)).toBe(null);
    expect(widenCoverage(a, null)).toBe(null);
  });
});

describe('trustUnchangedFrom', () => {
  const coverageSince = '2026-04-01T00:00:00.000Z';
  const reconciledAt = '2026-04-30T00:00:00.000Z';
  const reconciledMs = Date.parse(reconciledAt);
  const never = { syncedAt: null, coverageSince: null, interrupted: false, reconciledAt: null };
  const synced = {
    syncedAt: '2026-05-01T00:00:00.000Z',
    coverageSince,
    interrupted: false,
    reconciledAt,
  };

  it('never stops on a first sync: a crashed earlier run may have left pages behind', () => {
    expect(trustUnchangedFrom(never, coverageSince)).toBe(-Infinity);
    expect(trustUnchangedFrom(never, undefined)).toBe(-Infinity);
  });

  it('counts pages older than the last complete run when the run stays within prior coverage', () => {
    expect(trustUnchangedFrom(synced, coverageSince)).toBe(reconciledMs);
    expect(trustUnchangedFrom(synced, '2026-04-15T00:00:00.000Z')).toBe(reconciledMs);
    expect(trustUnchangedFrom({ ...synced, coverageSince: null }, undefined)).toBe(reconciledMs);
    expect(trustUnchangedFrom({ ...synced, coverageSince: null }, coverageSince)).toBe(
      reconciledMs,
    );
  });

  it('is exclusive of reconciledAt: a page ending exactly there does not count', () => {
    // The workflow only counts a page when `oldestUpdatedAt < trustFrom`.
    const bound = trustUnchangedFrom(synced, coverageSince);
    expect(reconciledMs < bound).toBe(false);
    expect(reconciledMs - 1 < bound).toBe(true);
  });

  it('never stops when no complete run was ever recorded, even within prior coverage', () => {
    expect(trustUnchangedFrom({ ...synced, reconciledAt: null }, coverageSince)).toBe(-Infinity);
    expect(trustUnchangedFrom({ ...synced, reconciledAt: 'not a date' }, coverageSince)).toBe(
      -Infinity,
    );
  });

  it('never stops while deepening beyond prior coverage, including a full run over partial coverage', () => {
    expect(trustUnchangedFrom(synced, '2026-01-01T00:00:00.000Z')).toBe(-Infinity);
    expect(trustUnchangedFrom(synced, undefined)).toBe(-Infinity);
  });

  it('never stops after an interrupted run, even within prior coverage', () => {
    const interrupted = { ...synced, interrupted: true };
    expect(trustUnchangedFrom(interrupted, coverageSince)).toBe(-Infinity);
    expect(trustUnchangedFrom(interrupted, '2026-04-15T00:00:00.000Z')).toBe(-Infinity);
    expect(trustUnchangedFrom({ ...interrupted, coverageSince: null }, undefined)).toBe(-Infinity);
    expect(trustUnchangedFrom({ ...never, interrupted: true }, coverageSince)).toBe(-Infinity);
  });
});

describe('trustUnchangedFromOpen', () => {
  const coverageSince = '2026-04-01T00:00:00.000Z';
  const since = '2026-04-15T00:00:00.000Z';
  const reconciledAt = '2026-04-30T00:00:00.000Z';
  const complete = {
    syncedAt: '2026-05-01T00:00:00.000Z',
    coverageSince,
    openPrsSyncedAt: '2026-05-01T00:00:00.000Z',
    interrupted: false,
    reconciledAt,
  };

  it('never stops until some run has walked every open PR', () => {
    expect(trustUnchangedFromOpen({ ...complete, openPrsSyncedAt: null }, since)).toBe(-Infinity);
    expect(
      trustUnchangedFromOpen(
        {
          syncedAt: null,
          coverageSince: null,
          openPrsSyncedAt: null,
          interrupted: false,
          reconciledAt: null,
        },
        since,
      ),
    ).toBe(-Infinity);
  });

  it('counts only pages older than since once the open set is known complete', () => {
    expect(trustUnchangedFromOpen(complete, since)).toBe(Date.parse(since));
    expect(trustUnchangedFromOpen(complete, undefined)).toBe(-Infinity);
  });

  it('is capped by the last complete run when that is earlier than since', () => {
    const earlier = { ...complete, reconciledAt: '2026-04-10T00:00:00.000Z' };
    expect(trustUnchangedFromOpen(earlier, since)).toBe(Date.parse('2026-04-10T00:00:00.000Z'));
    expect(trustUnchangedFromOpen({ ...complete, reconciledAt: null }, since)).toBe(-Infinity);
  });

  it('still never stops while the main pass is deepening', () => {
    expect(trustUnchangedFromOpen(complete, '2026-01-01T00:00:00.000Z')).toBe(-Infinity);
  });

  it('never stops after an interrupted run, whatever the open set knew', () => {
    expect(trustUnchangedFromOpen({ ...complete, interrupted: true }, since)).toBe(-Infinity);
    expect(trustUnchangedFromOpen({ ...complete, interrupted: true }, undefined)).toBe(-Infinity);
  });
});

describe('coverageAfterRun', () => {
  it('takes the run bound as-is for a never-synced repo', () => {
    expect(coverageAfterRun({ syncedAt: null, coverageSince: null }, '2026-08-24T00:00:00Z')).toBe(
      '2026-08-24T00:00:00Z',
    );
  });

  it('widens afterwards and lets null (full history) win', () => {
    const prior = { syncedAt: '2026-09-01T00:00:00Z', coverageSince: '2026-08-24T00:00:00Z' };
    expect(coverageAfterRun(prior, '2026-09-10T00:00:00Z')).toBe('2026-08-24T00:00:00Z');
    expect(coverageAfterRun(prior, '2026-06-01T00:00:00Z')).toBe('2026-06-01T00:00:00Z');
    expect(coverageAfterRun(prior, null)).toBeNull();
    expect(
      coverageAfterRun(
        { syncedAt: '2026-09-01T00:00:00Z', coverageSince: null },
        '2026-06-01T00:00:00Z',
      ),
    ).toBeNull();
  });
});
