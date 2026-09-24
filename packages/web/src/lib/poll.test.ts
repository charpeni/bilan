import { describe, expect, it } from 'vitest';

import {
  jobPollOutcome,
  nextWatch,
  payloadPollOutcome,
  readPayloadProbe,
  SYNC_ACTIVE_HEADER,
  SYNCED_AT_HEADER,
  watchAfterSyncResponse,
} from './poll.ts';

const T1 = '2026-05-01T12:00:00.000Z';
const T2 = '2026-05-01T12:05:00.000Z';

describe('watchAfterSyncResponse', () => {
  it('watches the job this viewer just started', () => {
    expect(watchAfterSyncResponse(202, { jobId: 'j1' }, T1)).toEqual({ kind: 'job', jobId: 'j1' });
  });

  it("watches the payload, never another user's job id, when a sync is already running", () => {
    expect(watchAfterSyncResponse(409, { jobId: 'someone-elses' }, T1)).toEqual({
      kind: 'payload',
      baseline: T1,
    });
    expect(watchAfterSyncResponse(409, {}, null)).toEqual({ kind: 'payload', baseline: null });
  });

  it('is null when the sync was refused', () => {
    expect(watchAfterSyncResponse(429, {}, T1)).toBeNull();
    expect(watchAfterSyncResponse(401, {}, T1)).toBeNull();
    expect(watchAfterSyncResponse(202, {}, T1)).toBeNull();
  });
});

describe('readPayloadProbe', () => {
  it('reads the two headers', () => {
    const headers = new Headers({ [SYNCED_AT_HEADER]: T1, [SYNC_ACTIVE_HEADER]: '1' });
    expect(readPayloadProbe(200, headers)).toEqual({ status: 200, syncedAt: T1, syncActive: true });
    expect(readPayloadProbe(404, new Headers({ [SYNC_ACTIVE_HEADER]: '0' }))).toEqual({
      status: 404,
      syncedAt: null,
      syncActive: false,
    });
    expect(readPayloadProbe(202, new Headers())).toEqual({
      status: 202,
      syncedAt: null,
      syncActive: false,
    });
  });
});

describe('payloadPollOutcome', () => {
  it('is ready once a payload other than the baseline is on offer', () => {
    expect(payloadPollOutcome({ status: 200, syncedAt: T2, syncActive: false }, T1)).toEqual({
      kind: 'ready',
    });
    // Still marked active: the job row lags the payload; the payload is what counts.
    expect(payloadPollOutcome({ status: 200, syncedAt: T2, syncActive: true }, T1)).toEqual({
      kind: 'ready',
    });
  });

  it('is ready on the first 200 after a 202', () => {
    expect(payloadPollOutcome({ status: 200, syncedAt: T1, syncActive: false }, null)).toEqual({
      kind: 'ready',
    });
  });

  it('waits while the same payload is on offer and a job is active', () => {
    expect(payloadPollOutcome({ status: 200, syncedAt: T1, syncActive: true }, T1)).toEqual({
      kind: 'wait',
    });
    expect(payloadPollOutcome({ status: 202, syncedAt: null, syncActive: true }, null)).toEqual({
      kind: 'wait',
    });
    expect(payloadPollOutcome({ status: 404, syncedAt: null, syncActive: true }, null)).toEqual({
      kind: 'wait',
    });
  });

  it('stops when nothing is running and nothing new was published', () => {
    expect(payloadPollOutcome({ status: 200, syncedAt: T1, syncActive: false }, T1)).toEqual({
      kind: 'stopped',
    });
    expect(payloadPollOutcome({ status: 404, syncedAt: null, syncActive: false }, null)).toEqual({
      kind: 'stopped',
    });
  });

  it('fails on any other status', () => {
    for (const status of [401, 403, 500, 503]) {
      expect(payloadPollOutcome({ status, syncedAt: null, syncActive: false }, T1)).toEqual({
        kind: 'failed',
        message: `Could not read sync status (${status}).`,
      });
    }
  });
});

describe('jobPollOutcome', () => {
  it('is ready once the job settled, whether complete or partial', () => {
    expect(jobPollOutcome(200, { status: 'complete', settled: true })).toEqual({ kind: 'ready' });
    expect(jobPollOutcome(200, { status: 'partial', settled: true })).toEqual({ kind: 'ready' });
  });

  it('waits while queued or running', () => {
    expect(jobPollOutcome(200, { status: 'queued', settled: false })).toEqual({ kind: 'wait' });
    expect(jobPollOutcome(200, { status: 'running', settled: false })).toEqual({ kind: 'wait' });
  });

  it('fails with the job error', () => {
    expect(jobPollOutcome(200, { status: 'errored', settled: false, error: 'boom' })).toEqual({
      kind: 'failed',
      message: 'Sync failed: boom',
    });
    expect(jobPollOutcome(200, { status: 'errored', settled: false, error: null })).toEqual({
      kind: 'failed',
      message: 'Sync failed: unknown error',
    });
  });

  it('falls back to the payload when the job is not readable by this viewer', () => {
    expect(jobPollOutcome(404, null)).toEqual({ kind: 'watch-payload' });
  });

  it('fails on any other status', () => {
    expect(jobPollOutcome(401, null)).toEqual({
      kind: 'failed',
      message: 'Could not read job status (401).',
    });
    expect(jobPollOutcome(500, null)).toEqual({
      kind: 'failed',
      message: 'Could not read job status (500).',
    });
  });
});

describe('nextWatch', () => {
  const job = { kind: 'job', jobId: 'j1' } as const;

  it('keeps watching on wait', () => {
    expect(nextWatch(job, { kind: 'wait' }, T1)).toBe(job);
  });

  it('switches an unreadable job to the payload, keeping the baseline', () => {
    expect(nextWatch(job, { kind: 'watch-payload' }, T1)).toEqual({
      kind: 'payload',
      baseline: T1,
    });
  });

  it('ends the wait on every other outcome', () => {
    expect(nextWatch(job, { kind: 'ready' }, T1)).toBeNull();
    expect(nextWatch(job, { kind: 'stopped' }, T1)).toBeNull();
    expect(nextWatch(job, { kind: 'failed', message: 'x' }, T1)).toBeNull();
  });
});
