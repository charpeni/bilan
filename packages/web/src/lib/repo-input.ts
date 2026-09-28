import type { RepoRef } from '@bilan/core';

/** What `/me` says when the "open a repository" field cannot be read as a repository. */
export const REPO_INPUT_HINT = 'Enter a repository as owner/name, or paste its GitHub URL.';

/** GitHub's owner alphabet: no dots, so another host (`gitlab.com/…`) never reads as an owner. */
const OWNER = /^[\w-]+$/;
/** GitHub's repository name alphabet (a name may not be `.` or `..`). */
const NAME = /^[\w.-]+$/;

/**
 * Read what someone typed or pasted into "open a repository": `owner/name`,
 * `github.com/owner/name`, or any GitHub URL inside the repository
 * (`https://github.com/owner/name/pull/123`, `.../tree/main`, `...name.git`),
 * with or without a query or fragment. Null when it is none of those.
 */
export function parseRepoInput(input: string): RepoRef | null {
  let text = input.trim();
  if (text === '') return null;
  text = text.replace(/^git@github\.com:/i, '');
  text = text.replace(/^[a-z]+:\/\//i, '');
  text = text.replace(/[?#].*$/, '');
  text = text.replace(/^(www\.)?github\.com\//i, '');
  const [owner, rawName] = text.split('/').filter((part) => part !== '');
  if (owner === undefined || rawName === undefined) return null;
  const name = rawName.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null;
  return { owner, name };
}
