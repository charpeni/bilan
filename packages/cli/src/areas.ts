import { readFileSync } from 'node:fs';

import type { AreaRules } from '@bilan/core';

/** A folder path from the repository root: `docs`, `packages/app`; a trailing `/` is allowed. */
const folder = (entry: unknown): entry is string =>
  typeof entry === 'string' &&
  entry
    .replace(/\/$/, '')
    .split('/')
    .every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[\\\0]/.test(part));

export function readAreaRules(path: string | undefined): AreaRules | undefined {
  if (path === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read --areas file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const known =
    value !== null && typeof value === 'object' && 'known' in value ? value.known : undefined;
  if (!Array.isArray(known) || !known.every(folder)) {
    throw new Error(
      `Invalid --areas file "${path}": expected { "known": ["folder", ...] } with folder paths from the repository root, such as "docs" or "packages/app"`,
    );
  }
  return { known: [...new Set(known.map((entry) => entry.replace(/\/$/, '')))] };
}
