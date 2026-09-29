import { describe, expect, it } from 'vitest';

import { LOST_AFTER_MS, reconcileJobStatus, STALL_AFTER_MS } from './job-reconcile.ts';

const createdAt = '2026-09-29T00:00:00.000Z';
const t0 = Date.parse(createdAt);

describe('reconcileJobStatus', () => {
  it('keeps a running job whose instance is live', () => {
    for (const instance of ['queued', 'running', 'paused', 'waiting'] as const) {
      expect(
        reconcileJobStatus({
          job: { status: 'running', createdAt, progressAt: null },
          instance,
          now: t0 + 60e3,
        }),
      ).toEqual({ action: 'keep' });
    }
  });

  it('marks a running job lost when the engine has no instance for it', () => {
    const r = reconcileJobStatus({
      job: { status: 'running', createdAt, progressAt: null },
      instance: 'missing',
      now: t0 + 60e3,
    });
    expect(r.action).toBe('lost');
    expect(r).toMatchObject({ error: expect.stringContaining('server restarted') });
  });

  it('marks a running job lost when the instance errored, was terminated, or completed without a verdict', () => {
    for (const instance of ['errored', 'terminated', 'complete', 'unknown'] as const) {
      expect(
        reconcileJobStatus({
          job: { status: 'queued', createdAt, progressAt: null },
          instance,
          now: t0,
        }).action,
      ).toBe('lost');
    }
  });

  it('gives up on a live instance that has run far too long', () => {
    expect(
      reconcileJobStatus({
        job: { status: 'running', createdAt, progressAt: null },
        instance: 'running',
        now: t0 + LOST_AFTER_MS + 1,
      }).action,
    ).toBe('lost');
  });

  it('never touches settled rows', () => {
    for (const status of ['complete', 'partial', 'errored']) {
      expect(
        reconcileJobStatus({
          job: { status, createdAt, progressAt: null },
          instance: 'missing',
          now: t0,
        }),
      ).toEqual({ action: 'keep' });
    }
  });
});

describe('heartbeat', () => {
  it('marks a "running" job lost once its heartbeat goes quiet', () => {
    const r = reconcileJobStatus({
      job: { status: 'running', createdAt, progressAt: '2026-09-29T00:05:00.000Z' },
      instance: 'running',
      now: Date.parse('2026-09-29T00:05:00.000Z') + STALL_AFTER_MS + 1,
    });
    expect(r.action).toBe('lost');
    expect(r).toMatchObject({ error: expect.stringContaining('no progress') });
  });

  it('keeps a running job whose heartbeat is recent', () => {
    expect(
      reconcileJobStatus({
        job: { status: 'running', createdAt, progressAt: '2026-09-29T00:05:00.000Z' },
        instance: 'running',
        now: Date.parse('2026-09-29T00:05:00.000Z') + STALL_AFTER_MS - 1,
      }),
    ).toEqual({ action: 'keep' });
  });

  it('does not hold a sleeping instance to the heartbeat', () => {
    expect(
      reconcileJobStatus({
        job: { status: 'running', createdAt, progressAt: null },
        instance: 'waiting',
        now: t0 + STALL_AFTER_MS * 5,
      }),
    ).toEqual({ action: 'keep' });
  });

  it('uses the creation time when no heartbeat was ever written', () => {
    expect(
      reconcileJobStatus({
        job: { status: 'queued', createdAt, progressAt: null },
        instance: 'queued',
        now: t0 + STALL_AFTER_MS + 1,
      }).action,
    ).toBe('lost');
  });
});
