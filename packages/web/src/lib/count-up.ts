/**
 * Counting a figure up (or down) to its new value instead of jumping: the
 * sync page's "1,234 pull requests read", the repo list's live rows. Pure:
 * the page owns the clock and the frame loop, this decides the numbers.
 */

/** A small change takes this long; bigger ones stretch towards the cap. */
export const COUNT_UP_MS = 600;
export const COUNT_UP_MAX_MS = 900;

/** Ease-out cubic: fast at first, settling into the target. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * How long a change should take: 600 ms up to a change of 25, then a little
 * longer per unit, never past 900 ms so a large jump still lands promptly.
 */
export function countUpDuration(from: number, to: number): number {
  const change = Math.abs(to - from);
  return Math.min(COUNT_UP_MAX_MS, COUNT_UP_MS + Math.max(0, change - 25) * 4);
}

/**
 * The integer to show `elapsed` ms into a change from `from` to `to`, on an
 * ease-out curve over `durationMs`. Exactly `to` once the time is up; the
 * value only ever moves towards the target, so it never overshoots or
 * flickers backwards.
 */
export function countUpValue(
  from: number,
  to: number,
  elapsed: number,
  durationMs: number,
): number {
  if (durationMs <= 0 || elapsed >= durationMs) return to;
  const t = Math.max(0, elapsed) / durationMs;
  const v = from + (to - from) * easeOut(t);
  return to >= from ? Math.min(to, Math.floor(v)) : Math.max(to, Math.ceil(v));
}

/**
 * Every integer a frame loop at `frameMs` would show for one change, the
 * target last; useful to check a change counts through, never past.
 */
export function countUpFrames(
  from: number,
  to: number,
  durationMs: number,
  frameMs = 16,
): number[] {
  const out: number[] = [];
  for (let t = 0; t < durationMs; t += frameMs) out.push(countUpValue(from, to, t, durationMs));
  out.push(to);
  return out;
}

export interface Counter {
  /** Point the counter at a new target; the tween starts from what is on screen right now. */
  set(target: number, now: number): void;
  /** The integer to show at `now`. */
  value(now: number): number;
  /** Whether the shown value has reached the target. */
  settled(now: number): boolean;
}

/**
 * A retargetable count: `set` starts a tween from the value on screen at that
 * instant (so a target that moves mid-flight is chased, not restarted from the
 * old start), `value` reads the figure for a frame. With `instant` (reduced
 * motion) every read is the target itself.
 */
export function createCounter(initial: number | null, instant = false): Counter {
  let from = initial ?? 0;
  let to = initial ?? 0;
  let startedAt = 0;
  let duration = 0;
  let empty = initial === null;
  const at = (now: number): number =>
    empty ? to : countUpValue(from, to, now - startedAt, duration);
  return {
    set(target, now) {
      if (instant || empty) {
        // Nothing on screen yet: the first figure appears as it is.
        from = target;
        to = target;
        duration = 0;
        empty = false;
        return;
      }
      if (target === to) return;
      from = at(now);
      to = target;
      startedAt = now;
      duration = countUpDuration(from, to);
    },
    value: at,
    settled: (now) => at(now) === to,
  };
}

/**
 * Split a sentence around the figure it carries, so the page can put the
 * number in its own tabular-figure element and tween it. `formatted` is the
 * figure as the sentence prints it (`1,234`); null when it is not there.
 */
export function splitAtCount(
  text: string,
  formatted: string,
): { before: string; after: string } | null {
  const i = text.indexOf(formatted);
  if (i < 0) return null;
  return { before: text.slice(0, i), after: text.slice(i + formatted.length) };
}

/** Figures as the sync labels print them. */
export const fmtCount = (n: number): string => n.toLocaleString('en-US');

export interface LiveCountDeps {
  now: () => number;
  raf: (cb: () => void) => number;
  reduceMotion: boolean;
}

export interface LiveCount {
  /** Show `target`, counting to it from the figure on screen. */
  set(target: number): void;
  /** Stop asking for frames (the element is gone). */
  stop(): void;
}

const browserDeps = (): LiveCountDeps => ({
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  reduceMotion:
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
});

/**
 * A counter bound to a `write` (the element's text, say): `set` starts the
 * tween and drives it on animation frames until it settles. Reduced motion
 * writes the target at once.
 */
export function liveCount(
  write: (value: number) => void,
  deps: LiveCountDeps = browserDeps(),
): LiveCount {
  const counter = createCounter(null, deps.reduceMotion);
  let pending = false;
  let stopped = false;
  const frame = (): void => {
    pending = false;
    if (stopped) return;
    const now = deps.now();
    write(counter.value(now));
    if (!counter.settled(now)) {
      pending = true;
      deps.raf(frame);
    }
  };
  return {
    set(target) {
      const now = deps.now();
      counter.set(target, now);
      write(counter.value(now));
      if (!counter.settled(now) && !pending) {
        pending = true;
        deps.raf(frame);
      }
    },
    stop() {
      stopped = true;
    },
  };
}
