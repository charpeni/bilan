import { dur, pct, plural } from './format.ts';

import type { Headline } from '@bilan/core';

export interface PreviewTile {
  k: string;
  v: string;
  d: string;
}

/**
 * The landing page's tiles for an example: its precomputed last-30-days
 * headline (see `scripts/build-examples.mjs`), formatted like the dashboard's.
 */
export function previewTiles(h: Headline): PreviewTile[] {
  return [
    { k: 'PRs opened', v: h.opened.toLocaleString(), d: plural(h.authors, 'author') },
    { k: 'Merged', v: h.merged.toLocaleString(), d: `${pct(h.mergedShare)} of resolved` },
    { k: 'Median time to merge', v: dur(h.medMerge), d: `p90 ${dur(h.p90Merge)} · from ready` },
    {
      k: 'Median time to first review',
      v: dur(h.medFirst),
      d: `${pct(h.reviewedShare)} ever reviewed`,
    },
  ];
}
