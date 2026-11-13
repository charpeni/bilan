import { describe, expect, it } from 'vitest';

import { standingApproval } from './verdict.ts';

import type { PayloadReview } from '../types.ts';

const none = new Set<string>();
const bots = new Set(['ci[bot]']);

describe('standingApproval', () => {
  it('is null without reviews or with comments only', () => {
    expect(standingApproval([], none)).toBeNull();
    expect(standingApproval([['bob', 'COMMENTED', 1]], none)).toBeNull();
  });

  it('is the earliest standing approval', () => {
    const rv: PayloadReview[] = [
      ['bob', 'APPROVED', 1],
      ['carol', 'APPROVED', 5],
    ];
    expect(standingApproval(rv, none)).toBe(1);
  });

  it("keeps an approval through the same reviewer's later comment", () => {
    const rv: PayloadReview[] = [
      ['bob', 'APPROVED', 1],
      ['bob', 'COMMENTED', 2],
    ];
    expect(standingApproval(rv, none)).toBe(1);
  });

  it('is null while any reviewer stands on a change request', () => {
    const rv: PayloadReview[] = [
      ['bob', 'APPROVED', 1],
      ['carol', 'CHANGES_REQUESTED', 2],
      ['bob', 'CHANGES_REQUESTED', 3],
    ];
    expect(standingApproval(rv, none)).toBeNull();
    expect(standingApproval([...rv.slice(0, 2), ['carol', 'COMMENTED', 4]], none)).toBeNull();
  });

  it("follows each reviewer's latest verdict", () => {
    const rv: PayloadReview[] = [
      ['bob', 'APPROVED', 1],
      ['carol', 'CHANGES_REQUESTED', 2],
      ['carol', 'APPROVED', 4],
    ];
    expect(standingApproval(rv, none)).toBe(1);
    const changed: PayloadReview[] = [
      ['bob', 'APPROVED', 1],
      ['bob', 'CHANGES_REQUESTED', 2],
      ['bob', 'APPROVED', 3],
    ];
    expect(standingApproval(changed, none)).toBe(3);
  });

  it('drops a verdict that was dismissed', () => {
    expect(
      standingApproval(
        [
          ['bob', 'APPROVED', 1],
          ['bob', 'DISMISSED', 2],
        ],
        none,
      ),
    ).toBeNull();
    // A stale approval dismissed by a push, then approved again.
    expect(
      standingApproval(
        [
          ['bob', 'DISMISSED', 1],
          ['bob', 'APPROVED', 3],
        ],
        none,
      ),
    ).toBe(3);
    // A dismissed change request no longer blocks.
    expect(
      standingApproval(
        [
          ['bob', 'APPROVED', 1],
          ['carol', 'DISMISSED', 2],
        ],
        none,
      ),
    ).toBe(1);
  });

  it('leaves out skipped reviewers, approving or blocking', () => {
    expect(standingApproval([['ci[bot]', 'APPROVED', 1]], bots)).toBeNull();
    const rv: PayloadReview[] = [
      ['bob', 'APPROVED', 2],
      ['ci[bot]', 'CHANGES_REQUESTED', 3],
    ];
    expect(standingApproval(rv, bots)).toBe(2);
    expect(standingApproval(rv, none)).toBeNull();
  });
});
