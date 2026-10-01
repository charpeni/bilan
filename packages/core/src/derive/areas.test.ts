import { describe, expect, it } from 'vitest';

import { allAreas, areasOf, inferAreaRules, workPaths } from './areas.ts';

describe('areasOf', () => {
  const rules = { known: ['backend', 'frontend'] };

  it('maps known top-level directories, nested unknown paths, and root files', () => {
    expect(areasOf(['backend/a.clj', 'frontend/b.ts', 'tools/c.sh', 'README.md'], rules)).toEqual([
      'backend',
      'frontend',
      'other',
      'root',
    ]);
  });

  it('deduplicates', () => {
    expect(areasOf(['backend/a', 'backend/b'], rules)).toEqual(['backend']);
  });

  it('lists every area a payload can contain', () => {
    expect(allAreas(rules)).toEqual(['backend', 'frontend', 'other', 'root']);
  });

  it('puts a file in the deepest known folder holding it', () => {
    const nested = { known: ['packages', 'packages/app', 'packages/app/plugins/x'] };
    expect(areasOf(['packages/app/src/a.ts'], nested)).toEqual(['packages/app']);
    expect(areasOf(['packages/app/plugins/x/b.ts'], nested)).toEqual(['packages/app/plugins/x']);
    expect(areasOf(['packages/lib/c.ts'], nested)).toEqual(['packages']);
    // A known folder is matched on whole names: `packages/application` is not in `packages/app`.
    expect(areasOf(['packages/application/d.ts'], nested)).toEqual(['packages']);
  });

  it('counts lockfiles and changesets toward no area', () => {
    expect(
      areasOf(['.changeset/brave-cats.md', 'pnpm-lock.yaml', 'backend/go.sum', 'backend/a'], rules),
    ).toEqual(['backend']);
  });

  it('counts a release or dependency bump toward no area', () => {
    const release = [
      '.changeset/pre.json',
      'backend/CHANGELOG.md',
      'backend/package.json',
      'frontend/package.json',
      'pnpm-lock.yaml',
    ];
    expect(areasOf(release, rules)).toEqual([]);
    // Alongside real work, manifests and changelogs count like any file.
    expect(areasOf([...release, 'frontend/b.ts'], rules)).toEqual(['backend', 'frontend']);
  });
});

describe('workPaths', () => {
  it('keeps every non-housekeeping path once any of them is real work', () => {
    expect(workPaths(['package.json', 'yarn.lock', 'README.md'])).toEqual([
      'package.json',
      'README.md',
    ]);
    expect(workPaths(['package.json', 'Cargo.toml', 'changelog.md', 'yarn.lock'])).toEqual([]);
    expect(workPaths([])).toEqual([]);
  });
});

describe('inferAreaRules', () => {
  it('ranks top-level directories by how many PRs touch them', () => {
    const rules = inferAreaRules([
      ['src/a.ts', 'src/b.ts', 'docs/x.md'],
      ['src/c.ts'],
      ['src/d.ts', 'README.md'],
      ['docs/y.md', 'test/z.ts'],
    ]);
    expect(rules.known).toEqual(['src', 'docs', 'test']);
  });

  it('leaves housekeeping folders out', () => {
    const rules = inferAreaRules([
      ['.changeset/a.md', 'lib/a.ts'],
      ['.changeset/b.md', 'docs/b.md'],
    ]);
    expect(rules.known).toEqual(['docs', 'lib']);
  });

  /** A monorepo: most PRs land in `packages/`, and a release touches every manifest. */
  const monorepo = [
    [
      'examples/blog/package.json',
      'examples/docs/package.json',
      'packages/core/CHANGELOG.md',
      'packages/core/package.json',
      'packages/core/test/fixtures/basic/package.json',
      'packages/integrations/node/package.json',
      'packages/integrations/vercel/package.json',
    ],
    ['packages/core/src/a.ts', 'packages/core/test/fixtures/basic/x.ts'],
    ['packages/core/src/b.ts', 'packages/integrations/node/src/c.ts'],
    ['packages/core/src/g.ts'],
    ['packages/integrations/vercel/src/d.ts', '.github/workflows/ci.yml'],
    ['packages/integrations/README.md'],
    ['examples/blog/src/e.astro'],
    ['examples/docs/src/f.astro', 'README.md'],
  ];

  it('splits a folder most PRs touch into its outermost package roots', () => {
    const rules = inferAreaRules(monorepo);
    expect(rules.known).toEqual([
      'packages/core',
      'examples',
      '.github',
      'packages/integrations',
      'packages/integrations/node',
      'packages/integrations/vercel',
    ]);
    // A test fixture's manifest makes no area; neither does each example's.
    expect(areasOf(['packages/core/test/fixtures/basic/x.ts'], rules)).toEqual(['packages/core']);
    expect(areasOf(['examples/blog/src/e.astro'], rules)).toEqual(['examples']);
    // The release itself counts toward no area.
    expect(areasOf(monorepo[0] ?? [], rules)).toEqual([]);
  });

  it('splits by subfolder when a busy folder holds no package', () => {
    const rules = inferAreaRules([
      ['src/server/a.ts', 'src/index.ts'],
      ['src/client/b.ts'],
      ['src/server/c.ts', 'docs/d.md'],
    ]);
    expect(rules.known).toEqual(['src/server', 'docs', 'src', 'src/client']);
  });

  it('splits only a folder touched by more than half the PRs', () => {
    const rules = inferAreaRules([
      ['packages/a/package.json', 'packages/a/x.ts'],
      ['packages/b/package.json', 'packages/b/y.ts'],
      ['docs/a.md'],
      ['docs/b.md'],
    ]);
    expect(rules.known).toEqual(['docs', 'packages']);
  });

  it('keeps a busy folder whole when one piece would hold nearly all of its PRs', () => {
    const rules = inferAreaRules([
      ['test/a.ts', 'test/helpers/h.ts'],
      ['test/b.ts'],
      ['test/c.ts', 'src/c.ts'],
      ['src/d.ts'],
    ]);
    expect(rules.known).toEqual(['test', 'src']);
  });

  it('ignores manifests too deep to be package roots', () => {
    const rules = inferAreaRules([
      ['packages/core/test/fixtures/basic/package.json', 'packages/core/src/a.ts'],
      ['packages/core/src/b.ts'],
      ['packages/web/src/c.ts'],
      ['packages/web/src/d.ts'],
    ]);
    expect(rules.known).toEqual(['packages/core', 'packages/web']);
  });
});
