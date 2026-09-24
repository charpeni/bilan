import { isMerged, isReady } from './derive.ts';
import { count, median, ranked, share } from './stats.ts';
import { DAY } from './time.ts';

import type { ClosedPr, MergedPr, MetricPr, ReadyPr } from './derive.ts';
import type { InWindow, ReviewRow } from './scope.ts';

const nonNull = (v: number | null): v is number => v !== null;

/**
 * Relative change of `now` against `before`, as a rounded percentage.
 * `null` means there is nothing to compare against ("new"); 0 means flat.
 */
export function change(now: number, before: number): number | null {
  if (!before) return now ? null : 0;
  return Math.round((now / before - 1) * 100);
}

/** `(t) => LAST - lo days < t <= LAST - hi days`. */
export const between =
  (last: number, lo: number, hi: number): InWindow =>
  (t): t is number =>
    t !== null && t !== undefined && t > last - lo * DAY && t <= last - hi * DAY;

export interface BriefSizeBand {
  /** Median ready -> first review, ms. */
  first: number | null;
  /** Median ready -> merge, ms. */
  merge: number | null;
}

/** Everything the brief reads out for one window. */
export interface BriefStats {
  opened: MetricPr[];
  merged: MergedPr[];
  closed: ClosedPr[];
  readied: ReadyPr[];
  reviews: ReviewRow[];
  authors: number;
  medSize: number | null;
  /** Share of opened PRs over 1,000 lines. */
  xl: number;
  /** PRs of at most 100 lines. */
  small: BriefSizeBand;
  /** PRs over 1,000 lines. */
  large: BriefSizeBand;
  medFirst: number | null;
  /** Share of readied PRs reviewed within a day. */
  within1d: number;
  medMerge: number | null;
  /** Share of merges that took over a week. */
  overWeek: number;
  /** Reviews given per reviewer. */
  reviewers: Map<string, number>;
  /** PRs opened per author. */
  authored: Map<string, number>;
  changesReq: number;
  commentOnly: number;
  /** Share of merged PRs carrying an approval. */
  approvedMerges: number;
  /** Merged PRs per area. */
  areas: Map<string, number>;
}

/** Window stats over `prs` (already excluding bots as authors); bot reviews are dropped here. */
export function briefStats(
  prs: readonly MetricPr[],
  bots: ReadonlySet<string>,
  inW: InWindow,
): BriefStats {
  const opened = prs.filter((p) => inW(p.c));
  const merged = prs.filter((p): p is MergedPr => isMerged(p) && inW(p.m));
  const closed = prs.filter((p): p is ClosedPr => !p.merged && p.x !== null && inW(p.x));
  const readied = prs.filter((p): p is ReadyPr => isReady(p) && inW(p.r));
  const firsts = readied.map((p) => p.toFirst).filter(nonNull);
  const reviews: ReviewRow[] = prs.flatMap((p) =>
    p.rv
      .filter(([who, , at]) => !bots.has(who) && inW(at))
      .map(([who, st, at]) => ({ who, st, at, pr: p })),
  );
  const bySize = (lo: number, hi: number): BriefSizeBand => ({
    first: median(
      readied
        .filter((p) => p.size > lo && p.size <= hi)
        .map((p) => p.toFirst)
        .filter(nonNull),
    ),
    merge: median(merged.filter((p) => p.size > lo && p.size <= hi).map((p) => p.toMerge)),
  });
  return {
    opened,
    merged,
    closed,
    readied,
    reviews,
    authors: new Set(opened.map((p) => p.a)).size,
    medSize: median(opened.map((p) => p.size)),
    xl: share(opened.filter((p) => p.size > 1000).length, opened.length),
    small: bySize(-1, 100),
    large: bySize(1000, Infinity),
    medFirst: median(firsts),
    within1d: share(firsts.filter((v) => v < DAY).length, readied.length),
    medMerge: median(merged.map((p) => p.toMerge)),
    overWeek: share(merged.filter((p) => p.toMerge > 7 * DAY).length, merged.length),
    reviewers: count(reviews, (r) => r.who),
    authored: count(opened, (p) => p.a),
    changesReq: share(reviews.filter((r) => r.st === 'CHANGES_REQUESTED').length, reviews.length),
    commentOnly: share(reviews.filter((r) => r.st === 'COMMENTED').length, reviews.length),
    approvedMerges: share(
      merged.filter((p) => p.rv.some(([, st]) => st === 'APPROVED')).length,
      merged.length,
    ),
    areas: count(
      merged.flatMap((p) => p.ar),
      (a) => a,
    ),
  };
}

export interface BriefReviewLoad {
  /** Reviewers by reviews given, busiest first. */
  top: [string, number][];
  /** Share of all reviews given by the top 3. */
  top3Share: number;
  /** Opened a lot (15+), reviewed little (at most a fifth of that); up to 2. */
  imbalance: { who: string; opened: number; reviews: number }[];
  /** The reviewer whose volume fell the most from 20+ to under half of that. */
  drop: { who: string; now: number; before: number } | null;
}

export interface BriefAutomation {
  who: string;
  /** PRs opened in the current window. */
  opened: number;
  /** PRs opened in the previous window. */
  before: number;
  merged: number;
  mergedShare: number;
  /** Median open -> merge, ms. */
  medLead: number | null;
  medSize: number | null;
  /** "About 1 in N of all PRs opened". */
  oneIn: number;
  topMerger: { who: string; merged: number } | null;
}

export interface BriefAreaMove {
  area: string;
  now: number;
  before: number;
  /** Relative change, -1..∞. */
  d: number;
}

export interface BriefAreas {
  up: BriefAreaMove;
  down: BriefAreaMove;
  /** Median ready -> first review per moving area, slowest first. */
  firstBy: { area: string; v: number }[];
}

export interface BriefBacklog {
  open: number;
  drafts: number;
  /** Drafts older than 30 days. */
  oldDrafts: number;
  /** Who owns the most old drafts. */
  owner: { who: string; drafts: number } | null;
  /** Ready PRs with no human review after 2+ days, longest waiting first. */
  waiting: ReadyPr[];
  /** Approved, unmerged PRs sitting for 3+ days since approval, longest first. */
  approved: { pr: MetricPr; since: number }[];
}

export interface BriefChurn {
  closed: number;
  /** Unmerged closes within a day of opening. */
  quick: number;
  closer: { who: string; closed: number } | null;
  reverts: number;
  revertsBefore: number;
  /** Authors whose first ever PR landed in the current window. */
  newcomers: (string | null)[];
  /** Local weekday (0 = Sunday) with the most merges. */
  busiest: { day: number; merges: number } | null;
}

export interface Brief {
  last: number;
  cur: BriefStats;
  prev: BriefStats;
  reviewLoad: BriefReviewLoad;
  /** The busiest bot author, when it opened at least 5 PRs. */
  automation: BriefAutomation | null;
  /** Null unless two distinct areas moved. */
  areas: BriefAreas | null;
  backlog: BriefBacklog;
  churn: BriefChurn;
}

/**
 * A fixed "last 30 days vs the 30 before" read-out. It deliberately ignores
 * the filter row. Bots are excluded except in the automation item, which is
 * about them.
 */
export function brief(prs: readonly MetricPr[], bots: ReadonlySet<string>, last: number): Brief {
  const cur = between(last, 30, 0);
  const prev = between(last, 60, 30);
  const H = prs.filter((p) => !p.bot);
  const A = briefStats(H, bots, cur);
  const B = briefStats(H, bots, prev);

  const reviewLoad = ((): BriefReviewLoad => {
    const top = ranked(A.reviewers);
    const top3 = top.slice(0, 3);
    const top3Share = share(
      top3.reduce((s, [, n]) => s + n, 0),
      A.reviews.length,
    );
    const imbalance = ranked(A.authored)
      .filter(([a, n]) => n >= 15 && (A.reviewers.get(a) ?? 0) <= n * 0.2)
      .slice(0, 2)
      .map(([a, n]) => ({ who: a, opened: n, reviews: A.reviewers.get(a) ?? 0 }));
    const drop = ranked(B.reviewers)
      .filter(([w, n]) => n >= 20 && (A.reviewers.get(w) ?? 0) < n * 0.5)
      .toSorted(
        (a, b) => b[1] - (A.reviewers.get(b[0]) ?? 0) - (a[1] - (A.reviewers.get(a[0]) ?? 0)),
      )[0];
    return {
      top,
      top3Share,
      imbalance,
      drop: drop ? { who: drop[0], now: A.reviewers.get(drop[0]) ?? 0, before: drop[1] } : null,
    };
  })();

  const automation = ((): BriefAutomation | null => {
    const botOpened = prs.filter((p) => p.bot && cur(p.c));
    const top = ranked(count(botOpened, (p) => p.a))[0];
    if (!top || top[1] < 5) return null;
    const [who, n] = top;
    const before = prs.filter((p) => p.a === who && prev(p.c)).length;
    const mine = botOpened.filter((p) => p.a === who);
    const merged = mine.filter(isMerged);
    const m0 = ranked(count(merged, (p) => p.mb))[0];
    return {
      who,
      opened: n,
      before,
      merged: merged.length,
      mergedShare: share(merged.length, n),
      medLead: median(merged.map((p) => p.m - p.c)),
      medSize: median(mine.map((p) => p.size)),
      oneIn: Math.max(1, Math.round((A.opened.length + n) / n)),
      topMerger: m0 ? { who: m0[0], merged: m0[1] } : null,
    };
  })();

  const areas = ((): BriefAreas | null => {
    const moves: BriefAreaMove[] = [...new Set([...A.areas.keys(), ...B.areas.keys()])]
      .map((a) => ({ area: a, now: A.areas.get(a) ?? 0, before: B.areas.get(a) ?? 0 }))
      .filter((x) => Math.max(x.now, x.before) >= 20)
      .map((x) => ({ area: x.area, now: x.now, before: x.before, d: share(x.now, x.before) - 1 }))
      .toSorted((x, y) => y.d - x.d);
    const up = moves[0];
    const down = moves[moves.length - 1];
    if (!up || !down || up === down) return null;
    const firstBy = moves
      .map((x) => ({
        area: x.area,
        v: median(
          A.readied
            .filter((p) => p.ar.includes(x.area))
            .map((p) => p.toFirst)
            .filter(nonNull),
        ),
      }))
      .filter((x): x is { area: string; v: number } => x.v !== null)
      .toSorted((x, y) => y.v - x.v);
    return { up, down, firstBy };
  })();

  const backlog = ((): BriefBacklog => {
    const open = H.filter((p) => p.open);
    const drafts = open.filter((p) => p.dr);
    const oldDrafts = drafts.filter((p) => last - p.c > 30 * DAY);
    const owner = ranked(count(oldDrafts, (p) => p.a))[0];
    const waiting = open
      .filter(
        (p): p is ReadyPr =>
          !p.dr && isReady(p) && !p.rv.some(([w]) => !bots.has(w)) && last - p.r > 2 * DAY,
      )
      .toSorted((a, b) => a.r - b.r);
    const approved = open
      .filter((p) => !p.dr)
      .map((p) => {
        const ok = p.rv.filter(([, st]) => st === 'APPROVED').map(([, , at]) => at);
        return ok.length ? { pr: p, since: Math.max(0, last - Math.max(...ok)) } : null;
      })
      .filter((x): x is { pr: MetricPr; since: number } => x !== null && x.since > 3 * DAY)
      .toSorted((a, b) => b.since - a.since);
    return {
      open: open.length,
      drafts: drafts.length,
      oldDrafts: oldDrafts.length,
      owner: owner ? { who: owner[0], drafts: owner[1] } : null,
      waiting,
      approved,
    };
  })();

  const churn = ((): BriefChurn => {
    const closer = ranked(count(A.closed, (p) => p.a))[0];
    const firstEver = new Map<string | null, number>();
    for (const p of H) {
      const seen = firstEver.get(p.a);
      if (seen === undefined || p.c < seen) firstEver.set(p.a, p.c);
    }
    const busiest = ranked(count(A.merged, (p) => new Date(p.m).getDay()))[0];
    return {
      closed: A.closed.length,
      quick: A.closed.filter((p) => p.x - p.c < DAY).length,
      closer: closer ? { who: closer[0], closed: closer[1] } : null,
      reverts: A.opened.filter((p) => p.revert).length,
      revertsBefore: B.opened.filter((p) => p.revert).length,
      newcomers: [...firstEver].filter(([, t]) => cur(t)).map(([a]) => a),
      busiest: busiest ? { day: busiest[0], merges: busiest[1] } : null,
    };
  })();

  return { last, cur: A, prev: B, reviewLoad, automation, areas, backlog, churn };
}
