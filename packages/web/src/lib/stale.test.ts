import { describe, expect, it } from 'vitest';

import { isStale, needsRefresh, STALE_AFTER_MS } from './stale.ts';

const now = Date.parse('2026-05-01T12:00:00Z');

it('treats never-synced as stale', () => {
  expect(isStale(null, now)).toBe(true);
  expect(isStale('not a date', now)).toBe(true);
});

it('flips to stale after one hour', () => {
  expect(isStale(new Date(now - STALE_AFTER_MS + 1).toISOString(), now)).toBe(false);
  expect(isStale(new Date(now - STALE_AFTER_MS - 1).toISOString(), now)).toBe(true);
});

describe('needsRefresh', () => {
  const fresh = new Date(now - 1000).toISOString();
  const old = new Date(now - STALE_AFTER_MS - 1).toISOString();

  it('is false for a fresh payload whose last run completed', () => {
    expect(needsRefresh({ lastSyncedAt: fresh, syncStartedAt: null }, now)).toBe(false);
  });

  it('is true once the payload is stale', () => {
    expect(needsRefresh({ lastSyncedAt: old, syncStartedAt: null }, now)).toBe(true);
    expect(needsRefresh({ lastSyncedAt: null, syncStartedAt: null }, now)).toBe(true);
  });

  it('is true right after a partial run: the in-flight marker is still set', () => {
    expect(needsRefresh({ lastSyncedAt: fresh, syncStartedAt: fresh }, now)).toBe(true);
  });
});
