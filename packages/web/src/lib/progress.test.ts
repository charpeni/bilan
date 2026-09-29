import { describe, expect, it } from 'vitest';

import { fmtElapsed } from './progress.ts';

describe('fmtElapsed', () => {
  it('prints seconds, then minutes and seconds, then minutes', () => {
    expect(fmtElapsed(-500)).toBe('0s');
    expect(fmtElapsed(8_400)).toBe('8s');
    expect(fmtElapsed(65_000)).toBe('1m 05s');
    expect(fmtElapsed(90_000)).toBe('1m 30s');
    expect(fmtElapsed(12 * 60_000 + 30_000)).toBe('12m');
  });
});
