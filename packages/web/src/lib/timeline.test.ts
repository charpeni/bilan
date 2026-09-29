import { HOUR } from '@bilan/core';
import { describe, expect, it } from 'vitest';

import {
  TIMELINE_ANCHOR_MS,
  TIMELINE_BASELINE_MS,
  TIMELINE_MAX_MS,
  TIMELINE_STAGGER_MS,
  timelineFigure,
  timelineSteps,
  timelineTotal,
} from './timeline.ts';

import type { Headline } from '@bilan/core';

const base: Headline = {
  opened: 10,
  authors: 3,
  merged: 8,
  mergedShare: 0.8,
  rejected: 2,
  stillOpen: 1,
  medMerge: 20 * HOUR,
  p90Merge: 40 * HOUR,
  medFirst: 2 * HOUR,
  reviewedShare: 0.9,
  medReady: 5 * HOUR,
  draftShare: 0.3,
  reviews: 12,
  reviewers: 4,
};

describe('timelineFigure', () => {
  it('puts the anchor after the draft and measures both spans from it', () => {
    const f = timelineFigure(base);
    expect(f).not.toBeNull();
    // 5h draft + 20h to merge = 25h axis.
    expect(f?.ready).toBe(20);
    expect(f?.first).toBe(8);
    expect(f?.merge).toBe(80);
    expect(f?.ticks.map((t) => t.label)).toEqual(['0h', '6h', '12h', '18h']);
    expect(f?.ticks[0]?.at).toBe(20);
  });

  it('starts at the anchor when nothing was drafted', () => {
    expect(timelineFigure({ ...base, medReady: null })?.ready).toBe(0);
  });

  it('draws nothing without both measured medians', () => {
    expect(timelineFigure({ ...base, medFirst: null })).toBeNull();
    expect(timelineFigure({ ...base, medMerge: null })).toBeNull();
  });
});

describe('timelineSteps', () => {
  const EVENTS = ['opened', 'ready', 'first', 'merged'];

  it('draws the baseline first, then the events in order, then the anchor', () => {
    const steps = timelineSteps(EVENTS);
    expect(steps.map((s) => s.name)).toEqual(['baseline', ...EVENTS, 'anchor']);
    expect(steps[0]).toEqual({ name: 'baseline', delay: 0, duration: TIMELINE_BASELINE_MS });
    const delays = steps.map((s) => s.delay);
    expect(delays.toSorted((a, b) => a - b)).toEqual(delays);
  });

  it('staggers the event marks by 120 ms, starting while the baseline still draws', () => {
    const marks = timelineSteps(EVENTS).slice(1, -1);
    expect(marks[0]?.delay).toBeLessThan(TIMELINE_BASELINE_MS);
    for (let i = 1; i < marks.length; i++) {
      expect((marks[i]?.delay ?? 0) - (marks[i - 1]?.delay ?? 0)).toBe(TIMELINE_STAGGER_MS);
    }
  });

  it('lands the anchor last, with time to settle, and stays under 1.2 s', () => {
    const steps = timelineSteps(EVENTS);
    const anchor = steps.at(-1);
    const lastMark = steps.at(-2);
    expect(anchor?.name).toBe('anchor');
    expect(anchor?.duration).toBe(TIMELINE_ANCHOR_MS);
    expect(anchor?.delay).toBeGreaterThan(lastMark?.delay ?? 0);
    expect(timelineTotal(steps)).toBeLessThan(TIMELINE_MAX_MS);
  });

  it('is immediate under reduced motion', () => {
    const steps = timelineSteps(EVENTS, true);
    expect(steps.map((s) => s.name)).toEqual(['baseline', ...EVENTS, 'anchor']);
    expect(steps.every((s) => s.delay === 0 && s.duration === 0)).toBe(true);
    expect(timelineTotal(steps)).toBe(0);
  });
});
