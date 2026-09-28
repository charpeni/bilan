import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoadMoreError, mount } from './index.ts';
import { activitySpan } from './mount.ts';
import { hoursFmt } from './render.ts';

import type { Mounted } from './mount.ts';
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
  let handle: Mounted | undefined;

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
    expect(handle?.range()).toBe('all');
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
        // Still operable: described as not synced, never announced as disabled.
        expect(btn?.getAttribute('aria-disabled')).toBeNull();
        expect(btn?.getAttribute('aria-describedby')).toBe('load-desc');
        expect(btn?.querySelector('.load-mark')?.getAttribute('aria-hidden')).toBe('true');
      }
      expect(root.querySelector('#load-desc')?.textContent).toBe(
        'Not in this report. Re-run the CLI to include it.',
      );
      expect(root.querySelector('[data-range="30"]')?.getAttribute('aria-describedby')).toBeNull();
      expect(root.querySelector('[data-range="30"] .load-mark')).toBeNull();
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
      expect(root.querySelectorAll('[data-range][aria-describedby], .load-mark').length).toBe(0);
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

    it('keeps the range button busy while the host loads, then clears it', async () => {
      let finish: (() => void) | undefined;
      const onLoadMore = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      setup(payload(thirtyDays()), { onLoadMore });
      expect(root.querySelector('#load-desc')?.textContent).toBe(
        'Not synced yet. Selecting it syncs more history.',
      );
      const note = root.querySelector<HTMLElement>('#load-note');
      click('90');
      const btn = root.querySelector('[data-range="90"]');
      expect(btn?.getAttribute('aria-busy')).toBe('true');
      expect(note?.hidden).toBe(false);
      expect(note?.dataset.kind).toBe('busy');
      expect(note?.textContent).toBe('Syncing the last 90 days…');
      // A second click while busy does not start another load.
      click('180');
      expect(onLoadMore).toHaveBeenCalledTimes(1);
      handle?.status('412 pull requests synced so far');
      expect(note?.textContent).toBe('412 pull requests synced so far');
      finish?.();
      await flush();
      expect(btn?.getAttribute('aria-busy')).toBeNull();
      expect(note?.hidden).toBe(true);
    });

    it('shows a failed load beside the range buttons, with its way out', async () => {
      const onLoadMore = vi.fn(() =>
        Promise.reject(
          new LoadMoreError('Your GitHub session expired.', {
            label: 'Sign in again',
            href: '/auth/github/start?next=%2Facme%2Fwidgets',
          }),
        ),
      );
      setup(payload(thirtyDays()), { onLoadMore });
      click('all');
      await flush();
      const note = root.querySelector<HTMLElement>('#load-note');
      expect(note?.dataset.kind).toBe('error');
      expect(note?.textContent).toBe('Your GitHub session expired. Sign in again');
      expect(note?.querySelector('a')?.getAttribute('href')).toBe(
        '/auth/github/start?next=%2Facme%2Fwidgets',
      );
      expect(root.querySelector('[data-range="all"]')?.getAttribute('aria-busy')).toBeNull();
      expect(pressed('30')).toBe('true');
    });

    it('offers the comparison sync from the brief when the host can load more', () => {
      const onLoadMore = vi.fn();
      setup(payload(thirtyDays()), { onLoadMore });
      const btn = root.querySelector<HTMLButtonElement>('.brief-load');
      expect(btn?.textContent).toBe('Sync 90 days');
      btn?.click();
      expect(onLoadMore).toHaveBeenCalledWith('90');
    });

    it('has no comparison action without a host callback', () => {
      setup(payload(thirtyDays()));
      expect(root.querySelector('.brief-load')).toBeNull();
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
    expect(root.querySelector('.tile .d')?.textContent).toBe('1 author');
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

  it('leaves the theme control to the host when asked', async () => {
    setup(payload(), { theme: 'light', themeControl: false });
    expect(root.querySelector('[data-theme-set]')).toBeNull();
    const before = root.querySelector('#app svg');
    document.documentElement.dataset.theme = 'dark';
    await flush();
    await flush();
    // A theme switch by the host page redraws the charts with the new tokens.
    expect(root.querySelector('#app svg')).not.toBe(before);
  });

  it('follows a theme switched outside the dashboard on its own control', async () => {
    setup(payload(), { theme: 'auto' });
    document.documentElement.dataset.theme = 'dark';
    await flush();
    expect(root.querySelector('[data-theme-set="dark"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('sorts tables from real, labelled header buttons', () => {
    setup();
    const table = root.querySelector('#app table');
    const heads = [...(table?.querySelectorAll('th') ?? [])];
    expect(heads.every((th) => th.querySelector('button.sort') !== null)).toBe(true);
    const opened = heads.find((th) => th.textContent === 'Opened');
    const merged = heads.find((th) => th.textContent === 'Merged');
    expect(opened?.getAttribute('aria-sort')).toBe('descending');
    merged?.querySelector('button')?.click();
    expect(merged?.getAttribute('aria-sort')).toBe('descending');
    expect(opened?.getAttribute('aria-sort')).toBeNull();
    merged?.querySelector('button')?.click();
    expect(merged?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('names every chart after its card', async () => {
    setup();
    await flush();
    const labels = [...root.querySelectorAll('#app svg[role="img"]')].map((svg) =>
      svg.getAttribute('aria-label'),
    );
    expect(labels.length).toBeGreaterThanOrEqual(8);
    expect(labels).toContain('Cycle time trend');
    expect(labels.every((l) => l !== null && CARD_TITLES.includes(l))).toBe(true);
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

describe('activitySpan', () => {
  const first = Date.UTC(2025, 11, 3);
  const last = Date.UTC(2026, 8, 28);

  it('spans the whole payload on full history', () => {
    expect(activitySpan(null, first, last)).toMatch(/^Pull request activity from .+ to .+$/);
    expect(activitySpan(null, first, last)).not.toContain('older open PRs');
  });

  it('starts at the coverage bound when older open PRs stretch the payload', () => {
    const since = new Date(Date.UTC(2026, 7, 29)).toISOString();
    const text = activitySpan(since, first, last);
    expect(text).toMatch(/, plus older open PRs$/);
    expect(text).toContain(new Date(Date.UTC(2026, 7, 29)).getFullYear().toString());
    expect(text).not.toBe(activitySpan(null, first, last));
  });

  it('ignores a bound that is before the oldest PR, or unparseable', () => {
    expect(activitySpan(new Date(first - DAY).toISOString(), first, last)).toBe(
      activitySpan(null, first, last),
    );
    expect(activitySpan('nope', first, last)).toBe(activitySpan(null, first, last));
  });
});

describe('hoursFmt', () => {
  it('prints hours as the dashboard durations, so large values fit the axis', () => {
    expect(hoursFmt(0)).toBe('0');
    expect(hoursFmt(5)).toBe('5.0h');
    expect(hoursFmt(36)).toBe('1.5d');
    expect(hoursFmt(24 * 200)).toBe('6.7mo');
    expect(hoursFmt(30_000)).toBe('3.4y');
  });
});
