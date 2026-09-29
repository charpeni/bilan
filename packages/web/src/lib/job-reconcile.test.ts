import { describe, expect, it } from 'vitest';

import { LOST_AFTER_MS, reconcileJobStatus } from './job-reconcile.ts';

const createdAt = '2026-09-29T00:00:00.000Z';
const t0 = Date.parse(createdAt);

describe('reconcileJobStatus', () => {
  it('keeps a running job whose instance is live', () => {
    for (const instance of ['queued', 'running', 'paused', 'waiting'] as const) {
      expect(
        reconcileJobStatus({ job: { status: 'running', createdAt }, instance, now: t0 + 60e3 }),
      ).toEqual({ action: 'keep' });
    }
  });

  it('marks a running job lost when the engine has no instance for it', () => {
    const r = reconcileJobStatus({
      job: { status: 'running', createdAt },
      instance: 'missing',
      now: t0 + 60e3,
    });
    expect(r.action).toBe('lost');
    expect(r).toMatchObject({ error: expect.stringContaining('server restarted') });
  });

  it('marks a running job lost when the instance errored, was terminated, or completed without a verdict', () => {
    for (const instance of ['errored', 'terminated', 'complete', 'unknown'] as const) {
      expect(
        reconcileJobStatus({ job: { status: 'queued', createdAt }, instance, now: t0 }).action,
      ).toBe('lost');
    }
  });

  it('gives up on a live instance that has run far too long', () => {
    expect(
      reconcileJobStatus({
        job: { status: 'running', createdAt },
        instance: 'running',
        now: t0 + LOST_AFTER_MS + 1,
      }).action,
    ).toBe('lost');
  });

  it('never touches settled rows', () => {
    for (const status of ['complete', 'partial', 'errored']) {
      expect(
        reconcileJobStatus({ job: { status, createdAt }, instance: 'missing', now: t0 }),
      ).toEqual({ action: 'keep' });
    }
  });
});
