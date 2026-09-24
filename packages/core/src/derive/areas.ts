/**
 * How changed paths map to areas. `known` lists the top-level directories that
 * are meaningful on their own; every other nested path becomes `other` and
 * files at the repo root become `root`.
 */
export interface AreaRules {
  known: string[];
}

export const OTHER_AREA = 'other';
export const ROOT_AREA = 'root';

export function areasOf(paths: Iterable<string>, rules: AreaRules): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const top = path.split('/')[0] ?? '';
    seen.add(rules.known.includes(top) ? top : path.includes('/') ? OTHER_AREA : ROOT_AREA);
  }
  return [...seen];
}

/** Every area a payload can contain, in display order. */
export function allAreas(rules: AreaRules): string[] {
  return [...rules.known, OTHER_AREA, ROOT_AREA];
}

/**
 * Default rules for a repo we know nothing about: every top-level directory
 * that shows up in the file samples counts, most frequent first.
 */
export function inferAreaRules(fileSamples: Iterable<string[]>): AreaRules {
  const counts = new Map<string, number>();
  for (const sample of fileSamples) {
    const tops = new Set(sample.filter((p) => p.includes('/')).map((p) => p.split('/')[0] ?? ''));
    for (const top of tops) counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const known = [...counts]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([top]) => top);
  return { known };
}
