import type { RepoRef } from './types.ts';

/** Accepts `owner/name`, `github.com/owner/name`, or a full GitHub URL. */
export function parseRepo(input: string): RepoRef {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '');
  // Managed GitHub accounts can have an underscore in their login.
  const match = /^([a-z\d](?:[a-z\d_-]*[a-z\d])?)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error(`Expected owner/name, got "${input}"`);
  }
  return { owner: match[1] as string, name: match[2] as string };
}
