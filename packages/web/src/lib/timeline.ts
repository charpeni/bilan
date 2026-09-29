import { HOUR } from '@bilan/core';

import type { Headline } from '@bilan/core';

export interface TimelineFigure {
  /** Where ready for review falls, as a percentage of the axis. */
  ready: number;
  /** Widths of the two measured spans, from ready, as percentages of the axis. */
  first: number;
  merge: number;
  draftMs: number;
  firstMs: number;
  mergeMs: number;
  /** Axis ticks in hours from ready for review. */
  ticks: { at: number; label: string }[];
}

const STEPS = [1, 2, 3, 6, 12, 24, 48, 72, 168];

/**
 * The landing page's "where review time starts" figure, from a headline's
 * medians: time in draft before the anchor, then time to first review and time
 * to merge measured from it, on one linear axis. Each median comes from its
 * own set of PRs, so the figure is a composite and says so. Null when either
 * measured median is missing.
 */
export function timelineFigure(h: Headline): TimelineFigure | null {
  if (h.medFirst === null || h.medMerge === null) return null;
  const draftMs = h.medReady ?? 0;
  const span = Math.max(h.medFirst, h.medMerge);
  const total = draftMs + span;
  if (total <= 0) return null;
  const pct = (ms: number): number => Math.round((ms / total) * 10000) / 100;
  const hours = span / HOUR;
  const step = STEPS.find((s) => hours / s <= 4) ?? 168;
  const ticks: TimelineFigure['ticks'] = [];
  for (let t = 0; t * HOUR <= span; t += step) {
    ticks.push({ at: pct(draftMs + t * HOUR), label: t === 0 ? '0h' : `${t}h` });
  }
  return {
    ready: pct(draftMs),
    first: pct(h.medFirst),
    merge: pct(h.medMerge),
    draftMs,
    firstMs: h.medFirst,
    mergeMs: h.medMerge,
    ticks,
  };
}
