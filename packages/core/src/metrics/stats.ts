export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.toSorted((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? (s[i] as number) : ((s[i - 1] as number) + (s[i] as number)) / 2;
}

/**
 * Nearest-rank percentile, `p` in [0, 1]: the `ceil(p * n)`-th smallest value
 * (1-based), so `p = 0` is the minimum and `p = 1` the maximum. It is always
 * one of the values, and for `p >= 0.5` never below `median()` of the same data.
 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = xs.toSorted((a, b) => a - b);
  const rank = Math.min(s.length, Math.max(1, Math.ceil(p * s.length)));
  return s[rank - 1] as number;
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** `a / b`, or 0 when there is nothing to divide by. */
export const share = (a: number, b: number): number => (b ? a / b : 0);

/** Occurrences of each key, in first-seen order; null and undefined keys are skipped. */
export function count<T, K>(xs: readonly T[], key: (x: T) => K | null | undefined): Map<K, number> {
  const m = new Map<K, number>();
  for (const x of xs) {
    const k = key(x);
    if (k !== null && k !== undefined) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Map entries by count, highest first; ties keep insertion order. */
export const ranked = <K>(m: ReadonlyMap<K, number>): [K, number][] =>
  [...m].toSorted((a, b) => b[1] - a[1]);
