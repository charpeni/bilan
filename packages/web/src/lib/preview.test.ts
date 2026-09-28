import { DAY } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import { PREVIEW_LABELS, previewTiles } from './preview.ts';

import type { Payload, PayloadPr } from '@bilan/core';

const LAST = Date.UTC(2026, 8, 11);

function pr(n: number, opened: number, over: Partial<PayloadPr> = {}): PayloadPr {
  return {
    n,
    t: `PR ${n}`,
    a: `author${n}`,
    bot: 0,
    c: opened,
    r: opened,
    d: 0,
    m: null,
    x: null,
    s: 'OPEN',
    dr: 0,
    mb: null,
    ad: 1,
    de: 1,
    cf: 1,
    ar: ['root'],
    cm: 0,
    th: 0,
    rc: 0,
    rv: [],
    rq: [],
    ...over,
  };
}

const payload: Payload = {
  repo: 'acme/widgets',
  syncedAt: '2026-09-11T00:00:00Z',
  coverageSince: null,
  openPrsSyncedAt: null,
  areas: ['root'],
  bots: [],
  prs: [
    pr(1, LAST - 200 * DAY, { m: LAST - 199 * DAY, x: LAST - 199 * DAY, s: 'MERGED' }),
    pr(2, LAST - 100 * DAY, { m: LAST - 99 * DAY, x: LAST - 99 * DAY, s: 'MERGED' }),
    pr(3, LAST - 5 * DAY, { m: LAST - 4 * DAY, x: LAST - 4 * DAY, s: 'MERGED' }),
    pr(4, LAST - 1 * DAY),
    pr(5, LAST, { m: LAST, x: LAST, s: 'MERGED' }),
  ],
};

describe('previewTiles', () => {
  it('reports the last 30 days, like the dashboard tiles', () => {
    const tiles = previewTiles(payload);
    expect(tiles.map((t) => t.k)).toEqual([...PREVIEW_LABELS]);
    expect(tiles[0]).toEqual({ k: 'PRs opened', v: '3', d: '3 authors' });
    expect(tiles[1]?.v).toBe('2');
    expect(tiles[1]?.d).toBe('100% of resolved');
    expect(tiles[2]?.v).toBe('12h');
  });
});
