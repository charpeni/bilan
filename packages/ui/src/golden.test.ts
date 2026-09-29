/**
 * Guards the redesign: the dashboard's text (every figure, label, and note)
 * and every chart's geometry for a fixed payload are pinned to a golden file,
 * so a styling or chart-chrome change can never move a number, a scale, or a
 * mark. Colours, classes, opacity, and inline styles are left out on purpose:
 * those are what a design pass may change.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { fixturePayload } from './fixture.ts';
import { mount } from './index.ts';

import type { Mounted } from './mount.ts';

const GEOMETRY = [
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'width',
  'height',
  'd',
  'viewBox',
  'text-anchor',
];

/** Dates and numbers in one locale and zone, whatever the machine running the test. */
function pinLocale(): void {
  const date = Date.prototype.toLocaleDateString;
  const dateTime = Date.prototype.toLocaleString;
  const number = Number.prototype.toLocaleString;
  vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, _l, o) {
    return date.call(this, 'en-US', { ...o, timeZone: 'UTC' });
  });
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, _l, o) {
    return dateTime.call(this, 'en-US', { ...o, timeZone: 'UTC' });
  });
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, _l, o) {
    return number.call(this, 'en-US', o);
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** One line per chart element: its tag, its geometry, and its text. */
function geometry(root: ParentNode): string {
  const lines: string[] = [];
  for (const [i, svg] of [...root.querySelectorAll('#app svg')].entries()) {
    lines.push(`svg ${i} ${svg.getAttribute('aria-label') ?? ''}`);
    for (const node of svg.querySelectorAll('*')) {
      // Links inside labels (`<a>` in a `<text>`) carry no geometry of their own.
      if (node.tagName.toLowerCase() === 'a') continue;
      const attrs = GEOMETRY.filter((a) => node.hasAttribute(a)).map(
        (a) => `${a}=${node.getAttribute(a)}`,
      );
      const text = node.tagName.toLowerCase() === 'text' ? ` "${node.textContent}"` : '';
      lines.push(`  ${node.tagName.toLowerCase()} ${attrs.join(' ')}${text}`);
    }
  }
  return lines.join('\n');
}

/** Text as a reader meets it, whitespace runs collapsed. */
function readerText(root: HTMLElement): string {
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Mount the fixture (optionally on another range), let the charts draw, and read it all back. */
async function snapshot(range?: 'all'): Promise<string> {
  const root = document.createElement('div');
  document.body.append(root);
  const handle: Mounted = mount(root, fixturePayload(), { theme: 'light' });
  if (range) root.querySelector<HTMLButtonElement>(`[data-range="${range}"]`)?.click();
  await flush();
  const out = `TEXT\n${readerText(root)}\n\nGEOMETRY\n${geometry(root)}\n`;
  handle.destroy();
  root.remove();
  return out;
}

describe('golden dashboard', () => {
  // Local-time figures (merge hour, busiest day) follow `TZ`, pinned to UTC in vitest.config.ts.
  beforeAll(pinLocale);
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('keeps every figure, label, and chart mark of the default view', async () => {
    await expect(await snapshot()).toMatchFileSnapshot('./__golden__/dashboard-30d.txt');
  });

  it('keeps every figure, label, and chart mark of the all-time view', async () => {
    await expect(await snapshot('all')).toMatchFileSnapshot('./__golden__/dashboard-all.txt');
  });
});
