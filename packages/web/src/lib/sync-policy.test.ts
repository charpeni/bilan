import { describe, expect, it } from 'vitest';

import { isDeeperThanCoverage } from './sync-policy.ts';

const now = Date.parse('2026-05-01T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const covered30 = {
  syncedAt: '2026-05-01T11:00:00Z',
  coverageSince: new Date(now - 30 * day).toISOString(),
};

describe('isDeeperThanCoverage', () => {
  it('treats a never-synced repo as covering nothing', () => {
    expect(isDeeperThanCoverage('30d', { syncedAt: null, coverageSince: null }, now)).toBe(true);
  });

  it('cannot deepen full coverage', () => {
    const full = { syncedAt: covered30.syncedAt, coverageSince: null };
    for (const depth of ['30d', '90d', '180d', 'all'] as const) {
      expect(isDeeperThanCoverage(depth, full, now)).toBe(false);
    }
  });

  it('compares the depth bound with the coverage bound', () => {
    expect(isDeeperThanCoverage('30d', covered30, now)).toBe(false);
    expect(isDeeperThanCoverage('90d', covered30, now)).toBe(true);
    expect(isDeeperThanCoverage('180d', covered30, now)).toBe(true);
    expect(isDeeperThanCoverage('all', covered30, now)).toBe(true);
    const covered90 = { ...covered30, coverageSince: new Date(now - 90 * day).toISOString() };
    expect(isDeeperThanCoverage('90d', covered90, now)).toBe(false);
    expect(isDeeperThanCoverage('180d', covered90, now)).toBe(true);
  });
});
