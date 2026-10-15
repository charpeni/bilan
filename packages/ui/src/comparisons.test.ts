import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DAY, HOUR, LAST, fixturePayload } from './fixture.ts';
import { mount } from './mount.ts';

import type { Mounted } from './mount.ts';
import type { Payload, PayloadPr } from '@bilan/core';

/** Two periods with different review times, two areas, and bot activity in both. */
function data(coverageSince: string | null = null): Payload {
  const payload = fixturePayload(coverageSince);
  const template = payload.prs[0]!;
  const pr = (n: number, author: string, area: string, days: number, hours: number): PayloadPr => {
    const c = LAST - days * DAY;
    return {
      ...template,
      n,
      a: author,
      bot: author === 'dependabot[bot]' ? 1 : 0,
      ar: [area],
      c,
      r: c,
      m: c + 2 * DAY,
      x: c + 2 * DAY,
      rv: [[author === 'bob' ? 'alice' : 'bob', 'APPROVED', c + hours * HOUR]],
    };
  };
  payload.syncedAt = new Date(LAST).toISOString();
  payload.prs = [
    pr(1, 'alice', 'api', 3, 6),
    pr(2, 'alice', 'api', 10, 9),
    pr(3, 'bob', 'web', 4, 12),
    pr(4, 'bob', 'web', 11, 24),
    pr(5, 'dependabot[bot]', 'api', 5, 1),
    pr(6, 'dependabot[bot]', 'api', 12, 1),
  ];
  for (const p of payload.prs.filter((item) => item.a === 'alice')) {
    p.rv.push(['dependabot[bot]', 'COMMENTED', p.c + 13 * HOUR]);
  }
  return payload;
}

describe('selected-period comparisons', () => {
  let root: HTMLElement;
  let handle: Mounted;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => {
    handle?.destroy();
    root.remove();
  });
  const select = (id: string, value: string): void => {
    const node = root.querySelector<HTMLSelectElement>(`#${id}`)!;
    node.value = value;
    node.dispatchEvent(new Event('change'));
  };
  const tile = (label: string): Element =>
    [...root.querySelectorAll('.tile')].find(
      (node) => node.querySelector('.k')?.textContent === label,
    )!;
  const brief = (): string => root.querySelector('#brief')?.textContent ?? '';
  const comparison = (): string => root.querySelector('.period-comparison')?.textContent ?? '';
  const range = (value: string): void =>
    root.querySelector<HTMLButtonElement>(`[data-range="${value}"]`)!.click();

  it('keeps insights above the controls and stats below them', () => {
    handle = mount(root, data(), { initialRange: '7' });
    const sections = [...root.querySelector('.wrap')!.children];
    expect(sections.indexOf(root.querySelector('#brief')!)).toBeLessThan(
      sections.indexOf(root.querySelector('.filters')!),
    );
    expect(sections.indexOf(root.querySelector('.filters')!)).toBeLessThan(
      sections.indexOf(root.querySelector('#app')!),
    );
    expect(brief()).toContain('Last 30 days at a glance');
  });

  it('compares 7 days using a default 30-day sync and labels the actual dates', () => {
    handle = mount(root, data(new Date(LAST - 30 * DAY).toISOString()), { initialRange: '7' });
    expect(brief()).toContain('Last 30 days at a glance');
    expect(brief()).toContain('4 opened by 2 authors');
    expect(comparison()).toContain('Last 7 days:');
    expect(comparison()).toContain('compared with the previous 7 days');
    expect(tile('PRs opened').querySelector('.delta')?.textContent).toBe('No change · was 2');
    expect(tile('Median time to first review').querySelector('.delta')?.textContent).toBe(
      '45% faster · was 17h',
    );
    expect(tile('Median time to first review').querySelector('.d')?.textContent).toBe(
      '2/2 reviewed · was 2/2 reviewed',
    );
    const bounds = root.querySelector('.period-comparison > .desc')?.getAttribute('title');
    for (const days of [0, 7, 14])
      expect(bounds).toContain(new Date(LAST - days * DAY).toISOString());
    range('30');
    expect(brief()).toContain('Last 30 days at a glance');
    expect(comparison()).toContain('Comparisons appear once 60 days are synced.');
    expect([...root.querySelectorAll('.delta')].every((n) => n.textContent === '')).toBe(true);
  });

  it('applies filters to both stats periods while keeping the 30-day insights unchanged', () => {
    handle = mount(root, data(), { initialRange: '7' });
    const initialBrief = brief();
    select('area-filter', 'api');
    expect(tile('Median time to first review').querySelector('.delta')?.textContent).toBe(
      '33% faster · was 9.0h',
    );
    expect(brief()).toBe(initialBrief);
    select('person-filter', 'bob');
    expect(tile('PRs opened').querySelector('.v')?.textContent).toBe('0');
    // Bob reviewed Alice's PRs in both periods despite authoring none in this area.
    expect(tile('Reviews given').querySelector('.v')?.textContent).toBe('1');
    expect(tile('Reviews given').querySelector('.delta')?.textContent).toBe('No change · was 1');
    expect(brief()).toBe(initialBrief);
  });

  it('includes bot authors and reviews in both periods only when selected', () => {
    handle = mount(root, data(), { initialRange: '7' });
    expect(tile('PRs opened').querySelector('.v')?.textContent).toBe('2');
    expect(tile('Reviews given').querySelector('.v')?.textContent).toBe('2');
    const checkbox = root.querySelector<HTMLInputElement>('#hide-bots')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(tile('PRs opened').querySelector('.v')?.textContent).toBe('3');
    expect(tile('PRs opened').querySelector('.delta')?.textContent).toBe('No change · was 3');
    expect(tile('Reviews given').querySelector('.v')?.textContent).toBe('4');
    expect(tile('Reviews given').querySelector('.delta')?.textContent).toBe('No change · was 4');
    expect(brief()).toContain('4 opened by 2 authors');
    expect(brief()).toContain('Bots excluded except under Automation.');
    expect(tile('PRs opened').querySelector('.delta')?.hasAttribute('data-trend')).toBe(false);
  });

  it.each(['30', '90', '180'] as const)('follows the %s-day range', (value) => {
    handle = mount(root, data());
    const initialBrief = brief();
    range(value);
    expect(brief()).toBe(initialBrief);
    expect(comparison()).toContain(`Last ${value} days:`);
    expect(comparison()).toContain(`compared with the previous ${value} days`);
    expect(tile('PRs opened').querySelector('.delta')?.textContent).toBe('New · was 0');
  });

  it('shows all-time totals without a previous period or a sync prompt', () => {
    handle = mount(root, data(), { initialRange: 'all' });
    expect(brief()).toContain('Last 30 days at a glance');
    expect(comparison()).toBe('All time · no previous period');
    expect(root.querySelector('.period-load')).toBeNull();
    expect(tile('PRs opened').querySelector('.v')?.textContent).toBe('4');
    expect(tile('PRs opened').querySelector('.delta')?.textContent).toBe('');
  });

  it('suppresses comparisons on interrupted snapshots, even with full history', () => {
    handle = mount(root, { ...data(), interrupted: true }, { initialRange: '7' });
    expect(comparison()).toContain('Comparisons are unavailable during a partial sync.');
    expect(brief()).not.toContain('compared with');
    expect(tile('PRs opened').querySelector('.delta')?.textContent).toBe('');
  });

  it('asks for comparison history without changing the selection and restores it on remount', () => {
    const onLoadMore = vi.fn();
    handle = mount(root, data(new Date(LAST - 30 * DAY).toISOString()), { onLoadMore });
    select('area-filter', 'api');
    select('person-filter', 'alice');
    root.querySelector<HTMLButtonElement>('.period-load')!.click();
    expect(onLoadMore).toHaveBeenCalledWith('90', { preserveRange: true });
    const selection = handle.filters();
    expect(selection).toEqual({ range: '30', area: 'api', person: 'alice', hideBots: true });
    handle.destroy();
    handle = mount(root, data(), { initialFilters: selection });
    expect(handle.filters()).toEqual(selection);
    expect(root.querySelector<HTMLSelectElement>('#area-filter')?.value).toBe('api');
    expect(root.querySelector<HTMLSelectElement>('#person-filter')?.value).toBe('alice');
    expect(comparison()).toContain('compared with the previous 30 days');
  });
});
