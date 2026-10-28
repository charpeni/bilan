/**
 * Cuts the page's wait between sync probes short whenever the sync model
 * reports a change (`GET <apiBase>/live`, Server-Sent Events), so a page
 * follows a sync as it happens instead of every `POLL_INTERVAL_MS`. The
 * probes and their outcomes stay as `poll.ts` defines them: an event only
 * says "look again". While the stream is down, waits fall back to the plain
 * interval; while it is up, a wait still ends after `LIVE_FALLBACK_MS`, in
 * case an event is missed. The server ends the stream when the run ends, or
 * after a few minutes, and the browser reconnects on its own.
 */

/** The longest a wait lasts while the stream is connected. */
export const LIVE_FALLBACK_MS = 30_000;

export interface LiveSync {
  /** Resolve on the next status event, or after `ms` (`LIVE_FALLBACK_MS` while connected). */
  wait(ms: number): Promise<void>;
  /** Stop listening, and end any pending wait. */
  close(): void;
}

/** The part of `EventSource` this uses, so tests can stand one in. */
export interface EventSourceLike {
  addEventListener(type: 'open' | 'error' | 'message', listener: () => void): void;
  close(): void;
}

export interface LiveSyncDeps {
  connect?: (url: string) => EventSourceLike | null;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const browserConnect = (url: string): EventSourceLike | null =>
  typeof EventSource === 'undefined' ? null : new EventSource(url);

export function liveSync(url: string, deps: LiveSyncDeps = {}): LiveSync {
  const connect = deps.connect ?? browserConnect;
  const schedule = deps.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const cancel =
    deps.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  let connected = false;
  const waiting = new Set<() => void>();
  // A change that arrived while nobody waited (between two probes): the next
  // wait ends at once instead of missing it.
  let changed = false;
  const wakeAll = () => {
    if (waiting.size === 0) changed = true;
    for (const wake of waiting) wake();
  };

  let source: EventSourceLike | null = null;
  try {
    source = connect(url);
  } catch {
    source = null;
  }
  // The browser reconnects on its own after an error; until then, poll as before.
  source?.addEventListener('open', () => {
    connected = true;
  });
  source?.addEventListener('error', () => {
    connected = false;
  });
  source?.addEventListener('message', wakeAll);

  return {
    wait(ms) {
      if (changed) {
        changed = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const wake = () => {
          cancel(timer);
          waiting.delete(wake);
          resolve();
        };
        const timer = schedule(wake, connected ? Math.max(ms, LIVE_FALLBACK_MS) : ms);
        waiting.add(wake);
      });
    },
    close() {
      source?.close();
      for (const wake of waiting) wake();
    },
  };
}
