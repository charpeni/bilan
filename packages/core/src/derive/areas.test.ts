import { describe, expect, it } from 'vitest';

import { allAreas, areasOf, inferAreaRules } from './areas.ts';

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
});
