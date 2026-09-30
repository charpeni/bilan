import { readFileSync } from 'node:fs';

import type { AreaRules } from '@bilan/core';

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
  if (
    !Array.isArray(known) ||
    !known.every(
      (entry: unknown): entry is string =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        !/[/\\\0]/.test(entry) &&
        entry !== '.' &&
        entry !== '..',
    )
  ) {
    throw new Error(
      `Invalid --areas file "${path}": expected { "known": ["directory", ...] } with top-level directory names`,
    );
  }
  return { known: [...new Set(known)] };
}
