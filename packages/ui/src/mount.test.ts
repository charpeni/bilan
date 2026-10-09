import { afterEach, describe, expect, it, vi } from 'vitest';

import { DAY, fixturePayload as payload, HOUR, LAST } from './fixture.ts';
import { holdHeight, LoadMoreError, mount } from './index.ts';
import { activitySpan } from './mount.ts';
import { hoursFmt } from './render.ts';

import type { Mounted } from './mount.ts';
import type { Payload, PayloadPr } from '@bilan/core';

const CARD_TITLES = [
  'Throughput',
  'Open PR backlog',
  'Cycle time trend',
  'Time to merge',
  'PR size',
  'Where the work lands',
  'When PRs get merged',
  'Where the work moves',
  'Contributors',
  'Reviewers',
  'Top reviewers',
  'Review depth by PR size',
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

/** A card's position among its siblings, for the layout stubs. */
const index = (card: HTMLElement): number =>
  [...(card.parentElement?.children ?? [])].indexOf(card);

/**
 * happy-dom lays nothing out, so the grid is stubbed: `perRow` cards share
 * each `offsetTop`, and every card is 200px tall but the second, 240px.
 */
const layoutCards = (perRow: number): void => {
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('ins') ? Math.floor(index(this) / perRow) * 260 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('ins') ? (index(this) === 1 ? 240 : 200) : 0;
  });
};

/** happy-dom has no viewport either: the page is stubbed `px` wide, as the resize handler reads it. */
const viewportWidth = (px: number): void => {
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(px);
};

/** `node` measures `px` tall; everything else in happy-dom measures 0. */
const heightOf = (node: HTMLElement, px: number): void => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this === node ? px : 0;
  });
};
/**
 * `held()` at each moment a chart reads its host's width, which lays out
 * the page. (A table's scroll cue reads widths too, a frame later, on a
 * page already whole.)
 */
const atChartLayout = (held: () => string): string[] => {
  const seen: string[] = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.parentElement?.matches('#app .card')) seen.push(held());
    return 0;
  });
  return seen;
};

/** A PR of over 1,000 lines merged 4 days before `LAST` on an approval alone, with no review threads. */
const bigQuietPr = (n: number): PayloadPr => ({
  n,
  t: `Vendor parser ${n}`,
  a: 'alice',
  bot: 0,
  c: LAST - 5 * DAY,
  r: LAST - 5 * DAY,
  d: 0,
  m: LAST - 4 * DAY,
  x: LAST - 4 * DAY,
  s: 'MERGED',
  dr: 0,
  mb: 'alice',
  ad: 1000 + n,
  de: 0,
  cf: 3,
  ar: ['api'],
  cm: 0,
  th: 0,
  rc: 1,
  rv: [['bob', 'APPROVED', LAST - 4 * DAY - HOUR]],
  rq: [],
});

const texts = (root: ParentNode, sel: string): string[] =>
  [...root.querySelectorAll(sel)].map((n) => n.textContent ?? '');

const cellFor = (root: ParentNode, login: string): HTMLTableCellElement | undefined =>
  [...root.querySelectorAll<HTMLTableCellElement>('#app table td:first-child')].find(
    (td) => td.textContent === login,
  );

const cardNamed = (root: ParentNode, title: string): Element | undefined =>
  [...root.querySelectorAll('#app .card')].find(
    (c) => c.querySelector('h2')?.textContent === title,
  );

const heroValue = (root: ParentNode): string => root.querySelector('.tile .v')?.textContent ?? '';

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
  const cards = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('#brief .ins')];
  const grid = (): HTMLElement => {
    const node = root.querySelector<HTMLElement>('#brief-grid');
    expect(node).not.toBeNull();
    return node as HTMLElement;
  };
  const shown = (): number => cards().filter((c) => !c.hasAttribute('inert')).length;
  const firstCard = (): Element | null => root.querySelector('#app .card');

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
    expect(root.querySelectorAll('#app table').length).toBe(4);
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

  it('renders an empty snapshot with valid dates and zero counts', () => {
    setup({ ...payload(), prs: [] });
    expect(root.querySelector('#repo-sub')?.textContent).toBe('No pull requests in this snapshot');
    expect(heroValue(root)).toBe('0');
    click('all');
    expect(heroValue(root)).toBe('0');
    expect(root.textContent).not.toMatch(/Invalid Date|NaN|Infinity/);
  });

  it('measures recent activity and open-PR age at the snapshot time', () => {
    const data = payload();
    data.syncedAt = new Date(LAST).toISOString();
    data.prs = [
      {
        ...data.prs[0]!,
        c: LAST - 100 * DAY,
        r: LAST - 100 * DAY,
        m: null,
        x: null,
        s: 'OPEN',
        dr: 0,
        d: 0,
        rv: [],
        rq: [],
      },
    ];
    setup(data);
    expect(heroValue(root)).toBe('0');
    expect(briefText()).toContain('1 ready PR');
    expect(cardNamed(root, 'Oldest open PRs')?.textContent).toContain('3.3mo');
  });

  it('labels interrupted snapshots without claiming all open PRs are current', () => {
    setup({ ...payload(), interrupted: true, reconciledAt: '2026-01-01T00:00:00Z' });
    const warning = root.querySelector<HTMLElement>('#sync-warning');
    expect(warning?.hidden).toBe(false);
    expect(warning?.textContent).toMatch(/partial sync.*stale/i);
    expect(root.querySelector('#scope-note')?.textContent).toContain('Last complete sync');
    expect(root.querySelector('#scope-note')?.textContent).not.toContain('plus all open PRs');
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

  it('reads the last 7 days day by day', () => {
    setup();
    click('7');
    expect(pressed('7')).toBe('true');
    expect(handle?.range()).toBe('7');
    expect(texts(root, '.card > h2')).toEqual(CARD_TITLES);
    expect(root.querySelector('.card .desc')?.textContent).toContain('bucketed by UTC day');
    click('30');
    expect(root.querySelector('.card .desc')?.textContent).toContain('bucketed by ISO week');
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
      // Progress is the host page's job (a notice under the header); the
      // inline note stays hidden while the button shows it is busy.
      expect(note?.hidden).toBe(true);
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

  it('flags large PRs approved with no review threads, largest first', () => {
    const data = payload();
    setup({
      ...data,
      prs: [...data.prs, bigQuietPr(101), bigQuietPr(103), bigQuietPr(102)].toSorted(
        (a, b) => a.c - b.c,
      ),
    });
    const card = cards().find(
      (c) =>
        c.querySelector('h3')?.textContent ===
        '3 of 3 PRs over 1,000 lines were approved with no review threads',
    );
    expect(card?.querySelector('.ins-tag')?.textContent).toBe('Review depth');
    expect(card?.querySelector('.ins-flag')).not.toBeNull();
    expect(texts(card ?? root, '.ins-links li > a')).toEqual([
      '#103 Vendor parser 103',
      '#102 Vendor parser 102',
      '#101 Vendor parser 101',
    ]);
    expect(texts(card ?? root, '.ins-meta')[0]).toBe('alice · 1,103 lines');
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

  it('shows where the work moves by week, by month over all time, and around an area', async () => {
    setup();
    const heat = (): ParentNode => cardNamed(root, 'Where the work moves') ?? root;
    const rows = (): string[] => texts(heat(), 'svg text.blabel');
    const totals = (): string[] => texts(heat(), 'svg text.dlabel');
    click('90');
    await flush();
    expect(heat().querySelector('.desc')?.textContent).toMatch(/^Merged PRs per week/);
    // Too narrow to title every week: every other one, ending on the latest.
    const weeks = texts(heat(), 'svg text.tick:not(.blabel)');
    expect(weeks.slice(0, 3)).toEqual(['Week of', 'Jan 19', 'Feb 2']);
    expect(weeks.slice(-2)).toEqual(['Apr 13', 'Total']);
    expect(rows()).toEqual(['api', 'web']);
    expect(totals()).toEqual(['4', '3']);

    // Months over a whole history, each column titled with its month.
    click('all');
    await flush();
    expect(heat().querySelector('.desc')?.textContent).toMatch(/^Merged PRs per month/);
    expect(texts(heat(), 'svg text.tick:not(.blabel)')).toEqual([
      'Month',
      'Jan 2026',
      'Feb 2026',
      'Mar 2026',
      'Apr 2026',
      'Total',
    ]);
    expect(heat().querySelectorAll('svg rect')).toHaveLength(2 * 4);
    heat()
      .querySelector('svg rect')
      ?.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }));
    expect(root.querySelector('#tt')?.textContent).toMatch(/^api, Jan 2026Merged PRs2$/);

    // A selected area leads, followed by the areas its PRs also touched.
    const sel = root.querySelector<HTMLSelectElement>('#area-filter');
    if (!sel) throw new Error('no area filter');
    sel.value = 'web';
    sel.dispatchEvent(new Event('change'));
    await flush();
    expect(rows()).toEqual(['web', 'api']);
    expect(totals()).toEqual(['4', '1']);
    sel.value = 'docs';
    sel.dispatchEvent(new Event('change'));
    await flush();
    expect(heat().querySelector('.empty')?.textContent).toBe('No data in range');
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

  describe('links to GitHub', () => {
    it('links a contributor cell to the profile, leaving the text as the login', () => {
      setup();
      const cell = cellFor(root, 'alice');
      expect(cell).toBeDefined();
      const a = cell?.querySelector('a');
      expect(a?.getAttribute('href')).toBe('https://github.com/alice');
      expect(a?.getAttribute('target')).toBe('_blank');
      expect(a?.getAttribute('rel')).toBe('noopener');
      expect(cell?.textContent).toBe('alice');
    });

    it('leaves a bot author as plain text', () => {
      setup();
      click('all');
      const box = root.querySelector<HTMLInputElement>('#hide-bots');
      if (!box) throw new Error('no bots checkbox');
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      const cell = cellFor(root, 'dependabot[bot]');
      expect(cell).toBeDefined();
      expect(cell?.querySelector('a')).toBeNull();
    });

    it('links the author of an oldest open PR and the PR itself', () => {
      setup();
      const row = cardNamed(root, 'Oldest open PRs')?.querySelector('tbody tr');
      const pr = row?.querySelector<HTMLTableCellElement>('td:first-child a');
      expect(pr?.getAttribute('href')).toMatch(/^https:\/\/github\.com\/acme\/widgets\/pull\/\d+$/);
      expect(pr?.textContent).toMatch(/^#\d+ /);
      const author = row?.querySelector<HTMLTableCellElement>('td:nth-child(2)');
      expect(author?.querySelector('a')?.getAttribute('href')).toBe(
        `https://github.com/${author?.textContent ?? ''}`,
      );
    });

    it('keeps sorting on the login string behind the link', () => {
      setup();
      click('all');
      const table = root.querySelector('#app table');
      const head = [...(table?.querySelectorAll('th') ?? [])].find(
        (th) => th.textContent === 'Contributor',
      );
      head?.querySelector('button')?.click();
      head?.querySelector('button')?.click();
      const logins = [...(table?.querySelectorAll('tbody td:first-child') ?? [])].map(
        (td) => td.textContent,
      );
      expect(logins).toEqual(logins.toSorted((a, b) => (a ?? '').localeCompare(b ?? '')));
    });

    it('links people in the bar chart labels and the brief', async () => {
      setup();
      await flush();
      const svgLinks = [...root.querySelectorAll('#app svg a')].map((a) => a.getAttribute('href'));
      expect(svgLinks).toContain('https://github.com/carol');
      expect(root.querySelector('#brief p a[href="https://github.com/carol"]')?.textContent).toBe(
        'carol',
      );
    });

    it('links the heading to the repository', () => {
      setup();
      const a = root.querySelector('#repo-title a');
      expect(a?.getAttribute('href')).toBe('https://github.com/acme/widgets');
      expect(a?.getAttribute('rel')).toBe('noopener');
      expect(root.querySelector('#repo-title')?.textContent).toBe('acme/widgets');
    });
  });

  describe('brief disclosure', () => {
    afterEach(() => {
      localStorage.clear();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('starts collapsed on the first row of cards, with a real disclosure button', () => {
      layoutCards(3);
      setup();
      const toggle = root.querySelector<HTMLButtonElement>('.brief-toggle');
      expect(toggle?.tagName).toBe('BUTTON');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-controls')).toBe('brief-grid');
      expect(cards().length).toBe(8);
      expect(toggle?.textContent).toBe('Show 5 more');
      // The first row stays readable; the rest is clipped and inert behind the fade.
      expect(shown()).toBe(3);
      expect(cards().map((c) => c.hasAttribute('inert'))).toEqual([
        false,
        false,
        false,
        true,
        true,
        true,
        true,
        true,
      ]);
      expect(grid().dataset.clipped).toBe('');
      expect(grid().style.maxHeight).toBe('280px');
      expect(root.querySelector<HTMLElement>('#brief')?.dataset.expanded).toBe('0');
      // The summary sentence is gone: the cards themselves are the summary.
      expect(root.querySelector('.brief-summary')).toBeNull();
    });

    it('opens on click, shows every card, and remembers the choice', () => {
      vi.useFakeTimers();
      layoutCards(3);
      setup();
      root.querySelector<HTMLButtonElement>('.brief-toggle')?.click();
      expect(root.querySelector('.brief-toggle')?.getAttribute('aria-expanded')).toBe('true');
      expect(root.querySelector('.brief-toggle')?.textContent).toBe('Show less');
      expect(shown()).toBe(8);
      expect(root.querySelector<HTMLElement>('#brief')?.dataset.expanded).toBe('1');
      // The grid grows through the transition, then sizes itself again.
      vi.advanceTimersByTime(250);
      expect(grid().dataset.clipped).toBeUndefined();
      expect(grid().style.maxHeight).toBe('');
      expect(localStorage.getItem('bilan.brief.expanded')).toBe('1');
      handle?.destroy();
      handle = undefined;
      setup();
      expect(root.querySelector('.brief-toggle')?.getAttribute('aria-expanded')).toBe('true');
      expect(shown()).toBe(8);
      expect(grid().dataset.clipped).toBeUndefined();
    });

    it('closes again from the keyboard-operable button', () => {
      layoutCards(3);
      localStorage.setItem('bilan.brief.expanded', '1');
      setup();
      root.querySelector<HTMLButtonElement>('.brief-toggle')?.click();
      expect(root.querySelector('.brief-toggle')?.getAttribute('aria-expanded')).toBe('false');
      expect(shown()).toBe(3);
      expect(grid().dataset.clipped).toBe('');
      expect(grid().style.maxHeight).toBe('280px');
      expect(localStorage.getItem('bilan.brief.expanded')).toBe('0');
    });

    it('follows the grid when the window is resized', () => {
      vi.useFakeTimers();
      viewportWidth(1200);
      layoutCards(3);
      setup();
      expect(shown()).toBe(3);
      vi.restoreAllMocks();
      viewportWidth(800);
      layoutCards(2);
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(200);
      expect(shown()).toBe(2);
      expect(root.querySelector('.brief-toggle')?.textContent).toBe('Show 6 more');
      expect(grid().style.maxHeight).toBe('280px');
    });

    it('clips nothing when every card fits on one row', () => {
      layoutCards(8);
      setup();
      expect(shown()).toBe(8);
      expect(root.querySelector('.brief-toggle')?.textContent).toBe('Show more');
      expect(grid().dataset.clipped).toBeUndefined();
      expect(grid().style.maxHeight).toBe('');
    });
  });

  describe('under a scrolling reader', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('ignores a resize that only changes the height, as a phone toolbar does', () => {
      vi.useFakeTimers();
      viewportWidth(390);
      setup();
      const before = firstCard();
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(200);
      expect(firstCard()).toBe(before);
    });

    it('redraws once the width changes', () => {
      vi.useFakeTimers();
      viewportWidth(390);
      setup();
      const before = firstCard();
      vi.restoreAllMocks();
      viewportWidth(844);
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(200);
      expect(firstCard()).not.toBe(before);
      expect(texts(root, '.card > h2')).toEqual(CARD_TITLES);
    });

    it('keeps its height through a redraw until every chart is drawn', async () => {
      setup();
      await flush();
      const app = root.querySelector<HTMLElement>('#app') as HTMLElement;
      heightOf(app, 8000);
      const held = atChartLayout(() => app.style.minHeight);
      click('90');
      await flush();
      expect(held.length).toBeGreaterThanOrEqual(8);
      expect(new Set(held)).toEqual(new Set(['8000px']));
      expect(app.style.minHeight).toBe('');
    });

    it('lets a host keep its height through a remount until every chart is drawn', async () => {
      setup();
      await flush();
      heightOf(root, 9000);
      const held = atChartLayout(() => root.style.minHeight);
      holdHeight(root, () => {
        handle?.destroy();
        handle = mount(root, payload());
      });
      await flush();
      expect(held.length).toBeGreaterThanOrEqual(8);
      expect(new Set(held)).toEqual(new Set(['9000px']));
      expect(root.style.minHeight).toBe('');
    });
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
