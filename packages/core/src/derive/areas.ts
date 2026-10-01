/**
 * How changed paths map to areas. `known` lists the folders that are areas on
 * their own, as paths from the repository root (`docs`, `packages/app`); a
 * file belongs to the deepest one it sits in. Other nested paths become
 * `other` and files at the repo root become `root`.
 */
export interface AreaRules {
  known: string[];
}

export const OTHER_AREA = 'other';
export const ROOT_AREA = 'root';

/** Written by package managers, so they say nothing about where the work is. */
const LOCKFILES = new Set([
  'Cargo.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'deno.lock',
  'go.sum',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
]);
/** A folder holding one of these is a package root. */
const MANIFESTS = new Set(['Cargo.toml', 'go.mod', 'package.json', 'pyproject.toml']);
const CHANGELOG = /^changelog(\.md)?$/i;

/**
 * A top-level folder touched by more than this share of PRs is split into
 * packages: when most of the work lands in one folder, that folder cannot say
 * where the work moves. Below half, a folder already tells PRs apart.
 */
const SPLIT_SHARE = 0.5;
/**
 * A split that leaves more than this share of the folder's PRs in one piece
 * separates nothing (a `test/` folder with one `test/helpers/`), so the folder
 * stays whole. In monorepos the busiest package holds well under it.
 */
const PIECE_SHARE = 0.9;
/**
 * The deepest package root, in folders from the repository root
 * (`packages/integrations/node`). Manifests further down are test fixtures
 * and templates inside a package.
 */
const MAX_ROOT_DEPTH = 3;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** The top-level folder of a path or of an area. */
const topOf = (path: string): string => path.split('/', 1)[0] ?? '';

/** Lockfiles and pending changesets, which count toward no area. */
const isHousekeeping = (path: string): boolean =>
  path.startsWith('.changeset/') || LOCKFILES.has(baseName(path));

/** What release and dependency PRs touch in every package at once. */
const isBookkeeping = (path: string): boolean =>
  MANIFESTS.has(baseName(path)) || CHANGELOG.test(baseName(path));

/**
 * The sampled paths that say where the work is: housekeeping is dropped, and
 * a sample of nothing but manifests and changelogs (a release, a dependency
 * bump) says nothing at all.
 */
export function workPaths(paths: Iterable<string>): string[] {
  const kept = [...paths].filter((p) => !isHousekeeping(p));
  return kept.every(isBookkeeping) ? [] : kept;
}

/** The deepest known folder holding `path`. */
function areaOf(path: string, known: ReadonlySet<string>): string {
  let end = path.lastIndexOf('/');
  if (end < 0) return ROOT_AREA;
  for (; end > 0; end = path.lastIndexOf('/', end - 1)) {
    const dir = path.slice(0, end);
    if (known.has(dir)) return dir;
  }
  return OTHER_AREA;
}

export function areasOf(paths: Iterable<string>, rules: AreaRules): string[] {
  const known = new Set(rules.known);
  return [...new Set(workPaths(paths).map((p) => areaOf(p, known)))];
}

/** Every area a payload can contain, in display order. */
export function allAreas(rules: AreaRules): string[] {
  return [...rules.known, OTHER_AREA, ROOT_AREA];
}

/**
 * The outermost folders below the top level that hold a sampled manifest.
 * Release and dependency PRs touch every manifest, so the roots show up even
 * though only paths are synced.
 */
function packageRoots(samples: readonly (readonly string[])[]): string[] {
  const dirs = new Set<string>();
  for (const sample of samples) {
    for (const path of sample) {
      const depth = path.split('/').length - 1;
      if (depth >= 2 && depth <= MAX_ROOT_DEPTH && MANIFESTS.has(baseName(path))) {
        dirs.add(path.slice(0, path.lastIndexOf('/')));
      }
    }
  }
  return [...dirs].filter((d) => ![...dirs].some((o) => d.startsWith(`${o}/`)));
}

/** A path's area inside a split folder: its package, else its subfolder. */
function packageOf(path: string, roots: readonly string[]): string {
  const root = roots.find((r) => path.startsWith(`${r}/`));
  if (root) return root;
  const parts = path.split('/');
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : topOf(path);
}

/**
 * Default rules for a repo we know nothing about: every top-level directory
 * that shows up in the file samples counts, most frequent first, except that
 * a folder most PRs touch (`packages/` in a monorepo) is split into the
 * outermost package roots inside it, or into its subfolders when it holds no
 * package.
 */
export function inferAreaRules(fileSamples: Iterable<readonly string[]>): AreaRules {
  const samples = [...fileSamples];
  const work = samples.map(workPaths);
  const prs = work.filter((s) => s.length).length;
  /** PRs per area, with `toArea` mapping each nested path to its area. */
  const tally = (toArea: (path: string) => string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const sample of work) {
      const areas = new Set(sample.filter((p) => p.includes('/')).map(toArea));
      for (const area of areas) counts.set(area, (counts.get(area) ?? 0) + 1);
    }
    return counts;
  };
  const tops = tally(topOf);
  const busy = [...tops].filter(([, n]) => n > prs * SPLIT_SHARE).map(([top]) => top);
  const roots = busy.length ? packageRoots(samples) : [];
  const splitting =
    (folders: readonly string[]) =>
    (path: string): string =>
      folders.includes(topOf(path)) ? packageOf(path, roots) : topOf(path);
  const pieces = [...tally(splitting(busy))];
  const split = busy.filter(
    (top) =>
      !pieces.some(([piece, n]) => topOf(piece) === top && n > (tops.get(top) ?? 0) * PIECE_SHARE),
  );
  const known = [...tally(splitting(split))]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([area]) => area);
  return { known };
}
