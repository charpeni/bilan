import { change } from '@bilan/core';

import { canCompare, comparisonRange } from './range.ts';
import { DAY, dur, el, fmtUtc, num } from './utils.ts';

import type { DashboardContext } from './state.ts';

export type ComparisonKind = 'count' | 'speed' | 'duration';

const date = (t: number): string => fmtUtc(t, { month: 'short', day: 'numeric', year: 'numeric' });

/** The selected stats need their own period label beneath the fixed 30-day insights. */
export function periodComparison(ctx: DashboardContext): HTMLElement {
  const { data, last, state, requestMore } = ctx;
  const row = el('div', { class: 'period-comparison' });
  if (state.range === 'all') {
    row.append(el('p', { class: 'desc', text: 'All time · no previous period' }));
    return row;
  }
  const days = Number(state.range);
  const from = last - days * DAY;
  const before = from - days * DAY;
  const compare = !data.interrupted && canCompare(data.coverageSince, last, state.range);
  row.append(
    el('p', {
      class: 'desc',
      text:
        `Last ${days} days: ${date(from)} – ${date(last)}` +
        (compare
          ? `, compared with the previous ${days} days (${date(before)} – ${date(from)})`
          : '') +
        ' (UTC).',
      title:
        `Current: (${new Date(from).toISOString()}, ${new Date(last).toISOString()}]` +
        (compare
          ? `; previous: (${new Date(before).toISOString()}, ${new Date(from).toISOString()}]`
          : ''),
    }),
  );
  if (compare) return row;
  row.append(
    el('p', {
      class: 'desc',
      text: data.interrupted
        ? 'Comparisons are unavailable during a partial sync. Refresh to finish syncing.'
        : `Comparisons appear once ${days * 2} days are synced.`,
    }),
  );
  if (data.interrupted) return row;
  if (requestMore) {
    const depth = comparisonRange(state.range);
    const button = el('button', {
      type: 'button',
      class: 'period-load',
      'data-load-range': depth,
      text: depth === 'all' ? 'Sync full history to compare' : 'Sync more history to compare',
    });
    button.addEventListener('click', () => requestMore(depth, true));
    row.append(button);
  } else {
    const since = new Date(before - DAY).toISOString().slice(0, 10);
    row.append(el('code', { text: `bilan ${data.repo} --since ${since}` }));
  }
  return row;
}

/** Missing samples and a zero baseline never turn into an infinite change. */
export function comparisonText(
  now: number | null,
  before: number | null,
  kind: ComparisonKind,
): string {
  const fmt = kind === 'count' ? num : dur;
  if (before === null) return now === null ? 'No data in either period' : 'No previous data';
  const previous = `was ${fmt(before)}`;
  if (now === null) return `No current data · ${previous}`;
  const delta = change(now, before);
  if (delta === null) return kind === 'count' ? `New · ${previous}` : previous;
  if (delta === 0) return `No change · ${previous}`;
  if (kind === 'count') return `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta)}% · ${previous}`;
  const direction =
    kind === 'speed' ? (delta < 0 ? 'faster' : 'slower') : delta < 0 ? 'shorter' : 'longer';
  return `${Math.abs(delta)}% ${direction} · ${previous}`;
}
