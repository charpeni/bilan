import { GithubError, RepoChangedError, RepoNotFoundError } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import { failureReason } from './sync-failure.ts';
import { syncErrorText } from './sync-status.ts';

const repo = { owner: 'Acme-Corp', name: 'secret.plans' };

/** The reason goes to the sync model, which keeps it forever: no part of the name may survive. */
function expectNameFree(reason: string): void {
  expect(reason.toLowerCase()).not.toContain('acme-corp/secret.plans');
  expect(reason.toLowerCase()).not.toContain('secret.plans');
}

describe('failureReason', () => {
  it('says a repository went missing without naming it', () => {
    const reason = failureReason(new RepoNotFoundError(repo), repo);
    expectNameFree(reason);
    expect(syncErrorText(reason)).toBe(
      'The sync stopped: The repository was not found or is no longer accessible.',
    );
  });

  it('says a repository changed without naming it', () => {
    const reason = failureReason(new RepoChangedError(repo), repo);
    expectNameFree(reason);
    expect(syncErrorText(reason)).toBe(
      'The sync stopped: The repository was renamed, transferred, or replaced; start a new sync.',
    );
  });

  it('scrubs the name from any other message, in any letter case', () => {
    const error = new GithubError(
      "Could not resolve to a Repository with the name 'acme-corp/SECRET.PLANS'. See https://github.com/Acme-Corp/secret.plans",
      null,
      false,
    );
    const reason = failureReason(error, repo);
    expectNameFree(reason);
    expect(reason).toBe(
      "Could not resolve to a Repository with the name 'the repository'. See https://github.com/the repository",
    );
  });

  it('reads the name literally, not as a pattern', () => {
    // `.` must not match any character: a lookalike is left alone.
    expect(failureReason(new Error('acme-corp/secretXplans'), repo)).toBe('acme-corp/secretXplans');
  });

  it('keeps messages that never named the repository, thrown values included', () => {
    expect(failureReason(new Error('GitHub is unavailable: 502'), repo)).toBe(
      'GitHub is unavailable: 502',
    );
    expect(failureReason('Sign in again: refresh token expired', repo)).toBe(
      'Sign in again: refresh token expired',
    );
  });
});
