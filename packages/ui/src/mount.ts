import { createFilterState, derive, filterOptions, firstActivity, lastActivity } from '@bilan/core';

import { renderBrief } from './brief.ts';
import { DEFAULT_RANGE, isCovered, isRange, rangeSinceDate } from './range.ts';
import { render } from './render.ts';
import { createTooltip } from './tooltip.ts';
import { el, fmtDate } from './utils.ts';

import type { Range } from './range.ts';
import type { DashboardContext } from './state.ts';
import type { Payload } from '@bilan/core';

export type Theme = 'auto' | 'light' | 'dark';
export type { Range } from './range.ts';

export interface MountOptions {
  theme?: Theme;
  /**
   * Render the dashboard's own Auto/Light/Dark control. Defaults to true (the
   * standalone CLI report); a host page that carries its own theme control
   * passes false. Either way the dashboard redraws when `data-theme` changes.
   */
  themeControl?: boolean;
  /** Range pressed at mount; falls back to `'30'` when omitted or not covered by the payload. */
  initialRange?: Range;
  /**
   * Called when a range the payload does not cover is clicked; the host is
   * expected to sync deeper and mount again. Without it, the dashboard shows a
   * note explaining how to re-sync from the CLI. When it returns a promise the
   * range button stays busy until it settles, and a rejection is shown next to
   * the range buttons (with a link when it is a `LoadMoreError` carrying one).
   */
  onLoadMore?: (range: Range) => void | Promise<void>;
}

export interface Mounted {
  /** The range on screen, so a host that mounts again can keep it. */
  range(): Range;
  /** Replace the text beside the range buttons while a load is running (progress from the host). */
  status(text: string): void;
  destroy(): void;
}

/** A failed load the dashboard can offer a way out of, e.g. "Sign in again". */
export class LoadMoreError extends Error {
  readonly action: { label: string; href: string } | undefined;
  constructor(message: string, action?: { label: string; href: string }) {
    super(message);
    this.name = 'LoadMoreError';
    this.action = action;
  }
}

/** What the busy note says while the host syncs `range`. */
export const loadingText = (range: Range): string =>
  range === 'all' ? 'Syncing the full history…' : `Syncing the last ${range} days…`;

const THEME_SEG = `<div class="seg" role="group" aria-label="Theme">
      <button type="button" data-theme-set="auto" aria-pressed="true">Auto</button>
      <button type="button" data-theme-set="light" aria-pressed="false">Light</button>
      <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
    </div>`;

/** The static shell: same ids and classes as the original report body. */
const shell = (themeControl: boolean): string => `<div class="wrap">
  <header class="page">
    <div>
      <h1 id="repo-title">Repository dashboard</h1>
      <div class="sub" id="repo-sub"></div>
    </div>
    <div class="spacer"></div>
    ${themeControl ? THEME_SEG : ''}
  </header>

  <section class="brief" id="brief" aria-label="Last 30 days at a glance"></section>

  <div class="filters">
    <div class="seg range-seg" role="group" aria-label="Date range">
      <button type="button" data-range="30" aria-pressed="false"><span class="rl">Last </span>30 days</button>
      <button type="button" data-range="90" aria-pressed="false"><span class="rl">Last </span>90 days</button>
      <button type="button" data-range="180" aria-pressed="false"><span class="rl">Last </span>180 days</button>
      <button type="button" data-range="all" aria-pressed="false">All time</button>
    </div>
    <select class="dim" id="area-filter" aria-label="Area"></select>
    <select class="dim" id="person-filter" aria-label="Contributor"></select>
    <label class="check"><input type="checkbox" id="hide-bots" checked> Exclude bots</label>
    <span class="note load-note" id="load-note" role="status" aria-live="polite" hidden></span>
    <span class="note" id="scope-note"></span>
    <span class="sr-only" id="load-desc"></span>
  </div>

  <main id="app"></main>
</div>
<div class="tt" id="tt" role="tooltip"></div>`;

export function mount(root: HTMLElement, payload: Payload, options: MountOptions = {}): Mounted {
  const theme: Theme = options.theme ?? 'auto';
  root.innerHTML = shell(options.themeControl ?? true);

  const must = <T extends Element>(sel: string): T => {
    const node = root.querySelector<T>(sel);
    if (!node) throw new Error(`bilan-ui: missing ${sel}`);
    return node;
  };

  const prs = derive(payload.prs);
  const ctx: DashboardContext = {
    root,
    data: payload,
    prs,
    bots: new Set(payload.bots),
    last: lastActivity(prs),
    state: createFilterState(),
    tip: createTooltip(must<HTMLElement>('#tt')),
  };
  const { state, bots, last } = ctx;
  const covered = (range: Range): boolean => isCovered(payload.coverageSince, last, range);
  state.range =
    options.initialRange !== undefined && covered(options.initialRange)
      ? options.initialRange
      : DEFAULT_RANGE;

  const html = document.documentElement;
  const prevTheme = html.dataset.theme;
  html.dataset.theme = theme;

  /* ---- wiring ---- */
  must('#repo-title').textContent = payload.repo;
  must('#repo-sub').textContent = activitySpan(payload.coverageSince, firstActivity(prs), last);

  // Populate the dimension filters from the data itself.
  const areaSel = must<HTMLSelectElement>('#area-filter');
  const personSel = must<HTMLSelectElement>('#person-filter');
  const hideBots = must<HTMLInputElement>('#hide-bots');
  {
    const opts = filterOptions(prs, bots);
    areaSel.append(el('option', { value: '', text: 'All areas' }));
    for (const [a, n] of opts.areas) {
      areaSel.append(el('option', { value: a, text: `${a} (${n})` }));
    }
    personSel.append(el('option', { value: '', text: 'Everyone' }));
    for (const who of opts.people) personSel.append(el('option', { value: who, text: who }));
  }

  const press = (value: string, attr: string): void => {
    for (const b of root.querySelectorAll(`[${attr}]`)) {
      b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
    }
  };
  press(theme, 'data-theme-set');

  const draw = (): void => render(ctx);

  // Ranges the payload cannot back stay clickable and say so (a "+" and a
  // description), but never become the active range until the host loads them.
  const loadNote = must<HTMLElement>('#load-note');
  const loadDesc = must<HTMLElement>('#load-desc');
  loadDesc.textContent = options.onLoadMore
    ? 'Not synced yet. Selecting it syncs more history.'
    : 'Not in this report. Re-run the CLI to include it.';
  const rangeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-range]')];
  for (const b of rangeButtons) {
    const range = b.dataset.range;
    if (!isRange(range) || covered(range)) continue;
    b.classList.add('needs-load');
    b.title = options.onLoadMore
      ? 'Not synced yet: click to sync more history'
      : 'Not in this report';
    b.setAttribute('aria-describedby', 'load-desc');
    b.append(el('span', { class: 'load-mark', 'aria-hidden': 'true', text: '+' }));
  }
  const setRange = (range: Range): void => {
    state.range = covered(range) ? range : DEFAULT_RANGE;
    press(state.range, 'data-range');
    draw();
  };

  /** Show `text` beside the range buttons; an action link is appended when given. */
  const note = (text: string, kind?: 'busy' | 'error', action?: LoadMoreError['action']): void => {
    loadNote.textContent = text;
    if (kind) loadNote.dataset.kind = kind;
    else delete loadNote.dataset.kind;
    if (action) {
      loadNote.append(' ', el('a', { href: action.href, text: action.label }));
    }
    loadNote.hidden = false;
  };
  let loading: Range | null = null;
  const setBusy = (range: Range | null): void => {
    loading = range;
    for (const b of root.querySelectorAll<HTMLElement>('[data-load-range]')) {
      if (range !== null && b.dataset.loadRange === range) b.setAttribute('aria-busy', 'true');
      else b.removeAttribute('aria-busy');
    }
  };
  let destroyed = false;
  const requestMore = (range: Range): void => {
    if (options.onLoadMore) {
      if (loading !== null) return;
      const pending = options.onLoadMore(range);
      if (!(pending instanceof Promise)) return;
      setBusy(range);
      note(loadingText(range), 'busy');
      pending.then(
        () => {
          if (destroyed) return;
          setBusy(null);
          loadNote.hidden = true;
        },
        (error: unknown) => {
          if (destroyed) return;
          setBusy(null);
          const message = error instanceof Error ? error.message : String(error);
          note(message, 'error', error instanceof LoadMoreError ? error.action : undefined);
        },
      );
      return;
    }
    const since = rangeSinceDate(range, last);
    const cmd = `bilan ${payload.repo}`;
    note(
      since === null
        ? `Not synced yet. Re-run \`${cmd} --full\`.`
        : `Not synced yet. Re-run \`${cmd} --since ${since}\` or \`${cmd} --full\`.`,
    );
  };
  ctx.requestMore = options.onLoadMore ? requestMore : undefined;
  for (const b of rangeButtons) {
    const range = b.dataset.range;
    if (isRange(range) && !covered(range)) b.dataset.loadRange = range;
    b.addEventListener('click', () => {
      if (!isRange(range)) return;
      if (!covered(range)) {
        requestMore(range);
        return;
      }
      if (loading === null) loadNote.hidden = true;
      setRange(range);
    });
  }
  press(state.range, 'data-range');
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-theme-set]')) {
    b.addEventListener('click', () => {
      const v = b.dataset.themeSet ?? 'auto';
      html.dataset.theme = v;
    });
  }
  areaSel.addEventListener('change', () => {
    state.area = areaSel.value;
    draw();
  });
  personSel.addEventListener('change', () => {
    state.person = personSel.value;
    draw();
  });
  hideBots.addEventListener('change', () => {
    state.hideBots = hideBots.checked;
    draw();
  });

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 180);
  };
  const onScheme = (): void => {
    if (html.dataset.theme === 'auto') draw();
  };
  const onScroll = (): void => ctx.tip.hide();
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  mq.addEventListener('change', onScheme);
  // Charts read colour tokens when drawn, so any theme switch (this control or
  // the host page's) redraws them.
  let shownTheme: string | undefined = html.dataset.theme;
  const themeObserver = new MutationObserver(() => {
    const next = html.dataset.theme;
    if (next === shownTheme) return;
    shownTheme = next;
    press(next ?? 'auto', 'data-theme-set');
    draw();
  });
  themeObserver.observe(html, { attributes: true, attributeFilter: ['data-theme'] });

  renderBrief(ctx);
  draw();

  return {
    range: (): Range => (isRange(state.range) ? state.range : DEFAULT_RANGE),
    status(text: string): void {
      if (loading !== null) note(text, 'busy');
    },
    destroy(): void {
      destroyed = true;
      clearTimeout(resizeTimer);
      themeObserver.disconnect();
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      mq.removeEventListener('change', onScheme);
      if (prevTheme === undefined) delete html.dataset.theme;
      else html.dataset.theme = prevTheme;
      root.textContent = '';
    },
  };
}

/**
 * The header's one-line span. A bounded sync also carries every open PR, some
 * of them far older than the coverage, so the span starts at the coverage
 * bound rather than at the oldest PR, and says the older open ones are in.
 */
export function activitySpan(coverageSince: string | null, first: number, last: number): string {
  const since = coverageSince === null ? Number.NaN : Date.parse(coverageSince);
  if (Number.isNaN(since) || since <= first) {
    return `Pull request activity from ${fmtDate(first)} to ${fmtDate(last)}`;
  }
  return `Pull request activity from ${fmtDate(since)} to ${fmtDate(last)}, plus older open PRs`;
}
