import { describe, expect, it } from 'vitest';

import { BRIEF_COMPARE_DAYS, canCompare } from './brief.ts';
import { COVERAGE_SLACK, coversDays, isCovered } from './range.ts';
import { DAY } from './utils.ts';

const LAST = Date.UTC(2026, 3, 13, 11);
const daysAgo = (days: number, offset = 0): string =>
  new Date(LAST - days * DAY + offset).toISOString();

describe('coversDays', () => {
  it('is always true for full history', () => {
    expect(coversDays(null, LAST, 60)).toBe(true);
    expect(coversDays(null, LAST, 100_000)).toBe(true);
  });

  it('needs coverage to reach back exactly the asked number of days', () => {
    expect(coversDays(daysAgo(60), LAST, 60)).toBe(true);
    expect(coversDays(daysAgo(90), LAST, 60)).toBe(true);
    expect(coversDays(daysAgo(60, 1), LAST, 60)).toBe(false);
    expect(coversDays(daysAgo(59), LAST, 60)).toBe(false);
    expect(coversDays(daysAgo(30), LAST, 60)).toBe(false);
  });

  it('only loosens the bound when a slack is asked for', () => {
    expect(coversDays(daysAgo(60, COVERAGE_SLACK), LAST, 60, COVERAGE_SLACK)).toBe(true);
    expect(coversDays(daysAgo(60, COVERAGE_SLACK + 1), LAST, 60, COVERAGE_SLACK)).toBe(false);
  });

  it('treats an unparseable bound as covering nothing', () => {
    expect(coversDays('not a date', LAST, 60)).toBe(false);
    expect(coversDays('', LAST, 60)).toBe(false);
  });
});

describe('isCovered', () => {
  it('allows the sync-start slack for the range buttons', () => {
    expect(isCovered(daysAgo(30, COVERAGE_SLACK), LAST, '30')).toBe(true);
    expect(isCovered(daysAgo(30, COVERAGE_SLACK + 1), LAST, '30')).toBe(false);
    expect(isCovered(daysAgo(28), LAST, '30')).toBe(false);
    expect(isCovered(daysAgo(90), LAST, '90')).toBe(true);
    expect(isCovered(daysAgo(90), LAST, 'all')).toBe(false);
    expect(isCovered(null, LAST, 'all')).toBe(true);
    expect(isCovered('not a date', LAST, '30')).toBe(false);
  });
});

describe('canCompare', () => {
  it('needs the whole previous 30-day period, with no slack', () => {
    expect(BRIEF_COMPARE_DAYS).toBe(60);
    expect(canCompare(null, LAST)).toBe(true);
    expect(canCompare(daysAgo(60), LAST)).toBe(true);
    expect(canCompare(daysAgo(61), LAST)).toBe(true);
    // 59 days is a truncated previous period: the delta would be against 29 days.
    expect(canCompare(daysAgo(59), LAST)).toBe(false);
    expect(canCompare(daysAgo(60, 1), LAST)).toBe(false);
    expect(canCompare(daysAgo(30), LAST)).toBe(false);
    expect(canCompare('not a date', LAST)).toBe(false);
  });
});
