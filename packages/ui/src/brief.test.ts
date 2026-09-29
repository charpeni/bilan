import { describe, expect, it } from 'vitest';

import {
  BRIEF_COMPARE_DAYS,
  canCompare,
  collapsedHeight,
  firstRowCount,
  toggleText,
} from './brief.ts';
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

describe('firstRowCount', () => {
  it('counts the run of cards level with the first one', () => {
    expect(firstRowCount([0, 0, 0, 240, 240, 240, 480])).toBe(3);
    expect(firstRowCount([0, 0, 210, 210, 420])).toBe(2);
    expect(firstRowCount([0, 190, 380])).toBe(1);
  });

  it('follows the grid, not the top of the page', () => {
    expect(firstRowCount([120, 120, 340])).toBe(2);
  });

  it('puts every card on one row when nothing is laid out yet', () => {
    expect(firstRowCount([0, 0, 0, 0])).toBe(4);
    expect(firstRowCount([])).toBe(0);
  });
});

describe('collapsedHeight', () => {
  it('is the tallest first-row card plus the row gap', () => {
    expect(collapsedHeight([180, 236, 204], 32)).toBe(268);
    expect(collapsedHeight([150], 0)).toBe(150);
  });

  it('is nothing for an empty row', () => {
    expect(collapsedHeight([], 32)).toBe(0);
  });
});

describe('toggleText', () => {
  it('counts the clipped cards while collapsed', () => {
    expect(toggleText(false, 5)).toBe('Show 5 more');
    expect(toggleText(false, 0)).toBe('Show more');
    expect(toggleText(true, 5)).toBe('Show less');
  });
});
