import { describe, expect, it } from 'vitest';

import { comparisonText } from './comparison.ts';
import { HOUR } from './utils.ts';

describe('comparisonText', () => {
  it('shows count changes without implying whether volume is good or bad', () => {
    expect(comparisonText(84, 105, 'count')).toBe('↓ 20% · was 105');
    expect(comparisonText(120, 100, 'count')).toBe('↑ 20% · was 100');
    expect(comparisonText(0, 10, 'count')).toBe('↓ 100% · was 10');
    expect(comparisonText(0, 0, 'count')).toBe('No change · was 0');
    expect(comparisonText(3, 0, 'count')).toBe('New · was 0');
  });

  it('describes review and merge durations as faster or slower', () => {
    expect(comparisonText(6 * HOUR, 9 * HOUR, 'speed')).toBe('33% faster · was 9.0h');
    expect(comparisonText(9 * HOUR, 6 * HOUR, 'speed')).toBe('50% slower · was 6.0h');
    expect(comparisonText(6 * HOUR, 9 * HOUR, 'duration')).toBe('33% shorter · was 9.0h');
    expect(comparisonText(HOUR, 0, 'speed')).toBe('was <1m');
  });

  it('distinguishes missing samples from zero duration', () => {
    expect(comparisonText(null, null, 'speed')).toBe('No data in either period');
    expect(comparisonText(HOUR, null, 'speed')).toBe('No previous data');
    expect(comparisonText(null, HOUR, 'speed')).toBe('No current data · was 1.0h');
    expect(comparisonText(0, HOUR, 'speed')).toBe('100% faster · was 1.0h');
  });
});
