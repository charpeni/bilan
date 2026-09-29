import { describe, expect, it } from 'vitest';

import {
  describeSync,
  finalReadyText,
  interimText,
  observe,
  STALL_AFTER_MS,
  syncErrorText,
  syncLine,
} from './sync-status.ts';

import type { SyncProgress } from './poll.ts';

const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const ago = (ms: number): string => new Date(T0 - ms).toISOString();

const running = (over: Partial<SyncProgress> = {}): SyncProgress => ({
  phase: 'running',
  prsStored: 700,
  startedAt: ago(98_000),
  label: '700 pull requests read · the repository has 1,100 in total',
  fraction: null,
  workflowStatus: 'running',
  stageLabel: null,
  interim: false,
  ...over,
});

describe('observe', () => {
  it('starts the clock on the first probe and resets it on any growth', () => {
    const first = observe(null, 10, T0);
    expect(first).toEqual({ read: 10, since: T0 });
    expect(observe(first, 10, T0 + 5_000)).toBe(first);
    expect(observe(first, 12, T0 + 5_000)).toEqual({ read: 12, since: T0 + 5_000 });
  });

  it('never treats an unknown count as progress', () => {
    const first = observe(null, 10, T0);
    expect(observe(first, null, T0 + 5_000)).toBe(first);
    expect(observe(observe(null, null, T0), 0, T0 + 1)).toEqual({ read: 0, since: T0 + 1 });
  });
});

describe('describeSync', () => {
  it('leads with how much is done, then the elapsed time', () => {
    const view = describeSync(running(), observe(null, 700, T0), T0);
    expect(view).toEqual({
      state: 'reading',
      headline: '700 pull requests read · the repository has 1,100 in total',
      count: 700,
      detail: '1m 38s',
      fraction: null,
      warning: null,
    });
    expect(syncLine(view)).toBe(
      '700 pull requests read · the repository has 1,100 in total · 1m 38s',
    );
  });

  it('passes a known fraction through for a determinate bar', () => {
    const view = describeSync(
      running({ label: '700 of 1,100 pull requests · 64%', fraction: 700 / 1100 }),
      null,
      T0,
    );
    expect(view.headline).toBe('700 of 1,100 pull requests · 64%');
    expect(view.fraction).toBeCloseTo(0.636, 3);
  });

  it('says it is reading until the first pull request is stored', () => {
    expect(describeSync(running({ prsStored: 0 }), null, T0).headline).toBe(
      'Reading pull requests from GitHub…',
    );
    expect(
      describeSync(
        running({ phase: 'active', prsStored: null, label: null, startedAt: null }),
        null,
        T0,
      ),
    ).toMatchObject({ headline: 'Reading pull requests from GitHub…', detail: '' });
  });

  it('counts stored rows when the API sends no label (someone else’s sync)', () => {
    expect(
      describeSync(
        running({ phase: 'active', prsStored: 1, label: null, startedAt: null }),
        null,
        T0,
      ).headline,
    ).toBe('1 pull request read');
  });

  it('says a queued job is waiting to start', () => {
    expect(describeSync(running({ phase: 'queued', prsStored: 0 }), null, T0)).toMatchObject({
      state: 'queued',
      headline: 'Waiting to start…',
      detail: '1m 38s',
    });
  });

  it('warns quietly once nothing has moved for 90 seconds', () => {
    const since = observe(null, 700, T0 - STALL_AFTER_MS);
    const view = describeSync(running(), since, T0);
    expect(view.state).toBe('stalled');
    expect(view.warning).toBe('No progress for 1m 30s');
    expect(view.headline).toBe('700 pull requests read · the repository has 1,100 in total');
    expect(
      describeSync(running(), observe(null, 700, T0 - STALL_AFTER_MS + 1), T0).warning,
    ).toBeNull();
  });

  it('explains a run asleep on the rate limit instead of calling it stalled', () => {
    for (const workflowStatus of ['waiting', 'paused', 'waitingForPause']) {
      const view = describeSync(
        running({ workflowStatus }),
        observe(null, 700, T0 - 10 * STALL_AFTER_MS),
        T0,
      );
      expect(view).toMatchObject({
        state: 'waiting',
        headline: 'Waiting for GitHub’s rate limit to reset',
        detail: '700 pull requests read · the repository has 1,100 in total · 1m 38s',
        warning: null,
      });
    }
  });

  it('ignores a start it cannot parse', () => {
    expect(describeSync(running({ startedAt: 'soon' }), null, T0).detail).toBe('');
  });
});

describe('syncErrorText', () => {
  it('says the sync stopped, and why when the job says', () => {
    expect(syncErrorText('lost: the sync engine has no record of this run')).toBe(
      'The sync stopped: the sync engine has no record of this run.',
    );
    expect(syncErrorText('rate limited.')).toBe('The sync stopped: rate limited.');
    expect(syncErrorText(null)).toBe('The sync stopped.');
    expect(syncErrorText('  ')).toBe('The sync stopped.');
  });
});

describe('interimText', () => {
  const view = describeSync(running(), observe(null, 700, T0), T0);

  it('says what is on screen and what the run is still doing', () => {
    expect(interimText('last 7 days', view, 'Last 7 days published; reading up to 30 days')).toBe(
      'Showing the last 7 days · reading up to 30 days · 700 pull requests read · the repository has 1,100 in total',
    );
  });

  it('falls back to "still syncing" without a stage label, or before any progress', () => {
    expect(interimText('last 7 days', null, null)).toBe('Showing the last 7 days · still syncing');
    expect(interimText('last 7 days', null, '')).toBe('Showing the last 7 days · still syncing');
  });

  it('carries the stall warning', () => {
    const stalled = describeSync(running(), observe(null, 700, T0 - STALL_AFTER_MS), T0);
    expect(interimText('last 7 days', stalled, null)).toMatch(/ · No progress for 1m 30s$/);
  });
});

describe('finalReadyText', () => {
  it('agrees with what landed', () => {
    expect(finalReadyText('last 30 days')).toBe('The last 30 days are ready.');
    expect(finalReadyText('full history')).toBe('The full history is ready.');
  });
});
