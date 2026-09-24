export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

/** Monday-anchored week bucket, in UTC so buckets never drift with the viewer. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.getTime();
}
