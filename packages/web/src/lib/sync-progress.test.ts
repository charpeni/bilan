import { describe, expect, it } from 'vitest';

import { syncProgress, syncStage } from './sync-progress.ts';

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

  it('names the stage of a staged first sync instead of the total', () => {
    const running = { status: 'running', createdAt: '2026-05-01T12:00:00.000Z' };
    const stage1 = syncStage({ job: running, repo: { lastSyncedAt: null, syncStartedAt: null } });
    expect(
      syncProgress({ mode: 'incremental', prsStored: 1200, totalPrs: 9000, stage: stage1 }),
    ).toEqual({
      read: 1200,
      total: 9000,
      fraction: null,
      label: '1,200 pull requests read · stage 1 of 2 (last 7 days)',
    });
    const stage2 = syncStage({
      job: running,
      repo: { lastSyncedAt: '2026-05-01T12:05:00.000Z', syncStartedAt: running.createdAt },
    });
    expect(
      syncProgress({ mode: 'incremental', prsStored: 3000, totalPrs: null, stage: stage2 }).label,
    ).toBe('3,000 pull requests read · stage 2 of 2 (up to 30 days)');
  });

  it('keeps the single-stage labels when there is no stage', () => {
    expect(
      syncProgress({ mode: 'incremental', prsStored: 5, totalPrs: 10, stage: null }).label,
    ).toBe('5 pull requests read · the repository has 10 in total');
  });
});

describe('syncStage', () => {
  const createdAt = '2026-05-01T12:00:00.000Z';
  const running = { status: 'running', createdAt };
  const fresh = { lastSyncedAt: null, syncStartedAt: createdAt };

  it('reads a running first sync (no payload yet) as stage 1 of 2', () => {
    expect(syncStage({ job: running, repo: fresh })).toEqual({
      current: 1,
      total: 2,
      window: 'last 7 days',
      label: 'Reading the last 7 days; up to 30 days follow',
    });
  });

  it('reads a payload published since the job was queued, with the run still in flight, as stage 2', () => {
    const repo = { lastSyncedAt: '2026-05-01T12:04:00.000Z', syncStartedAt: createdAt };
    expect(syncStage({ job: running, repo })).toEqual({
      current: 2,
      total: 2,
      window: 'up to 30 days',
      label: 'Last 7 days published; reading up to 30 days',
    });
    expect(syncStage({ job: running, repo: { ...repo, lastSyncedAt: createdAt } })?.current).toBe(
      2,
    );
  });

  it('reports no stage for a later sync over an existing payload', () => {
    const earlier = { lastSyncedAt: '2026-04-30T00:00:00.000Z', syncStartedAt: createdAt };
    expect(syncStage({ job: running, repo: earlier })).toBeNull();
    // An interrupted earlier run leaves the marker set; the payload is still older than the job.
    expect(
      syncStage({ job: running, repo: { ...earlier, syncStartedAt: '2026-04-29T00:00:00.000Z' } }),
    ).toBeNull();
  });

  it('reports no stage without the in-flight marker: a settled run, retried', () => {
    expect(
      syncStage({
        job: running,
        repo: { lastSyncedAt: '2026-05-01T12:04:00.000Z', syncStartedAt: null },
      }),
    ).toBeNull();
  });

  it('reports no stage for a job that is not running, or a repo that is gone', () => {
    expect(syncStage({ job: { status: 'queued', createdAt }, repo: fresh })).toBeNull();
    expect(syncStage({ job: { status: 'complete', createdAt }, repo: fresh })).toBeNull();
    expect(syncStage({ job: { status: 'partial', createdAt }, repo: fresh })).toBeNull();
    expect(syncStage({ job: running, repo: null })).toBeNull();
    expect(syncStage({ job: running, repo: undefined })).toBeNull();
  });
});
