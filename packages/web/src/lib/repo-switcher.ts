import { parseRepoInput } from './repo-input.ts';

import type { RepoRef } from '@bilan/core';

/**
 * How many of the viewer's most recently opened repositories the header
 * switcher lists. Each one is access-checked when the menu opens, so this
 * also bounds what opening it costs.
 */
export const SWITCHER_LIMIT = 10;

/** One entry of `GET /api/repositories`. */
export interface SwitcherRepo {
  owner: string;
  name: string;
  isPrivate: boolean;
  lastViewedAt: string;
}

/** The dashboard path for a repository. */
export function repoHref(ref: RepoRef): string {
  return `/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
}

/** `owner/name`, lower-cased: what the switcher matches against. */
export function repoKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`.toLowerCase();
}

/**
 * What the switcher's field filters on: a pasted GitHub URL (or `owner/name`)
 * is read as the repository it names, so pasting a listed repository's URL
 * narrows the list to it; anything else is matched as typed.
 */
function query(input: string): string {
  const ref = parseRepoInput(input);
  return ref ? repoKey(ref) : input.trim().toLowerCase();
}

/** The repositories whose `owner/name` contains what was typed, case-insensitively, in order. */
export function switcherMatches<T extends RepoRef>(input: string, repos: readonly T[]): T[] {
  const q = query(input);
  if (q === '') return [...repos];
  return repos.filter((repo) => repoKey(repo).includes(q));
}

/**
 * Where Enter in the switcher's field goes: the listed repository it names
 * exactly; else, while some listed repository matches, the first of them
 * other than `current` (the page's own, by `repoKey`), which the switcher is
 * for leaving; else the repository it names when it reads as one
 * (`owner/name` or a GitHub URL), listed or not. Null when it is none of those.
 */
export function switcherTarget(
  input: string,
  repos: readonly RepoRef[],
  current = '',
): RepoRef | null {
  const q = query(input);
  if (q === '') return null;
  const matches = switcherMatches(input, repos);
  const exact = matches.find((repo) => repoKey(repo) === q);
  const elsewhere = matches.find((repo) => repoKey(repo) !== current);
  return exact ?? elsewhere ?? matches[0] ?? parseRepoInput(input);
}
