import type { RawPr } from '../types.ts';

export interface ReadyInfo {
  /** Epoch ms when the PR first became reviewable, or null if it never was. */
  readyAt: number | null;
  openedAsDraft: boolean;
}

/**
 * When did this PR first become reviewable?
 *
 * A PR that opened as a draft has a ReadyForReviewEvent as its earliest
 * draft-state event; one that opened ready either has no such events or starts
 * with a ConvertToDraftEvent. Anything after the first transition is a re-draft
 * and is deliberately ignored: we want first exposure to reviewers.
 *
 * A PR that is still a draft (or was closed as one) and has no draft-state
 * events at all was never reviewable, so it has no ready time. `readyAt: null`
 * keeps it out of every review-latency denominator. A current draft whose
 * earliest event is a ConvertToDraftEvent did open ready, though, and was
 * reviewable from creation until that conversion.
 */
export function readyInfo(
  pr: Pick<RawPr, 'readyAt' | 'draftedAt' | 'createdAt' | 'isDraft'>,
): ReadyInfo {
  const events = [
    ...pr.readyAt.map((t) => ({ t: Date.parse(t), ready: true })),
    ...pr.draftedAt.map((t) => ({ t: Date.parse(t), ready: false })),
  ].toSorted((a, b) => a.t - b.t);
  const first = events[0];
  if (first?.ready) return { readyAt: first.t, openedAsDraft: true };
  if (pr.isDraft && first === undefined) return { readyAt: null, openedAsDraft: true };
  return { readyAt: Date.parse(pr.createdAt), openedAsDraft: false };
}
