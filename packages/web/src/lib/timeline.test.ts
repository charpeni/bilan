import { HOUR } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import { timelineFigure } from './timeline.ts';

import type { Headline } from '@bilan/core';

const base: Headline = {
  opened: 10,
  authors: 3,
  merged: 8,
  mergedShare: 0.8,
  rejected: 2,
  stillOpen: 1,
  medMerge: 20 * HOUR,
  p90Merge: 40 * HOUR,
  medFirst: 2 * HOUR,
  reviewedShare: 0.9,
  medReady: 5 * HOUR,
  draftShare: 0.3,
  reviews: 12,
  reviewers: 4,
};

describe('timelineFigure', () => {
  it('puts the anchor after the draft and measures both spans from it', () => {
    const f = timelineFigure(base);
    expect(f).not.toBeNull();
    // 5h draft + 20h to merge = 25h axis.
    expect(f?.ready).toBe(20);
    expect(f?.first).toBe(8);
    expect(f?.merge).toBe(80);
    expect(f?.ticks.map((t) => t.label)).toEqual(['0h', '6h', '12h', '18h']);
    expect(f?.ticks[0]?.at).toBe(20);
  });

  it('starts at the anchor when nothing was drafted', () => {
    expect(timelineFigure({ ...base, medReady: null })?.ready).toBe(0);
  });

  it('draws nothing without both measured medians', () => {
    expect(timelineFigure({ ...base, medFirst: null })).toBeNull();
    expect(timelineFigure({ ...base, medMerge: null })).toBeNull();
  });
});
