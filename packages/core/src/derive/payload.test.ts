import { describe, expect, it } from 'vitest';

import { rawPr } from '../testing/fixtures.ts';
import { buildPayload, serializePayload } from './payload.ts';

const meta = {
  repo: 'acme/widgets',
  syncedAt: '2026-02-01T00:00:00Z',
  coverageSince: '2026-01-02T00:00:00Z',
  openPrsSyncedAt: '2026-02-01T00:00:00Z',
  interrupted: false,
  syncStartedAt: null,
  reconciledAt: '2026-01-31T23:59:00Z',
};

describe('buildPayload', () => {
  it('preserves incomplete-sync metadata for exported reports', () => {
    expect(buildPayload({ ...meta, interrupted: true }, [])).toMatchObject({
      interrupted: true,
      reconciledAt: meta.reconciledAt,
    });
  });

  it('slims PRs into the dashboard shape, sorted by creation time', () => {
    const payload = buildPayload(meta, [
      rawPr({ number: 2, createdAt: '2026-01-05T00:00:00Z' }),
      rawPr({ number: 1, createdAt: '2026-01-01T10:00:00Z' }),
    ]);
    expect(payload.repo).toBe('acme/widgets');
    expect(payload.syncedAt).toBe('2026-02-01T00:00:00Z');
    expect(payload.coverageSince).toBe('2026-01-02T00:00:00Z');
    expect(payload.openPrsSyncedAt).toBe('2026-02-01T00:00:00Z');
    expect(payload.prs.map((p) => p.n)).toEqual([1, 2]);
    expect(payload.prs[0]).toMatchObject({
      n: 1,
      a: 'alice',
      bot: 0,
      c: Date.parse('2026-01-01T10:00:00Z'),
      r: Date.parse('2026-01-01T10:00:00Z'),
      d: 0,
      m: Date.parse('2026-01-02T10:00:00Z'),
      s: 'MERGED',
      mb: 'bob',
      ar: ['src'],
      rv: [['bob', 'APPROVED', Date.parse('2026-01-01T12:00:00Z')]],
      rq: [['bob', Date.parse('2026-01-01T10:05:00Z')]],
    });
  });

  it('drops self-reviews and reviews without a timestamp, and sorts the rest', () => {
    const payload = buildPayload(meta, [
      rawPr({
        reviews: [
          { author: 'carol', authorType: 'User', state: 'COMMENTED', at: '2026-01-01T13:00:00Z' },
          { author: 'alice', authorType: 'User', state: 'COMMENTED', at: '2026-01-01T11:00:00Z' },
          { author: 'bob', authorType: 'User', state: 'PENDING', at: null },
          { author: 'bob', authorType: 'User', state: 'APPROVED', at: '2026-01-01T12:00:00Z' },
        ],
      }),
    ]);
    expect(payload.prs[0]?.rv).toEqual([
      ['bob', 'APPROVED', Date.parse('2026-01-01T12:00:00Z')],
      ['carol', 'COMMENTED', Date.parse('2026-01-01T13:00:00Z')],
    ]);
  });

  it('flags bot authors and lists bots for reviewer filtering', () => {
    const payload = buildPayload(meta, [
      rawPr({ number: 1, author: 'dependabot[bot]', authorType: 'Bot' }),
      rawPr({ number: 2 }),
    ]);
    expect(payload.bots).toEqual(['dependabot[bot]']);
    expect(payload.prs.map((p) => p.bot)).toEqual([1, 0]);
  });

  it('honours explicit area rules', () => {
    const payload = buildPayload(meta, [rawPr({ fileSample: ['src/a.ts', 'lib/b.ts'] })], {
      areas: { known: ['lib'] },
    });
    expect(payload.areas).toEqual(['lib', 'other', 'root']);
    expect(payload.prs[0]?.ar).toEqual(['other', 'lib']);
  });

  it('carries full-history coverage and an incomplete open set through as null', () => {
    const payload = buildPayload({ ...meta, coverageSince: null, openPrsSyncedAt: null }, []);
    expect(payload.coverageSince).toBeNull();
    expect(payload.openPrsSyncedAt).toBeNull();
  });

  it('drops review requests whose reviewer could not be resolved', () => {
    const payload = buildPayload(meta, [
      rawPr({ reviewRequests: [{ at: '2026-01-01T10:05:00Z', to: null }] }),
    ]);
    expect(payload.prs[0]?.rq).toEqual([]);
  });
});

describe('serializePayload', () => {
  it('escapes script-closing and line-separator characters', () => {
    const out = serializePayload(buildPayload(meta, [rawPr({ title: '</script> x' })]));
    expect(out).not.toContain('</script>');
    expect(out).not.toContain(' ');
    expect(JSON.parse(out).prs[0].t).toBe('</script> x');
  });
});
