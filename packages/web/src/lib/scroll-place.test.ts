import { describe, expect, it } from 'vitest';

import { entryKey, keepScrollPlace, placeStorageKey, savedPlace } from './scroll-place.ts';

import type { ScrollPlaceDeps } from './scroll-place.ts';

/**
 * A tab: one session storage, and history entries whose state survives a
 * reload, as a browser's does. `load` opens a page on an entry.
 */
function tab() {
  const storage = new Map<string, string>();
  let keys = 0;
  const load = (entry: { state: unknown }) => {
    let scrollY = 0;
    const frames: (() => void)[] = [];
    const hides: (() => void)[] = [];
    const scrolls: number[] = [];
    const history = {
      get state(): unknown {
        return entry.state;
      },
      replaceState(next: unknown) {
        entry.state = structuredClone(next);
      },
      scrollRestoration: 'auto' as ScrollRestoration,
    };
    const deps: ScrollPlaceDeps = {
      history,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
      },
      scrollY: () => scrollY,
      scrollTo: (y) => scrolls.push(y),
      onPageHide: (listener) => hides.push(listener),
      raf: (cb) => frames.push(cb),
      newKey: () => `k${++keys}`,
    };
    return {
      deps,
      history,
      scrolls,
      scrollTo(y: number) {
        scrollY = y;
      },
      hide: () => hides.forEach((listener) => listener()),
      flush: () => frames.splice(0).forEach((cb) => cb()),
    };
  };
  return { storage, load };
}

describe('entryKey', () => {
  it('reads the key a history entry carries', () => {
    expect(entryKey({ scrollKey: 'k1' })).toBe('k1');
  });

  it('has none for an entry without one', () => {
    expect(entryKey(null)).toBeNull();
    expect(entryKey('state')).toBeNull();
    expect(entryKey({})).toBeNull();
    expect(entryKey({ scrollKey: 1 })).toBeNull();
  });
});

describe('savedPlace', () => {
  it('reads a saved position', () => {
    expect(savedPlace('4000')).toBe(4000);
  });

  it('has none when nothing was saved, or the reader was at the top', () => {
    expect(savedPlace(null)).toBeNull();
    expect(savedPlace('')).toBeNull();
    expect(savedPlace('nope')).toBeNull();
    expect(savedPlace('0')).toBeNull();
  });
});

describe('keepScrollPlace', () => {
  it('takes scroll restoration over and keys the history entry, keeping its state', () => {
    const page = tab().load({ state: { other: 1 } });
    keepScrollPlace(page.deps);
    expect(page.history.scrollRestoration).toBe('manual');
    expect(page.history.state).toEqual({ other: 1, scrollKey: 'k1' });
  });

  it('puts a reloaded page back on the frame after the dashboard draws, once', () => {
    const t = tab();
    const entry = { state: null };
    const first = t.load(entry);
    keepScrollPlace(first.deps);
    first.scrollTo(4000);
    first.hide();
    expect(t.storage.get(placeStorageKey('k1'))).toBe('4000');

    const reloaded = t.load(entry);
    const restore = keepScrollPlace(reloaded.deps);
    restore();
    // Not during the draw: its charts are still queued.
    expect(reloaded.scrolls).toEqual([]);
    reloaded.flush();
    expect(reloaded.scrolls).toEqual([4000]);
    // A later redraw (a refresh, a longer range) leaves the reader where they are.
    restore();
    reloaded.flush();
    expect(reloaded.scrolls).toEqual([4000]);
  });

  it('leaves a fresh visit to the same page at the top', () => {
    const t = tab();
    const first = t.load({ state: null });
    keepScrollPlace(first.deps);
    first.scrollTo(4000);
    first.hide();

    const fresh = t.load({ state: null });
    keepScrollPlace(fresh.deps)();
    fresh.flush();
    expect(fresh.scrolls).toEqual([]);
  });

  it('leaves restoring to the browser without session storage', () => {
    const page = tab().load({ state: null });
    keepScrollPlace({ ...page.deps, storage: null })();
    page.flush();
    expect(page.history.scrollRestoration).toBe('auto');
    expect(page.history.state).toBeNull();
    expect(page.scrolls).toEqual([]);
  });
});
