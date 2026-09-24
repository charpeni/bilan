import { describe, expect, it } from 'vitest';

import { rawPr } from '../testing/fixtures.ts';
import { readyInfo } from './ready.ts';

describe('readyInfo', () => {
  it('anchors a PR opened ready at its creation time', () => {
    const pr = rawPr({ createdAt: '2026-01-01T10:00:00Z' });
    expect(readyInfo(pr)).toEqual({
      readyAt: Date.parse('2026-01-01T10:00:00Z'),
      openedAsDraft: false,
    });
  });

  it('anchors a draft-opened PR at its first ready event', () => {
    const pr = rawPr({ readyAt: ['2026-01-03T09:00:00Z'] });
    expect(readyInfo(pr)).toEqual({
      readyAt: Date.parse('2026-01-03T09:00:00Z'),
      openedAsDraft: true,
    });
  });

  it('ignores re-drafts after the first ready event', () => {
    const pr = rawPr({
      readyAt: ['2026-01-03T09:00:00Z', '2026-01-05T09:00:00Z'],
      draftedAt: ['2026-01-04T09:00:00Z'],
    });
    expect(readyInfo(pr).readyAt).toBe(Date.parse('2026-01-03T09:00:00Z'));
  });

  it('treats a PR whose first event is convert-to-draft as opened ready', () => {
    const pr = rawPr({
      createdAt: '2026-01-01T10:00:00Z',
      draftedAt: ['2026-01-02T09:00:00Z'],
      readyAt: ['2026-01-03T09:00:00Z'],
    });
    expect(readyInfo(pr)).toEqual({
      readyAt: Date.parse('2026-01-01T10:00:00Z'),
      openedAsDraft: false,
    });
  });

  it('gives a still-draft PR with no draft-state events no ready time', () => {
    const pr = rawPr({ isDraft: true, state: 'OPEN', mergedAt: null, closedAt: null });
    expect(readyInfo(pr)).toEqual({ readyAt: null, openedAsDraft: true });
  });

  it('treats a current draft that opened ready and was converted as ready at creation', () => {
    const pr = rawPr({
      isDraft: true,
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      createdAt: '2026-01-01T10:00:00Z',
      draftedAt: ['2026-01-02T09:00:00Z'],
      readyAt: [],
    });
    expect(readyInfo(pr)).toEqual({
      readyAt: Date.parse('2026-01-01T10:00:00Z'),
      openedAsDraft: false,
    });
  });
});
