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
