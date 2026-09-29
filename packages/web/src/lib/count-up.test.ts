import { describe, expect, it } from 'vitest';

import {
  COUNT_UP_MAX_MS,
  COUNT_UP_MS,
  countUpDuration,
  countUpFrames,
  countUpValue,
  createCounter,
  fmtCount,
  liveCount,
  splitAtCount,
} from './count-up.ts';

describe('countUpDuration', () => {
  it('takes 600 ms for a small change and never more than 900 ms', () => {
    expect(countUpDuration(50, 75)).toBe(COUNT_UP_MS);
    expect(countUpDuration(0, 10)).toBe(COUNT_UP_MS);
    expect(countUpDuration(0, 50)).toBe(700);
    expect(countUpDuration(0, 10_000)).toBe(COUNT_UP_MAX_MS);
    expect(countUpDuration(10_000, 0)).toBe(COUNT_UP_MAX_MS);
  });
});

describe('countUpValue', () => {
  it('eases out from the start to the target and lands exactly on it', () => {
    expect(countUpValue(50, 75, 0, 600)).toBe(50);
    expect(countUpValue(50, 75, 300, 600)).toBe(71);
    expect(countUpValue(50, 75, 600, 600)).toBe(75);
    expect(countUpValue(50, 75, 900, 600)).toBe(75);
  });

  it('moves faster at first than at the end', () => {
    const early = countUpValue(0, 100, 150, 600) - countUpValue(0, 100, 0, 600);
    const late = countUpValue(0, 100, 600, 600) - countUpValue(0, 100, 450, 600);
    expect(early).toBeGreaterThan(late);
  });

  it('counts down when the target really decreased, without overshooting', () => {
    expect(countUpValue(75, 50, 0, 600)).toBe(75);
    expect(countUpValue(75, 50, 300, 600)).toBe(54);
    expect(countUpValue(75, 50, 600, 600)).toBe(50);
  });

  it('jumps straight to the target without a duration', () => {
    expect(countUpValue(50, 75, 0, 0)).toBe(75);
  });
});

describe('countUpFrames', () => {
  it('passes through the intermediate integers in order and ends on the target', () => {
    const frames = countUpFrames(50, 75, 600);
    expect(frames[0]).toBe(50);
    expect(frames[frames.length - 1]).toBe(75);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1] ?? 0);
      expect(frames[i]).toBeLessThanOrEqual(75);
    }
    // Small steps: no frame jumps by more than a few units on a 25-unit change.
    for (let i = 1; i < frames.length; i++) {
      expect((frames[i] ?? 0) - (frames[i - 1] ?? 0)).toBeLessThanOrEqual(3);
    }
    // At least most of the intermediate integers appear.
    expect(new Set(frames).size).toBeGreaterThan(15);
  });
});

describe('createCounter', () => {
  it('shows the first figure as it is, then counts to the next', () => {
    const c = createCounter(null);
    c.set(50, 1000);
    expect(c.value(1000)).toBe(50);
    expect(c.settled(1000)).toBe(true);
    c.set(75, 2000);
    expect(c.value(2000)).toBe(50);
    expect(c.value(2300)).toBe(71);
    expect(c.settled(2300)).toBe(false);
    expect(c.value(2600)).toBe(75);
    expect(c.settled(2600)).toBe(true);
  });

  it('chases a target that moves mid-flight from the figure on screen', () => {
    const c = createCounter(0);
    c.set(100, 0);
    const shown = c.value(300);
    c.set(200, 300);
    expect(c.value(300)).toBe(shown);
    expect(c.value(301)).toBeGreaterThanOrEqual(shown);
    expect(c.value(300 + 900)).toBe(200);
  });

  it('never counts backwards unless the target decreased', () => {
    const c = createCounter(0);
    c.set(100, 0);
    let last = 0;
    for (let now = 0; now <= 900; now += 16) {
      const v = c.value(now);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    c.set(40, 900);
    expect(c.value(900)).toBe(100);
    expect(c.value(1800)).toBe(40);
  });

  it('jumps immediately with reduced motion', () => {
    const c = createCounter(0, true);
    c.set(500, 0);
    expect(c.value(0)).toBe(500);
    expect(c.settled(0)).toBe(true);
  });
});

describe('splitAtCount', () => {
  it('cuts the sentence around the formatted figure', () => {
    expect(splitAtCount('1,234 pull requests read · stage 1 of 2 (last 7 days)', '1,234')).toEqual({
      before: '',
      after: ' pull requests read · stage 1 of 2 (last 7 days)',
    });
    expect(splitAtCount('Read 12 of 40', '12')).toEqual({ before: 'Read ', after: ' of 40' });
    expect(splitAtCount('Waiting to start…', '0')).toBeNull();
  });

  it('formats figures the way the labels do', () => {
    expect(fmtCount(1234)).toBe('1,234');
  });
});

describe('liveCount', () => {
  it('writes each frame until the figure settles, then stops asking for frames', () => {
    const frames: (() => void)[] = [];
    let now = 0;
    const written: number[] = [];
    const live = liveCount((v) => written.push(v), {
      now: () => now,
      raf: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      reduceMotion: false,
    });
    live.set(50);
    expect(written).toEqual([50]);
    expect(frames.length).toBe(0);
    live.set(75);
    expect(frames.length).toBe(1);
    while (frames.length) {
      now += 100;
      frames.shift()?.();
    }
    expect(written[written.length - 1]).toBe(75);
    expect(written.length).toBeGreaterThan(4);
    expect(now).toBeLessThanOrEqual(700);
  });

  it('jumps with reduced motion', () => {
    const written: number[] = [];
    const live = liveCount((v) => written.push(v), {
      now: () => 0,
      raf: () => {
        throw new Error('no frame expected');
      },
      reduceMotion: true,
    });
    live.set(1);
    live.set(500);
    expect(written).toEqual([1, 500]);
  });
});
