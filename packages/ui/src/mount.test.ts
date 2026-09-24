import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from './index.ts';

import type { Payload, PayloadPr, PayloadReview, PayloadReviewRequest } from '@bilan/core';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
/** Monday 2026-01-05, so the synthetic data lines up with week buckets. */
const T0 = Date.UTC(2026, 0, 5, 9);

interface PrSpec {
  n: number;
  title: string;
  author: string | null;
  bot?: boolean;
  /** Days after T0 the PR was opened. */
  day: number;
  draft?: boolean;
  /** Hours from open to ready (draft PRs only). */
  readyAfter?: number;
  /** Hours from ready to merge; undefined = not merged. */
  mergeAfter?: number;
  /** Hours from open to close without merging. */
  closeAfter?: number;
  mergedBy?: string | null;
  add?: number;
  del?: number;
  areas?: string[];
  /** [reviewer, state, hours after ready] */
  reviews?: [string, PayloadReview[1], number][];
  /** [reviewer, hours after ready] */
  requests?: [string, number][];
  currentlyDraft?: boolean;
}

function pr(spec: PrSpec): PayloadPr {
  const c = T0 + spec.day * DAY;
  const r = spec.draft ? (spec.readyAfter === undefined ? null : c + spec.readyAfter * HOUR) : c;
  const m = spec.mergeAfter === undefined || r === null ? null : r + spec.mergeAfter * HOUR;
  const x = m ?? (spec.closeAfter === undefined ? null : c + spec.closeAfter * HOUR);
  const base = r ?? c;
  const rv: PayloadReview[] = (spec.reviews ?? []).map(([who, st, h]) => [
    who,
    st,
    base + h * HOUR,
  ]);
  const rq: PayloadReviewRequest[] = (spec.requests ?? []).map(([who, h]) => [
    who,
    base + h * HOUR,
  ]);
  return {
    n: spec.n,
    t: spec.title,
    a: spec.author,
    bot: spec.bot ? 1 : 0,
    c,
    r,
    d: spec.draft ? 1 : 0,
    m,
    x,
    s: m !== null ? 'MERGED' : x !== null ? 'CLOSED' : 'OPEN',
    dr: spec.currentlyDraft ? 1 : 0,
    mb: m === null ? null : (spec.mergedBy ?? spec.author),
    ad: spec.add ?? 40,
    de: spec.del ?? 10,
    cf: 3,
    ar: spec.areas ?? ['api'],
    cm: 1,
    th: 1,
    rc: rv.length,
    rv,
    rq,
  };
}

/** Last activity in the fixture: PR #14 merged 2 hours after opening on day 98. */
const LAST = T0 + 98 * DAY + 2 * HOUR;

function payload(
  coverageSince: string | null = null,
  openPrsSyncedAt: string | null = null,
): Payload {
  const prs = [
    pr({
      n: 1,
      title: 'Add login endpoint',
      author: 'alice',
      day: 0,
      mergeAfter: 20,
      mergedBy: 'bob',
      reviews: [['bob', 'APPROVED', 6]],
      requests: [['bob', 1]],
    }),
    pr({
      n: 2,
      title: 'Fix header layout',
      author: 'bob',
      day: 3,
      mergeAfter: 5,
      areas: ['web'],
      reviews: [['alice', 'APPROVED', 2]],
    }),
    pr({
      n: 3,
      title: 'Refactor billing',
      author: 'alice',
      day: 10,
      draft: true,
      readyAfter: 30,
      mergeAfter: 48,
      mergedBy: 'carol',
      add: 600,
      del: 200,
      reviews: [
        ['carol', 'CHANGES_REQUESTED', 4],
        ['carol', 'APPROVED', 30],
      ],
    }),
    pr({
      n: 4,
      title: 'Bump deps',
      author: 'dependabot[bot]',
      bot: true,
      day: 12,
      mergeAfter: 1,
      mergedBy: 'bob',
      add: 3,
      del: 3,
    }),
    pr({
      n: 5,
      title: 'Revert "Fix header layout"',
      author: 'carol',
      day: 20,
      mergeAfter: 2,
      areas: ['web'],
      reviews: [['bob', 'APPROVED', 1]],
    }),
    pr({
      n: 6,
      title: 'Docs: getting started',
      author: 'carol',
      day: 25,
      closeAfter: 10,
      areas: ['docs'],
    }),
    pr({
      n: 7,
      title: 'Search indexing',
      author: 'alice',
      day: 40,
      mergeAfter: 100,
      add: 1500,
      del: 300,
      areas: ['api', 'web'],
      reviews: [
        ['bob', 'COMMENTED', 10],
        ['carol', 'APPROVED', 80],
      ],
    }),
    pr({
      n: 8,
      title: 'Rate limiting',
      author: 'bob',
      day: 55,
      mergeAfter: 30,
      reviews: [['alice', 'APPROVED', 12]],
      requests: [['alice', 0]],
    }),
    pr({
      n: 9,
      title: 'Old forgotten draft',
      author: 'carol',
      day: 60,
      draft: true,
      currentlyDraft: true,
    }),
    pr({ n: 10, title: 'Waiting for review', author: 'alice', day: 88, areas: ['docs'] }),
    pr({
      n: 11,
      title: 'Approved but stalled',
      author: 'bob',
      day: 90,
      reviews: [['carol', 'APPROVED', 3]],
    }),
    pr({
      n: 12,
      title: 'Telemetry hooks',
      author: 'carol',
      day: 95,
      mergeAfter: 8,
      areas: ['api'],
      reviews: [['alice', 'APPROVED', 4]],
    }),
    pr({
      n: 13,
      title: 'Weekend hotfix',
      author: 'alice',
      day: 96,
      mergeAfter: 0.5,
      areas: ['web'],
    }),
    pr({
      n: 14,
      title: 'Bump deps again',
      author: 'dependabot[bot]',
      bot: true,
      day: 98,
      mergeAfter: 2,
      mergedBy: 'alice',
      add: 2,
      del: 2,
    }),
  ];
  const last = Math.max(...prs.map((p) => Math.max(p.c, p.m ?? 0, p.x ?? 0)));
  if (last !== LAST) throw new Error('fixture drifted: update LAST');
  return {
    repo: 'acme/widgets',
    syncedAt: new Date(last + HOUR).toISOString(),
    coverageSince,
    openPrsSyncedAt,
    areas: ['api', 'web', 'docs'],
    bots: ['dependabot[bot]'],
    prs,
  };
}

const CARD_TITLES = [
  'Throughput',
  'Open PR backlog',
  'Cycle time trend',
  'Time to merge',
  'PR size',
  'Where the work lands',
  'When PRs get merged',
  'Contributors',
  'Reviewers',
  'Top reviewers',
  'Strongest review pairs',
  'Bus factor by area',
  'What stands out',
  'Oldest open PRs',
];

const TILE_LABELS = [
  'PRs opened',
  'Merged',
  'Closed unmerged',
  'Median time to merge',
  'Median time to first review',
  'Median time in draft',
  'Reviews given',
];

/** Coverage a default sync leaves behind: 30 days before the last activity. */
const thirtyDays = (): string => new Date(LAST - 30 * DAY).toISOString();
/** Coverage after a `--since` run reaching back 60 days: enough for the brief to compare. */
const sixtyDays = (): string => new Date(LAST - 60 * DAY).toISOString();

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const texts = (root: ParentNode, sel: string): string[] =>
  [...root.querySelectorAll(sel)].map((n) => n.textContent ?? '');

const heroValue = (root: ParentNode): string =>
  root.querySelector('.tile .hero')?.textContent ?? '';

describe('mount', () => {
  let root: HTMLElement;
  let handle: { destroy(): void } | undefined;

  afterEach(() => {
    handle?.destroy();
    handle = undefined;
    root.remove();
  });

  const setup = (data: Payload = payload(), options?: Parameters<typeof mount>[2]): void => {
    root = document.createElement('div');
    document.body.append(root);
    handle = mount(root, data, options);
  };

  const pressed = (range: string): string | null =>
    root.querySelector(`[data-range="${range}"]`)?.getAttribute('aria-pressed') ?? null;
  const needsLoad = (): string[] =>
    [...root.querySelectorAll<HTMLElement>('[data-range].needs-load')].map(
      (b) => b.dataset.range ?? '',
    );
  const click = (range: string): void => {
    const btn = root.querySelector<HTMLButtonElement>(`[data-range="${range}"]`);
    expect(btn).not.toBeNull();
    btn?.click();
  };
  const briefText = (): string => root.querySelector('#brief')?.textContent ?? '';
  const titles = (): string[] => texts(root, '#brief h3');

  it('renders the header, tiles, every card, and the brief', async () => {
    setup();
    expect(root.querySelector('#repo-title')?.textContent).toBe('acme/widgets');
    expect(root.querySelector('#repo-sub')?.textContent).toMatch(/^Pull request activity from /);
    expect(root.querySelector('#scope-note')?.textContent).toMatch(
      /^14 PRs synced · .* · full history$/,
    );

    expect(texts(root, '.tile .k')).toEqual(TILE_LABELS);
    expect(texts(root, '.card > h2')).toEqual(CARD_TITLES);

    expect(root.querySelector('#brief h2')?.textContent).toBe('Last 30 days at a glance');
    expect(texts(root, '#brief .ins-tag')).toEqual(
      expect.arrayContaining(['Throughput', 'PR size', 'Review speed', 'Backlog', 'Other signals']),
    );

    // Charts are drawn in a microtask after the cards are laid out.
    await flush();
    expect(root.querySelectorAll('#app svg').length).toBeGreaterThanOrEqual(8);
    expect(root.querySelectorAll('#app table').length).toBe(3);
  });

  it('defaults to the last 30 days and excludes bots', () => {
    setup();
    expect(pressed('30')).toBe('true');
    expect(pressed('all')).toBe('false');
    // PRs #10-#13 opened in the last 30 days (bots excluded).
    expect(heroValue(root)).toBe('4');
    expect(document.documentElement.dataset.theme).toBe('auto');
    expect(root.querySelector('[data-theme-set="auto"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('re-renders when a range button is clicked', () => {
    setup();
    const before = heroValue(root);
    click('all');
    expect(pressed('all')).toBe('true');
    expect(pressed('30')).toBe('false');
    const after = heroValue(root);
    expect(after).not.toBe(before);
    // Every human PR, all time.
    expect(after).toBe('12');
    expect(texts(root, '.card > h2')).toEqual(CARD_TITLES);
  });

  it('honours initialRange when the payload covers it', () => {
    setup(payload(), { initialRange: '90' });
    expect(pressed('90')).toBe('true');
    expect(pressed('30')).toBe('false');
  });

  describe('coverage', () => {
    it('marks ranges deeper than the coverage as needing a load', () => {
      setup(payload(thirtyDays()));
      expect(needsLoad()).toEqual(['90', '180', 'all']);
      for (const range of ['90', '180', 'all']) {
        const btn = root.querySelector(`[data-range="${range}"]`);
        expect(btn?.getAttribute('aria-disabled')).toBe('true');
        expect(btn?.getAttribute('title')).toBe('Load more history');
      }
      expect(root.querySelector('[data-range="30"]')?.getAttribute('aria-disabled')).toBeNull();
      expect(root.querySelector('#scope-note')?.textContent).toMatch(
        /· covers activity since [A-Z][a-z]{2} \d{1,2}, \d{4} · open PRs partially synced$/,
      );
    });

    it('claims every open PR only once a complete open walk is recorded', () => {
      setup(payload(thirtyDays(), new Date(LAST + HOUR).toISOString()));
      expect(root.querySelector('#scope-note')?.textContent).toMatch(
        /· covers activity since [A-Z][a-z]{2} \d{1,2}, \d{4} · plus all open PRs$/,
      );
    });

    it('tolerates a sync that started a little after the last activity', () => {
      setup(payload(new Date(LAST + 6 * HOUR - 30 * DAY).toISOString()));
      expect(needsLoad()).toEqual(['90', '180', 'all']);
      expect(pressed('30')).toBe('true');
    });

    it('marks nothing when the payload is full history', () => {
      setup(payload(null));
      expect(needsLoad()).toEqual([]);
      expect(root.querySelectorAll('[data-range][aria-disabled]').length).toBe(0);
    });

    it('asks the host to load more instead of switching range', () => {
      const onLoadMore = vi.fn();
      setup(payload(thirtyDays()), { onLoadMore });
      const before = heroValue(root);
      click('all');
      expect(onLoadMore).toHaveBeenCalledWith('all');
      expect(pressed('30')).toBe('true');
      expect(pressed('all')).toBe('false');
      expect(heroValue(root)).toBe(before);
      expect(root.querySelector<HTMLElement>('#load-note')?.hidden).toBe(true);
    });

    it('explains how to re-sync from the CLI when there is no host callback', () => {
      setup(payload(thirtyDays()));
      const note = root.querySelector<HTMLElement>('#load-note');
      expect(note?.hidden).toBe(true);
      click('90');
      expect(note?.hidden).toBe(false);
      // LAST is 2026-04-13T11:00Z; 90 days earlier is 2026-01-13.
      expect(note?.textContent).toBe(
        'Not synced yet. Re-run `bilan acme/widgets --since 2026-01-13` or `bilan acme/widgets --full`.',
      );
      click('all');
      expect(note?.textContent).toBe('Not synced yet. Re-run `bilan acme/widgets --full`.');
      expect(pressed('30')).toBe('true');
      click('30');
      expect(note?.hidden).toBe(true);
    });

    it('falls back to 30 days when initialRange is not covered', () => {
      setup(payload(thirtyDays()), { initialRange: 'all' });
      expect(pressed('30')).toBe('true');
      expect(pressed('all')).toBe('false');
    });
  });

  describe('brief comparisons', () => {
    it('compares with the previous 30 days on full history', () => {
      setup(payload(null));
      expect(briefText()).toContain(', compared with the 30 days before.');
      expect(titles().some((t) => /PRs merged, .* on the previous 30 days$/.test(t))).toBe(true);
      expect(briefText()).not.toContain('Comparisons appear once 60 days are synced.');
      expect(root.querySelector('.brief-compare-note')).toBeNull();
    });

    it('only claims new contributors on full history', () => {
      setup(payload(null));
      // Everyone active in the last 30 days had PRs before, and the whole history says so.
      expect(briefText()).toContain('No new contributors.');
    });

    it('compares once 60 days are covered, but says nothing about new contributors', () => {
      setup(payload(sixtyDays()));
      expect(root.querySelector('.brief-compare-note')).toBeNull();
      const text = briefText();
      expect(text).toContain(', compared with the 30 days before.');
      expect(titles().some((t) => /PRs merged, .* on the previous 30 days$/.test(t))).toBe(true);
      // "First ever" cannot be known from a 60-day window.
      expect(text).not.toContain('New contributors');
      expect(text).not.toContain('No new contributors');
    });

    it('does not compare when coverage is a day short of 60', () => {
      setup(payload(new Date(LAST - 59 * DAY).toISOString()));
      expect(root.querySelector('.brief-compare-note')?.textContent).toBe(
        'Comparisons appear once 60 days are synced.',
      );
      expect(briefText()).not.toContain('compared with the 30 days before');
    });

    it('reads out the current period alone with 30-day coverage', () => {
      setup(payload(thirtyDays()));
      const text = briefText();
      expect(root.querySelector('.brief-compare-note')?.textContent).toBe(
        'Comparisons appear once 60 days are synced.',
      );
      expect(text).not.toContain('compared with the 30 days before');
      expect(text).not.toContain('previous 30 days');
      expect(text).not.toContain(' before)');
      expect(text).not.toContain('(was ');
      expect(text).not.toContain('up from');
      expect(text).not.toContain('down from');
      expect(text).not.toContain('New contributors');
      expect(text).not.toContain('No new contributors');
      expect(titles()).toEqual(
        expect.arrayContaining([expect.stringMatching(/^\d+ PRs merged in the last 30 days$/)]),
      );
      expect(titles().some((t) => /^The median PR is \d+ lines$/.test(t))).toBe(true);
      expect(texts(root, '#brief .ins-tag')).not.toContain('Where work lands');
    });
  });

  it('re-renders when the person filter changes', () => {
    setup();
    const sel = root.querySelector<HTMLSelectElement>('#person-filter');
    expect(sel).not.toBeNull();
    if (!sel) return;
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'alice', 'bob', 'carol']);
    click('all');
    sel.value = 'alice';
    sel.dispatchEvent(new Event('change'));
    expect(heroValue(root)).toBe('5');
    expect(root.querySelector('.tile .d')?.textContent).toBe('1 authors');
  });

  it('includes bot PRs when the checkbox is unticked', () => {
    setup();
    const box = root.querySelector<HTMLInputElement>('#hide-bots');
    expect(box).not.toBeNull();
    if (!box) return;
    click('all');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(heroValue(root)).toBe('14');
  });

  it('applies the theme option and restores it on destroy', () => {
    setup(payload(), { theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(root.querySelector('[data-theme-set="dark"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(root.querySelector('[data-theme-set="auto"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    handle?.destroy();
    handle = undefined;
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('empties the root on destroy', () => {
    setup();
    expect(root.childNodes.length).toBeGreaterThan(0);
    handle?.destroy();
    handle = undefined;
    expect(root.childNodes.length).toBe(0);
    expect(root.innerHTML).toBe('');
  });
});
