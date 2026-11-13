import { describe, expect, it } from 'vitest';

import { median, percentile } from './stats.ts';

/** 1..n, shuffled so the function has to sort. */
const values = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => i + 1).toSorted((a, b) => (a % 3) - (b % 3) || b - a);

describe('percentile', () => {
  it('is null for no values', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([], 0)).toBeNull();
  });

  // Nearest rank: the ceil(p * n)-th smallest value, clamped to the first and last.
  it.each([
    [1, 0, 1],
    [1, 0.5, 1],
    [1, 0.9, 1],
    [1, 1, 1],
    [2, 0, 1],
    [2, 0.5, 1],
    [2, 0.9, 2],
    [2, 1, 2],
    [3, 0, 1],
    [3, 0.5, 2],
    [3, 0.9, 3],
    [3, 1, 3],
    [5, 0, 1],
    [5, 0.5, 3],
    [5, 0.9, 5],
    [5, 1, 5],
    [9, 0, 1],
    [9, 0.5, 5],
    [9, 0.9, 9],
    [9, 1, 9],
    [10, 0, 1],
    [10, 0.5, 5],
    [10, 0.9, 9],
    [10, 1, 10],
    [11, 0, 1],
    [11, 0.5, 6],
    [11, 0.9, 10],
    [11, 1, 11],
    [20, 0, 1],
    [20, 0.5, 10],
    [20, 0.9, 18],
    [20, 1, 20],
  ])('of 1..%i at p = %f is %i', (n, p, want) => {
    expect(percentile(values(n), p)).toBe(want);
  });

  it('puts p90 at the larger of two values, above their median', () => {
    expect(percentile([100, 1], 0.9)).toBe(100);
    expect(median([100, 1])).toBe(50.5);
  });

  it('never reports a p90 below the median of the same values', () => {
    const samples = [[0], [3, 3], [1, 100], [5, 1, 2], [7, 7, 1, 9], [1, 2, 2, 50, 50, 50]];
    for (let n = 1; n <= 30; n++)
      samples.push(
        values(n),
        values(n).map((x) => x * x),
      );
    for (const xs of samples) {
      expect(percentile(xs, 0.9)).toBeGreaterThanOrEqual(median(xs) as number);
      expect(percentile(xs, 0.5)).toBeLessThanOrEqual(percentile(xs, 0.9) as number);
    }
  });

  it('does not reorder its input', () => {
    const xs = [3, 1, 2];
    percentile(xs, 0.9);
    expect(xs).toEqual([3, 1, 2]);
  });
});
