import { describe, expect, it } from 'vitest';

import {
  isDeeperThanCoverage,
  readSyncLimit,
  recordSyncLimit,
  SYNC_LIMIT_TTL_S,
  syncLimitDecision,
  syncLimitKey,
} from './sync-policy.ts';

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

describe('syncLimitDecision', () => {
  it('allows when no limit is recorded or it has lapsed', () => {
    expect(
      syncLimitDecision({ limitedUntil: null, depth: '30d', coverage: covered30, now }),
    ).toEqual({ limited: false });
    expect(
      syncLimitDecision({ limitedUntil: now - 1, depth: '30d', coverage: covered30, now }),
    ).toEqual({ limited: false });
  });

  it('refuses a repeat at the same depth with the seconds left', () => {
    expect(
      syncLimitDecision({ limitedUntil: now + 90_500, depth: '30d', coverage: covered30, now }),
    ).toEqual({ limited: true, retryAfter: 91 });
    expect(
      syncLimitDecision({ limitedUntil: now + 10, depth: '30d', coverage: covered30, now }),
    ).toEqual({ limited: true, retryAfter: 1 });
  });

  it('exempts deepening beyond current coverage only', () => {
    const limited = { limitedUntil: now + 60_000, coverage: covered30, now };
    expect(syncLimitDecision({ ...limited, depth: '90d' })).toEqual({ limited: false });
    expect(syncLimitDecision({ ...limited, depth: 'all' })).toEqual({ limited: false });
    const covered90 = { ...covered30, coverageSince: new Date(now - 90 * day).toISOString() };
    expect(syncLimitDecision({ ...limited, depth: '90d', coverage: covered90 })).toEqual({
      limited: true,
      retryAfter: 60,
    });
  });
});

describe('limit storage', () => {
  it('keys per requester and repo and stores the lift instant with a TTL', async () => {
    const store = new Map<string, { value: string; ttl?: number }>();
    const cache = {
      get: async (key: string) => store.get(key)?.value ?? null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, {
          value,
          ...(options?.expirationTtl === undefined ? {} : { ttl: options.expirationTtl }),
        });
      },
    };
    expect(syncLimitKey(7, 'R_1')).toBe('sync-limit:7:R_1');
    expect(syncLimitKey('anon', 'R_1')).toBe('sync-limit:anon:R_1');
    expect(await readSyncLimit(cache, 7, 'R_1')).toBeNull();
    await recordSyncLimit(cache, 7, 'R_1', now);
    expect(store.get('sync-limit:7:R_1')).toEqual({
      value: String(now + SYNC_LIMIT_TTL_S * 1000),
      ttl: SYNC_LIMIT_TTL_S,
    });
    expect(await readSyncLimit(cache, 7, 'R_1')).toBe(now + SYNC_LIMIT_TTL_S * 1000);
    expect(await readSyncLimit(cache, 8, 'R_1')).toBeNull();
    store.set('sync-limit:7:R_2', { value: 'garbage' });
    expect(await readSyncLimit(cache, 7, 'R_2')).toBeNull();
  });
});
