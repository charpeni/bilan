import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, T0, payloadPr } from '../testing/fixtures.ts';
import { derive, firstActivity, isMerged, isReady, lastActivity } from './derive.ts';

const one = (...args: Parameters<typeof payloadPr>) => derive([payloadPr(...args)])[0]!;

describe('derive', () => {
  it('keeps every payload field and adds the derived ones for a plain merged PR', () => {
    const p = one();
    expect(p).toMatchObject({ n: 1, a: 'alice', merged: true, open: false, size: 12 });
    expect(p.first).toBe(T0 + 2 * HOUR_MS);
    expect(p.toReady).toBeNull();
    expect(p.toFirst).toBe(2 * HOUR_MS);
    expect(p.toMerge).toBe(DAY_MS);
    expect(p.lead).toBe(DAY_MS);
    expect(p).toMatchObject({ selfMerged: false, unreviewed: false, revert: false });
    expect(isMerged(p)).toBe(true);
    expect(isReady(p)).toBe(true);
  });

  it('charges draft time to toReady and not to review latency for a draft-opened PR', () => {
    const p = one({
      d: 1,
      r: T0 + 6 * HOUR_MS,
      rv: [['bob', 'APPROVED', T0 + 8 * HOUR_MS]],
      m: T0 + DAY_MS,
    });
    expect(p.toReady).toBe(6 * HOUR_MS);
    expect(p.toFirst).toBe(2 * HOUR_MS);
    expect(p.toMerge).toBe(18 * HOUR_MS);
    expect(p.lead).toBe(DAY_MS);
  });

  it('has no draft or review latency for a draft that never became ready', () => {
    const p = one({ d: 1, r: null, dr: 1, m: null, x: null, s: 'OPEN', mb: null, rv: [] });
    expect(p.open).toBe(true);
    expect(p.merged).toBe(false);
    expect(p.toReady).toBeNull();
    expect(p.toFirst).toBeNull();
    expect(p.toMerge).toBeNull();
    expect(p.lead).toBeNull();
    expect(p.first).toBeNull();
    expect(isReady(p)).toBe(false);
  });

  it('gives a PR merged straight from draft no ready-anchored merge time', () => {
    const p = one({ r: null, d: 1 });
    expect(p.toMerge).toBeNull();
    expect(p.lead).not.toBeNull();
  });

  it('clamps a review that predates ready-for-review to zero latency', () => {
    const p = one({ r: T0 + 3 * HOUR_MS, rv: [['bob', 'COMMENTED', T0 + HOUR_MS]] });
    expect(p.toFirst).toBe(0);
  });

  it('flags a self-merged PR', () => {
    expect(one({ mb: 'alice' }).selfMerged).toBe(true);
    expect(one({ mb: null }).selfMerged).toBe(false);
    expect(one({ a: null, mb: null }).selfMerged).toBe(false);
  });

  it('flags an unreviewed merge but not an unreviewed open PR', () => {
    expect(one({ rv: [] }).unreviewed).toBe(true);
    expect(one({ rv: [], m: null, x: null, s: 'OPEN' }).unreviewed).toBe(false);
  });

  it('detects reverts by title, case-insensitively, on a word boundary', () => {
    expect(one({ t: 'Revert "Add thing"' }).revert).toBe(true);
    expect(one({ t: 'revert: add thing' }).revert).toBe(true);
    expect(one({ t: 'Reverting the thing' }).revert).toBe(false);
    expect(one({ t: 'Do not revert' }).revert).toBe(false);
  });

  it('spans the data set from the first opening to the last close or merge', () => {
    const prs = derive([
      payloadPr({ n: 1, c: T0, m: T0 + 10 * DAY_MS, x: T0 + 10 * DAY_MS }),
      payloadPr({ n: 2, c: T0 - DAY_MS, m: null, x: T0 + 3 * DAY_MS, s: 'CLOSED', mb: null }),
      payloadPr({ n: 3, c: T0 + 2 * DAY_MS, m: null, x: null, s: 'OPEN', mb: null }),
    ]);
    expect(firstActivity(prs)).toBe(T0 - DAY_MS);
    expect(lastActivity(prs)).toBe(T0 + 10 * DAY_MS);
  });
});
