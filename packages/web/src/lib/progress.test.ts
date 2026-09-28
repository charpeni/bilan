import { describe, expect, it } from 'vitest';

import { fmtElapsed, progressText } from './progress.ts';

const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const at = (ms: number): string => new Date(T0 - ms).toISOString();

describe('fmtElapsed', () => {
  it('prints seconds, then minutes and seconds, then minutes', () => {
    expect(fmtElapsed(-500)).toBe('0s');
    expect(fmtElapsed(8_400)).toBe('8s');
    expect(fmtElapsed(65_000)).toBe('1m 05s');
    expect(fmtElapsed(12 * 60_000 + 30_000)).toBe('12m');
  });
});

describe('progressText', () => {
  it('says a queued job is waiting', () => {
    expect(progressText({ phase: 'queued', prsStored: null, startedAt: at(3_000) }, T0)).toBe(
      'Waiting to start… · 3s',
    );
  });

  it('says it is reading until the first page is stored', () => {
    expect(progressText({ phase: 'running', prsStored: 0, startedAt: null }, T0)).toBe(
      'Reading pull requests from GitHub…',
    );
    expect(progressText({ phase: 'active', prsStored: null, startedAt: null }, T0)).toBe(
      'Reading pull requests from GitHub…',
    );
  });

  it('counts the pull requests stored so far, with the elapsed time when known', () => {
    expect(progressText({ phase: 'running', prsStored: 1, startedAt: null }, T0)).toBe(
      '1 pull request synced so far',
    );
    expect(progressText({ phase: 'running', prsStored: 1250, startedAt: at(65_000) }, T0)).toBe(
      '1,250 pull requests synced so far · 1m 05s',
    );
  });

  it('ignores a start it cannot parse', () => {
    expect(progressText({ phase: 'active', prsStored: 25, startedAt: 'soon' }, T0)).toBe(
      '25 pull requests synced so far',
    );
  });
});
