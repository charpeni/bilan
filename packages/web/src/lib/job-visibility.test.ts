import { describe, expect, it } from 'vitest';

import { isSettledJobStatus, jobVisibility } from './job-visibility.ts';

import type { VisibleJob } from './job-visibility.ts';

const EXAMPLE_ID = 'R_example';
const EXAMPLE = { id: EXAMPLE_ID, isPrivate: false };
const PRIVATE_EXAMPLE = { id: EXAMPLE_ID, isPrivate: true };
const alice = { id: 7 };
const ownJob: VisibleJob = { repoId: 'R_priv', requestedBy: 7 };
const othersJob: VisibleJob = { repoId: 'R_priv', requestedBy: 8 };
const cronJob: VisibleJob = { repoId: 'R_priv', requestedBy: null };
const exampleJob: VisibleJob = { repoId: EXAMPLE_ID, requestedBy: null };
const exampleJobByOther: VisibleJob = { repoId: EXAMPLE_ID, requestedBy: 8 };
const exampleJobByAlice: VisibleJob = { repoId: EXAMPLE_ID, requestedBy: 7 };

describe('jobVisibility', () => {
  describe('signed out', () => {
    it('answers login-required for anything that is not an example-repo job, unknown ids included', () => {
      for (const job of [undefined, ownJob, othersJob, cronJob]) {
        expect(jobVisibility({ job, user: null, exampleRepo: EXAMPLE })).toBe('login-required');
      }
    });

    it('serves the example repo job, whoever asked for it', () => {
      expect(jobVisibility({ job: exampleJob, user: null, exampleRepo: EXAMPLE })).toBe('ok');
      expect(jobVisibility({ job: exampleJobByOther, user: null, exampleRepo: EXAMPLE })).toBe(
        'ok',
      );
    });

    it('serves nothing while bilan has no row for the example repo', () => {
      expect(jobVisibility({ job: exampleJob, user: null, exampleRepo: null })).toBe(
        'login-required',
      );
    });

    it('does not serve the example repo job once the repo is private', () => {
      for (const job of [exampleJob, exampleJobByOther]) {
        expect(jobVisibility({ job, user: null, exampleRepo: PRIVATE_EXAMPLE })).toBe(
          'login-required',
        );
      }
    });
  });

  describe('signed in', () => {
    it('answers unknown for an unknown id', () => {
      expect(jobVisibility({ job: undefined, user: alice, exampleRepo: EXAMPLE })).toBe('unknown');
    });

    it('serves the viewer their own job', () => {
      expect(jobVisibility({ job: ownJob, user: alice, exampleRepo: EXAMPLE })).toBe('ok');
    });

    it("hides another user's job, and the cron's, exactly like an unknown id", () => {
      const unknown = jobVisibility({ job: undefined, user: alice, exampleRepo: EXAMPLE });
      expect(jobVisibility({ job: othersJob, user: alice, exampleRepo: EXAMPLE })).toBe(unknown);
      expect(jobVisibility({ job: cronJob, user: alice, exampleRepo: EXAMPLE })).toBe(unknown);
    });

    it('serves the example repo job to anyone', () => {
      expect(jobVisibility({ job: exampleJob, user: alice, exampleRepo: EXAMPLE })).toBe('ok');
      expect(jobVisibility({ job: exampleJobByOther, user: alice, exampleRepo: EXAMPLE })).toBe(
        'ok',
      );
    });

    it("treats a private example repo's jobs as owner-only, like any private repo", () => {
      const unknown = jobVisibility({ job: undefined, user: alice, exampleRepo: PRIVATE_EXAMPLE });
      expect(jobVisibility({ job: exampleJob, user: alice, exampleRepo: PRIVATE_EXAMPLE })).toBe(
        unknown,
      );
      expect(
        jobVisibility({ job: exampleJobByOther, user: alice, exampleRepo: PRIVATE_EXAMPLE }),
      ).toBe(unknown);
      expect(
        jobVisibility({ job: exampleJobByAlice, user: alice, exampleRepo: PRIVATE_EXAMPLE }),
      ).toBe('ok');
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
