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
  /** Range pressed at mount; falls back to `'30'` when omitted or not covered by the payload. */
  initialRange?: Range;
  /**
   * Called when a range the payload does not cover is clicked; the host is
   * expected to sync deeper and mount again. Without it, the dashboard shows a
   * note explaining how to re-sync from the CLI.
   */
  onLoadMore?: (range: Range) => void;
}

export interface Mounted {
  destroy(): void;
}

/** The static shell: same ids and classes as the original report body. */
const SHELL = `<div class="wrap">
  <header class="page">
    <div>
      <h1 id="repo-title">Repository dashboard</h1>
      <div class="sub" id="repo-sub"></div>
    </div>
    <div class="spacer"></div>
    <div class="seg" role="group" aria-label="Theme">
      <button data-theme-set="auto" aria-pressed="true">Auto</button>
      <button data-theme-set="light" aria-pressed="false">Light</button>
      <button data-theme-set="dark" aria-pressed="false">Dark</button>
    </div>
  </header>

  <section class="brief" id="brief" aria-label="Last 30 days at a glance"></section>

  <div class="filters">
    <div class="seg" role="group" aria-label="Date range">
      <button data-range="30" aria-pressed="false">Last 30 days</button>
      <button data-range="90" aria-pressed="false">Last 90 days</button>
      <button data-range="180" aria-pressed="false">Last 180 days</button>
      <button data-range="all" aria-pressed="false">All time</button>
    </div>
    <select class="dim" id="area-filter" aria-label="Area"></select>
    <select class="dim" id="person-filter" aria-label="Contributor"></select>
    <label class="check"><input type="checkbox" id="hide-bots" checked> Exclude bots</label>
    <span class="note load-note" id="load-note" role="status" hidden></span>
    <span class="note" id="scope-note"></span>
  </div>

  <main id="app"></main>
</div>
<div class="tt" id="tt" role="tooltip"></div>`;

export function mount(root: HTMLElement, payload: Payload, options: MountOptions = {}): Mounted {
  const theme: Theme = options.theme ?? 'auto';
  root.innerHTML = SHELL;

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
  must('#repo-sub').textContent =
    `Pull request activity from ${fmtDate(firstActivity(prs))} to ${fmtDate(last)}`;

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

  // Ranges the payload cannot back stay clickable but say so, and never become active.
  const loadNote = must<HTMLElement>('#load-note');
  const rangeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-range]')];
  for (const b of rangeButtons) {
    const range = b.dataset.range;
    if (!isRange(range)) continue;
    if (covered(range)) {
      b.classList.remove('needs-load');
      b.removeAttribute('aria-disabled');
      b.removeAttribute('title');
    } else {
      b.classList.add('needs-load');
      b.setAttribute('aria-disabled', 'true');
      b.title = 'Load more history';
    }
  }
  const setRange = (range: Range): void => {
    state.range = covered(range) ? range : DEFAULT_RANGE;
    press(state.range, 'data-range');
    draw();
  };
  const requestMore = (range: Range): void => {
    if (options.onLoadMore) {
      options.onLoadMore(range);
      return;
    }
    const since = rangeSinceDate(range, last);
    const cmd = `bilan ${payload.repo}`;
    loadNote.textContent =
      since === null
        ? `Not synced yet. Re-run \`${cmd} --full\`.`
        : `Not synced yet. Re-run \`${cmd} --since ${since}\` or \`${cmd} --full\`.`;
    loadNote.hidden = false;
  };
  for (const b of rangeButtons) {
    b.addEventListener('click', () => {
      const range = b.dataset.range;
      if (!isRange(range)) return;
      if (!covered(range)) {
        requestMore(range);
        return;
      }
      loadNote.hidden = true;
      setRange(range);
    });
  }
  press(state.range, 'data-range');
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-theme-set]')) {
    b.addEventListener('click', () => {
      const v = b.dataset.themeSet ?? 'auto';
      html.dataset.theme = v;
      press(v, 'data-theme-set');
      draw();
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

  renderBrief(ctx);
  draw();

  return {
    destroy(): void {
      clearTimeout(resizeTimer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      mq.removeEventListener('change', onScheme);
      if (prevTheme === undefined) delete html.dataset.theme;
      else html.dataset.theme = prevTheme;
      root.textContent = '';
    },
  };
}
