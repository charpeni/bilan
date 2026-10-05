/**
 * The reader's place on a page whose content draws only once its data has
 * arrived: the repository dashboard. A browser puts a reloaded page (or one
 * reached again through history) back where the reader left it, but gives up
 * once the page has loaded, and the dashboard draws after that, so the page
 * it restored was too short and the reader landed at the top. The page keeps
 * the place itself instead.
 *
 * The place is saved per history entry: the entry's state carries a key, and
 * session storage the position under it, written as the reader leaves (the
 * entry itself can no longer be changed by then). A fresh visit to the same
 * address is a new entry, with no place, and starts at the top.
 */

export interface ScrollPlaceDeps {
  history: Pick<History, 'state' | 'replaceState' | 'scrollRestoration'>;
  /** Null when the browser keeps none (storage disabled): the browser keeps restoring then. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** The page's vertical scroll position, read as the reader leaves. */
  scrollY: () => number;
  scrollTo: (y: number) => void;
  onPageHide: (listener: () => void) => void;
  raf: (cb: () => void) => void;
  /** A key for a history entry that has none yet. */
  newKey: () => string;
}

const sessionStore = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const browserDeps = (): ScrollPlaceDeps => ({
  history: window.history,
  storage: sessionStore(),
  scrollY: () => window.scrollY,
  scrollTo: (y) => window.scrollTo(0, y),
  onPageHide: (listener) => window.addEventListener('pagehide', listener),
  raf: (cb) => requestAnimationFrame(cb),
  newKey: () => Math.random().toString(36).slice(2, 10),
});

/** Where a history entry's place is kept in session storage. */
export const placeStorageKey = (entry: string): string => `bilan-scroll:${entry}`;

/** The key a history entry's state carries, if it has one. */
export function entryKey(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('scrollKey' in state)) return null;
  return typeof state.scrollKey === 'string' ? state.scrollKey : null;
}

/** A saved place worth scrolling back to: a positive number of pixels. */
export function savedPlace(stored: string | null): number | null {
  if (stored === null) return null;
  const y = Number(stored);
  return Number.isFinite(y) && y > 0 ? y : null;
}

/**
 * Take scroll restoration over from the browser and save the reader's place
 * as they leave. Returns `restore`, for the page to call once its content is
 * drawn: it scrolls back on the next frame, after the charts the draw queued,
 * and only the first time.
 */
export function keepScrollPlace(deps: ScrollPlaceDeps = browserDeps()): () => void {
  const { history, storage } = deps;
  if (storage === null) return () => undefined;
  history.scrollRestoration = 'manual';
  const state: unknown = history.state;
  let entry = entryKey(state);
  if (entry === null) {
    entry = deps.newKey();
    const kept = typeof state === 'object' && state !== null ? state : {};
    history.replaceState({ ...kept, scrollKey: entry }, '');
  }
  const key = placeStorageKey(entry);
  deps.onPageHide(() => {
    try {
      storage.setItem(key, String(Math.round(deps.scrollY())));
    } catch {
      /* storage may be full; the next visit starts at the top */
    }
  });
  let pending = true;
  return () => {
    if (!pending) return;
    pending = false;
    const y = savedPlace(storage.getItem(key));
    if (y !== null) deps.raf(() => deps.scrollTo(y));
  };
}
