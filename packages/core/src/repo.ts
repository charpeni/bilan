import type { RepoRef } from './types.ts';

/** Accepts `owner/name`, `github.com/owner/name`, or a full GitHub URL. */
export function parseRepo(input: string): RepoRef {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '');
  const match = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (!match) throw new Error(`Expected owner/name, got "${input}"`);
  return { owner: match[1] as string, name: match[2] as string };
}
