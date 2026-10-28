import { describe, expect, it } from 'vitest';

import { LIVE_FALLBACK_MS, liveSync } from './live-sync.ts';

import type { EventSourceLike } from './live-sync.ts';

/** An EventSource the test drives, and timers it fires by hand. */
function harness(options: { connects?: boolean } = {}) {
  const listeners: Record<string, (() => void)[]> = {};
  let closed = false;
  const source: EventSourceLike = {
    addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
    close: () => {
      closed = true;
    },
  };
  const timers = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const live = liveSync('/api/repos/acme/repo/live', {
    connect: () => (options.connects === false ? null : source),
    setTimeout: (run, ms) => {
      timers.set(++next, { run, ms });
      return next;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
  });
  return {
    live,
    emit: (type: 'open' | 'error' | 'message') => listeners[type]?.forEach((l) => l()),
    timers,
    fireTimers: () => [...timers.values()].forEach((t) => t.run()),
    isClosed: () => closed,
  };
}

const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  return done;
};

describe('liveSync', () => {
  it('waits the plain interval until the stream is open', async () => {
    const h = harness();
    const wait = h.live.wait(4000);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([4000]);
    expect(await settled(wait)).toBe(false);
    h.fireTimers();
    expect(await settled(wait)).toBe(true);
  });

  it('ends a wait on the next status event once connected, well before the fallback', async () => {
    const h = harness();
    h.emit('open');
    const wait = h.live.wait(4000);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([LIVE_FALLBACK_MS]);
    h.emit('message');
    expect(await settled(wait)).toBe(true);
    // The fallback timer was cleared with it.
    expect(h.timers.size).toBe(0);
  });

  it('wakes every pending wait on one event', async () => {
    const h = harness();
    h.emit('open');
    const waits = [h.live.wait(4000), h.live.wait(4000)];
    h.emit('message');
    expect(await Promise.all(waits.map(settled))).toEqual([true, true]);
  });

  it('falls back to the plain interval while the stream is down', async () => {
    const h = harness();
    h.emit('open');
    h.emit('error');
    void h.live.wait(4000);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([4000]);
  });

  it('polls as before where EventSource is unavailable', async () => {
    const h = harness({ connects: false });
    const wait = h.live.wait(4000);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([4000]);
    h.fireTimers();
    expect(await settled(wait)).toBe(true);
  });

  it('closes the stream and releases pending waits', async () => {
    const h = harness();
    h.emit('open');
    const wait = h.live.wait(4000);
    h.live.close();
    expect(h.isClosed()).toBe(true);
    expect(await settled(wait)).toBe(true);
  });

  it('does not miss a change that arrives between two waits', async () => {
    const h = harness();
    h.emit('open');
    h.emit('message');
    expect(await settled(h.live.wait(4000))).toBe(true);
    expect(h.timers.size).toBe(0);
    // Only that one change: the next wait waits again.
    expect(await settled(h.live.wait(4000))).toBe(false);
  });
});
