import { DAY, HOUR } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import { dur, fmtCoverage, fmtDay, fmtSyncedAt, pct } from './format.ts';

describe('fmtSyncedAt', () => {
  it('prints the UTC day and time', () => {
    expect(fmtSyncedAt('2026-09-28T19:35:35.669Z')).toBe('Sep 28, 19:35 UTC');
    expect(fmtSyncedAt('2026-01-02T03:04:00Z')).toBe('Jan 2, 03:04 UTC');
  });
  it('passes through what is not a date', () => {
    expect(fmtSyncedAt('never')).toBe('never');
  });
});

describe('fmtDay and fmtCoverage', () => {
  it('prints the UTC day', () => {
    expect(fmtDay('2026-09-28T23:59:59Z')).toBe('Sep 28, 2026');
  });
  it('names full history and bounded coverage', () => {
    expect(fmtCoverage(null)).toBe('full history');
    expect(fmtCoverage('2026-06-30T00:00:00Z')).toBe('since Jun 30, 2026');
  });
});

describe('dur and pct', () => {
  it('matches the dashboard tile formats', () => {
    expect(dur(null)).toBe('—');
    expect(dur(30e3)).toBe('<1m');
    expect(dur(55 * 60e3)).toBe('55m');
    expect(dur(2.4 * HOUR)).toBe('2.4h');
    expect(dur(12 * HOUR)).toBe('12h');
    expect(dur(2.4 * DAY)).toBe('2.4d');
    expect(dur(45 * DAY)).toBe('1.5mo');
    expect(pct(null)).toBe('—');
    expect(pct(0.5)).toBe('50%');
  });
});
