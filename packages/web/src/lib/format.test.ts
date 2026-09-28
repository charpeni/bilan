import { DAY, HOUR } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import {
  capitalize,
  dur,
  fmtAgo,
  fmtCoverage,
  fmtDay,
  fmtHistory,
  fmtInstant,
  fmtSyncedAt,
  pct,
  plural,
} from './format.ts';

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

describe('fmtAgo', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const ago = (ms: number): string => fmtAgo(new Date(now - ms).toISOString(), now);
  it('reads recent instants relative to now', () => {
    expect(ago(20e3)).toBe('just now');
    expect(ago(-60e3)).toBe('just now');
    expect(ago(12 * 60e3)).toBe('12 min ago');
    expect(ago(5 * HOUR + 59 * 60e3)).toBe('5 h ago');
    expect(ago(30 * HOUR)).toBe('yesterday');
    expect(ago(3 * DAY)).toBe('3 days ago');
  });
  it('prints the day past a week, and passes through what is not a date', () => {
    expect(ago(9 * DAY)).toBe('Sep 19, 2026');
    expect(fmtAgo('never', now)).toBe('never');
  });
});

describe('fmtHistory', () => {
  it('counts the days a bounded payload reaches back from its sync', () => {
    expect(fmtHistory(null, '2026-09-28T12:00:00Z')).toBe('full history');
    expect(fmtHistory('2026-08-29T12:00:00Z', '2026-09-28T12:05:00Z')).toBe('last 30 days');
    expect(fmtHistory('2026-06-30T12:00:00Z', '2026-09-28T12:00:00Z')).toBe('last 90 days');
    expect(fmtHistory('2026-09-28T00:00:00Z', '2026-09-28T12:00:00Z')).toBe('last day');
  });
  it('falls back to the bound without a sync instant', () => {
    expect(fmtHistory('2026-06-30T00:00:00Z', null)).toBe('since Jun 30, 2026');
    expect(fmtHistory('nope', '2026-09-28T12:00:00Z')).toBe('since nope');
  });
});

describe('fmtInstant, capitalize, plural', () => {
  it('prints the absolute instant', () => {
    expect(fmtInstant('2026-09-28T19:35:35Z')).toBe('Sep 28, 2026, 19:35 UTC');
    expect(fmtInstant('never')).toBe('never');
  });
  it('capitalises and pluralises', () => {
    expect(capitalize('last 30 days')).toBe('Last 30 days');
    expect(capitalize('')).toBe('');
    expect(plural(1, 'author')).toBe('1 author');
    expect(plural(1200, 'author')).toBe('1,200 authors');
  });
});
