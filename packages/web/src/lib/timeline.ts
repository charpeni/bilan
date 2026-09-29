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

/* ---- drawing the figure in ---- */

/** The baseline draws first, over this long. */
export const TIMELINE_BASELINE_MS = 360;
/** Each event mark waits this much longer than the one before it. */
export const TIMELINE_STAGGER_MS = 120;
/** How long one event mark takes to appear. */
export const TIMELINE_MARK_MS = 320;
/** The anchor lands last, with a little more time to settle. */
export const TIMELINE_ANCHOR_MS = 400;
/** The whole draw-in stays under this. */
export const TIMELINE_MAX_MS = 1200;

export interface TimelineStep {
  /** `baseline`, an event name, or `anchor`. */
  name: string;
  /** Milliseconds after the figure comes into view. */
  delay: number;
  /** How long this step's transition runs. */
  duration: number;
}

/**
 * When each part of the figure appears: the baseline first, then the event
 * marks in the order given (chronological: opened, ready, first review,
 * merged), each a short stagger after the last and starting while the
 * baseline is still drawing so the whole thing stays brisk; the "[" anchor
 * lands last. With `reduceMotion` every step is immediate.
 */
export function timelineSteps(events: readonly string[], reduceMotion = false): TimelineStep[] {
  if (reduceMotion) {
    return ['baseline', ...events, 'anchor'].map((name) => ({ name, duration: 0, delay: 0 }));
  }
  const firstMark = TIMELINE_BASELINE_MS / 2;
  const marks = events.map((name, i) => ({
    name,
    delay: firstMark + i * TIMELINE_STAGGER_MS,
    duration: TIMELINE_MARK_MS,
  }));
  const last = marks.at(-1);
  const anchorAt = (last ? last.delay : firstMark) + TIMELINE_STAGGER_MS * 2;
  return [
    { name: 'baseline', delay: 0, duration: TIMELINE_BASELINE_MS },
    ...marks,
    { name: 'anchor', delay: anchorAt, duration: TIMELINE_ANCHOR_MS },
  ];
}

/** When the last step ends. */
export const timelineTotal = (steps: readonly TimelineStep[]): number =>
  Math.max(0, ...steps.map((s) => s.delay + s.duration));
