import { describe, expect, it } from 'vitest';

import { isSettledJobStatus, jobVisibility } from './job-visibility.ts';

import type { VisibleJob } from './job-visibility.ts';

const alice = { id: 7 };
const ownJob: VisibleJob = { requestedBy: 7 };
const othersJob: VisibleJob = { requestedBy: 8 };
const cronJob: VisibleJob = { requestedBy: null };

describe('jobVisibility', () => {
  describe('signed out', () => {
    it('answers login-required for every job, unknown ids included', () => {
      for (const job of [undefined, ownJob, othersJob, cronJob]) {
        expect(jobVisibility({ job, user: null })).toBe('login-required');
      }
    });
  });

  describe('signed in', () => {
    it('answers unknown for an unknown id', () => {
      expect(jobVisibility({ job: undefined, user: alice })).toBe('unknown');
    });

    it('serves the viewer their own job', () => {
      expect(jobVisibility({ job: ownJob, user: alice })).toBe('ok');
    });

    it("hides another user's job, and the cron's, exactly like an unknown id", () => {
      const unknown = jobVisibility({ job: undefined, user: alice });
      expect(jobVisibility({ job: othersJob, user: alice })).toBe(unknown);
      expect(jobVisibility({ job: cronJob, user: alice })).toBe(unknown);
    });
  });
});

describe('isSettledJobStatus', () => {
  it('treats partial like complete: both published a payload', () => {
    expect(isSettledJobStatus('complete')).toBe(true);
    expect(isSettledJobStatus('partial')).toBe(true);
    for (const status of ['queued', 'running', 'errored']) {
      expect(isSettledJobStatus(status)).toBe(false);
    }
  });
});
