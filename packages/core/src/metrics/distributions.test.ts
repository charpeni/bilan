import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { derive, isMerged } from './derive.ts';
import { areaBreakdown, mergeHeatmap, mergeTimeBins, sizeBins } from './distributions.ts';

const merged = (over: Parameters<typeof payloadPr>[0]) =>
  derive([payloadPr(over)]).filter(isMerged);

describe('mergeTimeBins', () => {
  it('buckets ready-to-merge with exclusive upper edges', () => {
    const prs = [
      ...merged({ m: T0 + HOUR_MS - 1 }),
      ...merged({ m: T0 + HOUR_MS }),
      ...merged({ m: T0 + 5 * DAY_MS }),
      ...merged({ m: T0 + 60 * DAY_MS }),
    ];
    const bins = mergeTimeBins(prs);
    expect(bins.map((b) => b.label)).toEqual([
      '<1h',
      '<4h',
      '<12h',
      '<1d',
      '<2d',
      '<3d',
      '<1w',
      '<2w',
      '2w+',
    ]);
    expect(bins.map((b) => b.value)).toEqual([1, 1, 0, 0, 0, 0, 1, 0, 1]);
    expect(bins[0]?.edge).toBe(HOUR_MS);
    expect(bins[8]?.edge).toBe(Infinity);
  });
});

describe('sizeBins', () => {
  it('buckets lines added + deleted', () => {
    const prs = derive([
      payloadPr({ ad: 5, de: 5 }),
      payloadPr({ ad: 5, de: 6 }),
      payloadPr({ ad: 1000, de: 0 }),
      payloadPr({ ad: 1000, de: 1 }),
    ]);
    expect(sizeBins(prs).map((b) => [b.label, b.value])).toEqual([
      ['≤10', 1],
      ['≤50', 1],
      ['≤100', 0],
      ['≤250', 0],
      ['≤500', 0],
      ['≤1k', 1],
      ['1k+', 1],
    ]);
  });
});

describe('areaBreakdown', () => {
  it('counts a PR in every area it touches, most touched first', () => {
    const prs = derive([
      payloadPr({ ar: ['api', 'web'] }),
      payloadPr({ ar: ['web'] }),
      payloadPr({ ar: [] }),
    ]);
    expect(areaBreakdown(prs)).toEqual([
      ['web', 2],
      ['api', 1],
    ]);
  });
});

describe('mergeHeatmap', () => {
  it('is a Monday-first 7x24 grid of merges in local time', () => {
    const at = T0 + 3 * HOUR_MS;
    const cells = mergeHeatmap(merged({ m: at }));
    expect(cells).toHaveLength(7);
    for (const row of cells) expect(row).toHaveLength(24);
    const d = new Date(at);
    expect(cells[(d.getDay() + 6) % 7]?.[d.getHours()]).toBe(1);
    expect(cells.flat().reduce((a, b) => a + b, 0)).toBe(1);
  });
});
