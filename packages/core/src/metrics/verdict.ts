import type { PayloadReview } from '../types.ts';

/**
 * When the PR's standing human verdicts approve it: the time of the earliest
 * standing approval, or null when it is not approved.
 *
 * Each reviewer outside `skip` stands on their latest verdict: `APPROVED` or
 * `CHANGES_REQUESTED`, as on GitHub, where a later comment does not cancel a
 * verdict. A `DISMISSED` review has lost its verdict, so it stands for nothing
 * and a dismissed approval no longer counts. The PR is approved when at least
 * one reviewer stands on an approval and none on a change request.
 *
 * `rv` is sorted by time, as in the payload: either every review (`rv`), or
 * each reviewer's latest verdict as GitHub reports it (`sv`). The second is
 * the one to prefer, since `rv` stops at the first 100 reviews and a verdict
 * given after them is not in it.
 */
export function standingApproval(
  rv: readonly PayloadReview[],
  skip: ReadonlySet<string>,
): number | null {
  const standing = new Map<string, PayloadReview>();
  for (const r of rv) {
    const [who, st] = r;
    if (skip.has(who)) continue;
    if (st === 'APPROVED' || st === 'CHANGES_REQUESTED') standing.set(who, r);
    else if (st === 'DISMISSED') standing.delete(who);
  }
  let since: number | null = null;
  for (const [, st, at] of standing.values()) {
    if (st === 'CHANGES_REQUESTED') return null;
    if (since === null || at < since) since = at;
  }
  return since;
}
