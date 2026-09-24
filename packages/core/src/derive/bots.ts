import type { RawPr } from '../types.ts';

const BOT_RE = /(\[bot\]$|^dependabot|^renovate|^github-actions|-bot$)/i;

/**
 * GitHub reports `__typename: "Bot"` reliably for app accounts, on both PR
 * authors and review authors, so collect the set once and let the dashboard
 * filter authors and reviewers with the same list. The regex catches bots that
 * run under regular user accounts.
 */
export function detectBots(prs: Iterable<RawPr>): Set<string> {
  const bots = new Set<string>();
  for (const pr of prs) {
    const actors = [
      { login: pr.author, type: pr.authorType },
      ...pr.reviews.map((r) => ({ login: r.author, type: r.authorType })),
    ];
    for (const who of actors) {
      if (who.login && (who.type === 'Bot' || BOT_RE.test(who.login))) bots.add(who.login);
    }
  }
  return bots;
}
