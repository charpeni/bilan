import { DAY, HOUR } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import { previewTiles } from './preview.ts';

import type { Headline } from '@bilan/core';

const headline: Headline = {
  opened: 1234,
  authors: 56,
  merged: 900,
  mergedShare: 0.9,
  rejected: 100,
  stillOpen: 234,
  medMerge: 12 * HOUR,
  p90Merge: 5 * DAY,
  medFirst: 45 * 60e3,
  reviewedShare: 0.8,
  medReady: null,
  draftShare: null,
  reviews: 0,
  reviewers: 0,
};

describe('previewTiles', () => {
  it('formats the precomputed headline like the dashboard tiles', () => {
    expect(previewTiles(headline)).toEqual([
      { k: 'PRs opened', v: '1,234', d: '56 authors' },
      { k: 'Merged', v: '900', d: '90% of resolved' },
      { k: 'Median time to merge', v: '12h', d: 'p90 5.0d · from ready' },
      { k: 'Median time to first review', v: '45m', d: '80% ever reviewed' },
    ]);
  });

  it('prints a dash for missing numbers', () => {
    const tiles = previewTiles({ ...headline, medMerge: null, p90Merge: null, mergedShare: null });
    expect(tiles[1]?.d).toBe('— of resolved');
    expect(tiles[2]).toEqual({ k: 'Median time to merge', v: '—', d: 'p90 — · from ready' });
  });
});
