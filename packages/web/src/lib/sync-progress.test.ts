import { describe, expect, it } from 'vitest';

import { syncProgress } from './sync-progress.ts';

describe('syncProgress', () => {
  it('gives a full-history run a ratio and a percentage', () => {
    expect(syncProgress({ mode: 'full', prsStored: 700, totalPrs: 1100 })).toEqual({
      read: 700,
      total: 1100,
      fraction: 700 / 1100,
      label: '700 of 1,100 pull requests · 64%',
    });
  });

  it('never claims more than 100%', () => {
    expect(syncProgress({ mode: 'full', prsStored: 1200, totalPrs: 1100 }).fraction).toBe(1);
  });

  it('shows what a bounded run has read against the repository total', () => {
    expect(syncProgress({ mode: 'incremental', prsStored: 700, totalPrs: 1100 })).toEqual({
      read: 700,
      total: 1100,
      fraction: null,
      label: '700 pull requests read · the repository has 1,100 in total',
    });
  });

  it('copes with an unknown total', () => {
    expect(syncProgress({ mode: 'full', prsStored: 5, totalPrs: null }).label).toBe(
      '5 pull requests read',
    );
    expect(syncProgress({ mode: 'incremental', prsStored: 5, totalPrs: 0 }).fraction).toBeNull();
  });
});
