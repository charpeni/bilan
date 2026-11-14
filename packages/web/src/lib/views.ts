import type { AccessDecision } from './access.ts';

/**
 * The entries of a viewer's repo list that `check` still allows, in the order
 * given. Every entry goes through the check, public ones included: a public row
 * is re-validated against GitHub (cached for 15 minutes, see
 * `checkRepoAccess`), so a repo that went private, was replaced, or that the
 * viewer lost drops off the list the same way it does off its page.
 */
export async function filterVisibleViews<T>(
  entries: readonly T[],
  check: (entry: T) => Promise<AccessDecision>,
): Promise<T[]> {
  const decisions = await Promise.all(entries.map((entry) => check(entry)));
  return entries.filter((_, index) => decisions[index]?.kind === 'ok');
}

/**
 * How many repositories `/repositories` lists: the most recently opened ones.
 * Every row costs an access check (GitHub, once its 15-minute cache is cold)
 * and a few queries, so the page is bounded however many a viewer has opened.
 */
export const REPOSITORIES_LIMIT = 50;

/**
 * The part of a list to show, and whether it goes on: `rows` are fetched one
 * past `limit`, so the extra row only says there are more.
 */
export function capViews<T>(
  rows: readonly T[],
  limit: number = REPOSITORIES_LIMIT,
): { shown: T[]; more: boolean } {
  return { shown: rows.slice(0, limit), more: rows.length > limit };
}
