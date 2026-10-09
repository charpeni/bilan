import { DAY, HOUR } from '@bilan/core';

export { DAY, HOUR };

export type AttrValue = string | number | null | undefined;
export type Kid = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  kids: Kid | Kid[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v === null || v === undefined ? '' : String(v);
    else if (k === 'class') node.className = String(v);
    else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const kid of Array.isArray(kids) ? kids : [kids]) node.append(kid);
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}

export const num = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString();

/** `1 author`, `3 authors`: a count with its noun, English plural by `s`. */
export const plural = (n: number, noun: string): string =>
  `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

export const pctFmt = (v: number | null): string =>
  v === null || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}%`;

export const compact = (v: number | null): string =>
  v === null
    ? '—'
    : Math.abs(v) >= 1e6
      ? `${(v / 1e6).toFixed(1)}M`
      : Math.abs(v) >= 1e4
        ? `${(v / 1e3).toFixed(0)}K`
        : Math.round(v).toLocaleString();

/** Durations read as "2.4d" / "5h" / "18m" — compact enough for table columns. */
export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 60e3) return '<1m';
  if (ms < HOUR) return `${Math.round(ms / 60e3)}m`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(ms < 10 * HOUR ? 1 : 0)}h`;
  if (ms < 30 * DAY) return `${(ms / DAY).toFixed(ms < 10 * DAY ? 1 : 0)}d`;
  return `${(ms / (30 * DAY)).toFixed(1)}mo`;
}

/**
 * A folder path cut to `chars` characters, as `[folders, name]`: leading
 * folders give way to `…/` first, so the distinctive end of the path stays.
 */
export function fitPath(path: string, chars: number): [string, string] {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  for (let k = 0; k <= parts.length; k++) {
    const dir =
      (k ? '…/' : '') +
      parts
        .slice(k)
        .map((p) => `${p}/`)
        .join('');
    if (dir.length + name.length <= chars) return [dir, name];
  }
  return ['', name.length <= chars ? name : `${name.slice(0, Math.max(1, chars - 1))}…`];
}

export const fmtDate = (t: number): string =>
  new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Periods are UTC buckets, so they are named in UTC: `Sep`, `Sep 2026`, `Sep 14, 2026`. */
export const fmtUtc = (t: number, options: Intl.DateTimeFormatOptions): string =>
  new Date(t).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });

export const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Run `rebuild`, which empties `node` and fills it again, with `node` held at
 * its current height until the charts `rebuild` queued are drawn. Charts read
 * their width as they draw, which lays out the half-built page; were it shorter
 * for that moment, the browser would clamp the scroll position to it and keep
 * it once the page grew back, throwing the reader up the page.
 */
export function holdHeight(node: HTMLElement, rebuild: () => void): void {
  const prev = node.style.minHeight;
  node.style.minHeight = `${node.offsetHeight}px`;
  try {
    rebuild();
  } finally {
    // Charts draw in microtasks queued by `rebuild`, so this one runs after them.
    queueMicrotask(() => {
      node.style.minHeight = prev;
    });
  }
}
