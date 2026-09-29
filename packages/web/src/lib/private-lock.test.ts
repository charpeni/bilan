import { describe, expect, it } from 'vitest';

import { PRIVATE_LOCK_COPY, PRIVATE_LOCK_LABEL, tooltipPosition } from './private-lock.ts';

describe('private lock copy', () => {
  it('says who can see the report', () => {
    expect(PRIVATE_LOCK_COPY).toBe(
      'Private repository. Only people who can see it on GitHub can open this dashboard; bilan checks their access with their own GitHub token each time. Nothing here is public.',
    );
    expect(PRIVATE_LOCK_LABEL).toBe('Private repository');
  });
});

describe('tooltipPosition', () => {
  const tip = { width: 280, height: 60 };

  it('centres the tooltip under the icon', () => {
    expect(
      tooltipPosition({ left: 600, right: 616, top: 20, bottom: 36 }, tip, {
        width: 1280,
        height: 800,
      }),
    ).toEqual({ left: 468, top: 42 });
  });

  it('never overflows a 390 px viewport', () => {
    const near = tooltipPosition({ left: 360, right: 376, top: 20, bottom: 36 }, tip, {
      width: 390,
      height: 800,
    });
    expect(near.left).toBe(390 - 8 - 280);
    const far = tooltipPosition({ left: 4, right: 20, top: 20, bottom: 36 }, tip, {
      width: 390,
      height: 800,
    });
    expect(far.left).toBe(8);
  });

  it('flips above the icon when there is no room below', () => {
    expect(
      tooltipPosition({ left: 100, right: 116, top: 760, bottom: 776 }, tip, {
        width: 1280,
        height: 800,
      }),
    ).toEqual({ left: 8, top: 694 });
  });
});
