import { allAreas, areasOf, inferAreaRules } from './areas.ts';
import { detectBots } from './bots.ts';
import { readyInfo } from './ready.ts';

import type { Payload, PayloadPr, PayloadReview, RawPr, RepoMeta } from '../types.ts';
import type { AreaRules } from './areas.ts';

export interface BuildPayloadOptions {
  /** Defaults to every top-level directory seen in the file samples. */
  areas?: AreaRules;
}

const ts = (s: string | null): number | null => (s ? Date.parse(s) : null);

/** Slim the raw PRs into what the dashboard needs, sorted by creation time. */
export function buildPayload(
  meta: RepoMeta,
  rawPrs: readonly RawPr[],
  options: BuildPayloadOptions = {},
): Payload {
  const rules = options.areas ?? inferAreaRules(rawPrs.map((pr) => pr.fileSample));
  const bots = detectBots(rawPrs);

  const prs: PayloadPr[] = rawPrs
    .map((pr): PayloadPr => {
      const { readyAt, openedAsDraft } = readyInfo(pr);
      const reviews: PayloadReview[] = pr.reviews
        .filter(
          (r): r is typeof r & { author: string; at: string } =>
            r.author !== null && r.at !== null && r.author !== pr.author,
        )
        .map((r): PayloadReview => [r.author, r.state, Date.parse(r.at)])
        .toSorted((a, b) => a[2] - b[2]);
      return {
        n: pr.number,
        t: pr.title,
        a: pr.author,
        bot: pr.author !== null && bots.has(pr.author) ? 1 : 0,
        c: Date.parse(pr.createdAt),
        r: readyAt,
        d: openedAsDraft ? 1 : 0,
        m: ts(pr.mergedAt),
        x: ts(pr.closedAt),
        s: pr.state,
        dr: pr.isDraft ? 1 : 0,
        mb: pr.mergedBy,
        ad: pr.additions,
        de: pr.deletions,
        cf: pr.changedFiles,
        ar: areasOf(pr.fileSample, rules),
        cm: pr.comments,
        th: pr.reviewThreads,
        rc: pr.reviewCount,
        rv: reviews,
        rq: pr.reviewRequests
          .filter((q): q is typeof q & { to: string } => q.to !== null)
          .map((q) => [q.to, Date.parse(q.at)]),
      };
    })
    .toSorted((a, b) => a.c - b.c);

  return {
    repo: meta.repo,
    syncedAt: meta.syncedAt,
    interrupted: meta.interrupted,
    reconciledAt: meta.reconciledAt,
    coverageSince: meta.coverageSince,
    openPrsSyncedAt: meta.openPrsSyncedAt,
    areas: allAreas(rules),
    bots: [...bots].toSorted(),
    prs,
  };
}

/**
 * Serialise a payload for embedding inside a `<script type="application/json">`.
 * Escapes the two things that can break out of the element or the JS parser.
 */
export function serializePayload(payload: Payload): string {
  return JSON.stringify(payload)
    .replaceAll('<', '\\u003c')
    .replaceAll(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}
