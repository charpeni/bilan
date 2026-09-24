import { median, percentile, sum } from './stats.ts';

import type { MergedPr } from './derive.ts';
import type { ReviewRow, Windowed } from './scope.ts';

/** Per-person aggregation (authoring + reviewing in one record). */
export interface PersonRec {
  login: string | null;
  opened: number;
  merged: number;
  closed: number;
  open: number;
  toReady: number[];
  toFirst: number[];
  toMerge: number[];
  sizes: number[];
  add: number;
  del: number;
  files: number;
  reviewsGiven: number;
  approvals: number;
  changesReq: number;
  commentsOnly: number;
  prsReviewed: Set<number>;
  authorsReviewed: Set<string>;
  /** Request (or ready) -> this reviewer's first review on each PR, ms. */
  response: number[];
  reviewersUsed: Set<string>;
  unreviewedMerges: number;
  selfMerges: number;
  areas: Set<string>;
}

/**
 * Everyone who authored or reviewed something in the window, in first-seen
 * order: authors of opened PRs first, then of merged, closed, open, readied
 * PRs, then reviewers.
 */
export function roster(w: Windowed): PersonRec[] {
  const { opened, merged, rejected, readied, reviews, winReviews, stillOpen } = w;
  const people = new Map<string | null, PersonRec>();
  const person = (login: string | null): PersonRec => {
    let rec = people.get(login);
    if (!rec) {
      rec = {
        login,
        opened: 0,
        merged: 0,
        closed: 0,
        open: 0,
        toReady: [],
        toFirst: [],
        toMerge: [],
        sizes: [],
        add: 0,
        del: 0,
        files: 0,
        reviewsGiven: 0,
        approvals: 0,
        changesReq: 0,
        commentsOnly: 0,
        prsReviewed: new Set(),
        authorsReviewed: new Set(),
        response: [],
        reviewersUsed: new Set(),
        unreviewedMerges: 0,
        selfMerges: 0,
        areas: new Set(),
      };
      people.set(login, rec);
    }
    return rec;
  };

  for (const p of opened) {
    const r = person(p.a);
    r.opened++;
    r.sizes.push(p.size);
    r.add += p.ad;
    r.del += p.de;
    r.files += p.cf;
    if (p.toReady !== null) r.toReady.push(p.toReady);
    for (const a of p.ar) r.areas.add(a);
    for (const [who] of p.rv) r.reviewersUsed.add(who);
  }
  for (const p of merged) {
    const r = person(p.a);
    r.merged++;
    if (p.toMerge !== null) r.toMerge.push(p.toMerge);
    if (p.unreviewed) r.unreviewedMerges++;
    if (p.selfMerged) r.selfMerges++;
  }
  for (const p of rejected) person(p.a).closed++;
  for (const p of stillOpen) person(p.a).open++;
  for (const p of readied) if (p.toFirst !== null) person(p.a).toFirst.push(p.toFirst);

  // First review per (reviewer, PR) drives turnaround; later passes are
  // follow-ups. "First" is decided over every captured review, then windowed:
  // a follow-up that happens to fall inside the window is not a response.
  const firstReviews = firstReviewPerPair(reviews);
  for (const r of winReviews) {
    const rec = person(r.who);
    rec.reviewsGiven++;
    rec.prsReviewed.add(r.pr.n);
    if (r.pr.a) rec.authorsReviewed.add(r.pr.a);
    if (r.st === 'APPROVED') rec.approvals++;
    else if (r.st === 'CHANGES_REQUESTED') rec.changesReq++;
    else rec.commentsOnly++;
    if (firstReviews.has(r)) {
      const req = r.pr.rq.filter(([to, at]) => to === r.who && at <= r.at).map(([, at]) => at);
      const from0 = Math.max(r.pr.r ?? r.pr.c, req.length ? Math.max(...req) : 0);
      rec.response.push(Math.max(0, r.at - from0));
    }
  }

  return [...people.values()].filter(
    (r) => r.opened || r.merged || r.closed || r.reviewsGiven || r.open,
  );
}

/** The earliest review each reviewer left on each PR, as the row objects themselves. */
function firstReviewPerPair(reviews: readonly ReviewRow[]): Set<ReviewRow> {
  const first = new Map<string, ReviewRow>();
  for (const r of reviews) {
    const key = `${r.who}#${r.pr.n}`;
    const seen = first.get(key);
    if (seen === undefined || r.at < seen.at) first.set(key, r);
  }
  return new Set(first.values());
}

/** One contributor-table row: authoring and reviewing side by side. */
export interface ContributorRow {
  login: string | null;
  opened: number;
  merged: number;
  closed: number;
  open: number;
  /** Merged over merged + closed; null when nothing was resolved. */
  mergeRate: number | null;
  /** Median draft -> ready, ms. */
  medDraft: number | null;
  medFirst: number | null;
  medMerge: number | null;
  p90Merge: number | null;
  /** Median lines added + deleted. */
  medSize: number | null;
  add: number;
  del: number;
  areas: number;
  reviewsGiven: number;
  /** Reviews given per PR opened; null when nothing was opened. */
  reviewRatio: number | null;
}

export const contributorRows = (people: readonly PersonRec[]): ContributorRow[] =>
  people.map((r) => ({
    login: r.login,
    opened: r.opened,
    merged: r.merged,
    closed: r.closed,
    open: r.open,
    mergeRate: r.merged + r.closed ? r.merged / (r.merged + r.closed) : null,
    medDraft: median(r.toReady),
    medFirst: median(r.toFirst),
    medMerge: median(r.toMerge),
    p90Merge: percentile(r.toMerge, 0.9),
    medSize: median(r.sizes),
    add: r.add,
    del: r.del,
    areas: r.areas.size,
    reviewsGiven: r.reviewsGiven,
    reviewRatio: r.opened ? r.reviewsGiven / r.opened : null,
  }));

/** One reviewer-table row: volume, verdict mix, and turnaround. */
export interface ReviewerRow {
  login: string | null;
  reviews: number;
  prsReviewed: number;
  /** Share of every review given in the window. */
  share: number;
  approvals: number;
  changesReq: number;
  commentsOnly: number;
  /** Share of this reviewer's reviews that requested changes. */
  pushback: number | null;
  medTurnaround: number | null;
  p90Turnaround: number | null;
  authorsHelped: number;
}

/** Everyone who reviewed, in roster order; `total` is the review count of the window. */
export const reviewerRows = (people: readonly PersonRec[], total: number): ReviewerRow[] =>
  people
    .filter((r) => r.reviewsGiven)
    .map((r) => ({
      login: r.login,
      reviews: r.reviewsGiven,
      prsReviewed: r.prsReviewed.size,
      share: total ? r.reviewsGiven / total : 0,
      approvals: r.approvals,
      changesReq: r.changesReq,
      commentsOnly: r.commentsOnly,
      pushback: r.reviewsGiven ? r.changesReq / r.reviewsGiven : null,
      medTurnaround: median(r.response),
      p90Turnaround: percentile(r.response, 0.9),
      authorsHelped: r.authorsReviewed.size,
    }));

export interface TopReviewer {
  login: string | null;
  reviews: number;
  prsReviewed: number;
  medTurnaround: number | null;
}

/** The busiest reviewers, most reviews first. */
export const topReviewers = (people: readonly PersonRec[], limit = 12): TopReviewer[] =>
  people
    .filter((r) => r.reviewsGiven)
    .toSorted((a, b) => b.reviewsGiven - a.reviewsGiven)
    .slice(0, limit)
    .map((r) => ({
      login: r.login,
      reviews: r.reviewsGiven,
      prsReviewed: r.prsReviewed.size,
      medTurnaround: median(r.response),
    }));

export interface ReviewPair {
  reviewer: string;
  author: string;
  reviews: number;
}

/** Reviewer -> author pairs with the most reviews between them. */
export function reviewPairs(reviews: readonly ReviewRow[], limit = 12): ReviewPair[] {
  const pairs = new Map<string, ReviewPair>();
  for (const r of reviews) {
    if (!r.pr.a) continue;
    const k = `${r.who}\n${r.pr.a}`;
    const pair = pairs.get(k);
    if (pair) pair.reviews++;
    else pairs.set(k, { reviewer: r.who, author: r.pr.a, reviews: 1 });
  }
  return [...pairs.values()].toSorted((a, b) => b.reviews - a.reviews).slice(0, limit);
}

export interface BusFactorRow {
  area: string;
  /** People needed to account for half the merged PRs; 1 means one person carries it. */
  bus: number;
  total: number;
  contributors: number;
  /** Author with the most merged PRs; null when that author is unknown. */
  top: string | null;
  topShare: number;
}

/** Bus factor per area, lowest first; areas with fewer than `minTotal` merged PRs are omitted. */
export function busFactor(merged: readonly MergedPr[], minTotal = 5): BusFactorRow[] {
  const byArea = new Map<string, Map<string | null, number>>();
  for (const p of merged) {
    for (const a of p.ar) {
      let m = byArea.get(a);
      if (!m) {
        m = new Map();
        byArea.set(a, m);
      }
      m.set(p.a, (m.get(p.a) ?? 0) + 1);
    }
  }
  return [...byArea]
    .map(([area, m]) => {
      const counts = [...m.values()].toSorted((a, b) => b - a);
      const total = sum(counts);
      let acc = 0;
      let bus = 0;
      for (const v of counts) {
        acc += v;
        bus++;
        if (acc >= total / 2) break;
      }
      const top = [...m].toSorted((a, b) => b[1] - a[1])[0];
      return {
        area,
        bus,
        total,
        contributors: m.size,
        top: top ? top[0] : null,
        topShare: top ? top[1] / total : 0,
      };
    })
    .filter((r) => r.total >= minTotal)
    .toSorted((a, b) => a.bus - b.bus);
}
