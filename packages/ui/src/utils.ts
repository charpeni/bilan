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

export const fmtDate = (t: number): string =>
  new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const fmtDay = (t: number): string =>
  new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
