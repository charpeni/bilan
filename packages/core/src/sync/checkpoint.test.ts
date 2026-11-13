import { describe, expect, it } from 'vitest';

import {
  advanceWalk,
  checkpointsOrNothing,
  forgetsCheckpoint,
  startWalk,
  usableCheckpoint,
} from './checkpoint.ts';

const startedAt = '2026-06-02T00:00:00.000Z';
const prior = {
  cursor: 'after-325',
  reached: '2026-05-18T12:00:00.000Z',
  from: '2026-06-01T00:00:00.000Z',
};
const at = (iso: string) => Date.parse(iso);

describe('startWalk', () => {
  it('joins nothing without a usable checkpoint', () => {
    expect(startWalk(null, startedAt)).toEqual({
      prior: null,
      joined: true,
      oldestReached: Infinity,
    });
    expect(startWalk({ ...prior, from: '2026-06-03T00:00:00Z' }, startedAt).prior).toBeNull();
    expect(startWalk({ ...prior, reached: 'nope' }, startedAt).prior).toBeNull();
  });

  it('takes a checkpoint from a run that started no later than this one', () => {
    expect(startWalk(prior, startedAt)).toMatchObject({ prior, joined: false });
    expect(usableCheckpoint({ ...prior, from: startedAt }, startedAt)).not.toBeNull();
  });
});

describe('advanceWalk', () => {
  it('saves nothing until the walk reaches below where the earlier one began', () => {
    const step = advanceWalk(
      startWalk(prior, startedAt),
      { oldestUpdatedAt: at('2026-06-01T06:00:00Z'), nextCursor: 'c1' },
      startedAt,
    );
    expect(step).toMatchObject({ next: 'c1', checkpoint: undefined });
    expect(step.progress.joined).toBe(false);
  });

  it('joins the earlier walk and goes on from its cursor, vouching for what it reached', () => {
    const step = advanceWalk(
      startWalk(prior, startedAt),
      { oldestUpdatedAt: at('2026-05-31T00:00:00Z'), nextCursor: 'c1' },
      startedAt,
    );
    expect(step).toEqual({
      progress: { prior, joined: true, oldestReached: at(prior.reached) },
      next: prior.cursor,
      checkpoint: { cursor: prior.cursor, reached: prior.reached, from: startedAt },
    });
  });

  it('keeps its own cursor when it already went deeper than the earlier walk', () => {
    const step = advanceWalk(
      startWalk(prior, startedAt),
      { oldestUpdatedAt: at('2026-05-01T00:00:00Z'), nextCursor: 'c9' },
      startedAt,
    );
    expect(step.next).toBe('c9');
    expect(step.checkpoint).toEqual({
      cursor: 'c9',
      reached: '2026-05-01T00:00:00.000Z',
      from: startedAt,
    });
  });

  it('clears the checkpoint at the end of history, joined or not', () => {
    const end = { oldestUpdatedAt: at('2026-06-01T06:00:00Z'), nextCursor: null };
    expect(advanceWalk(startWalk(prior, startedAt), end, startedAt).checkpoint).toBeNull();
    expect(advanceWalk(startWalk(null, startedAt), end, startedAt).checkpoint).toBeNull();
  });

  it('saves nothing for an empty page it cannot date', () => {
    const step = advanceWalk(
      startWalk(null, startedAt),
      { oldestUpdatedAt: Infinity, nextCursor: 'c1' },
      startedAt,
    );
    expect(step).toMatchObject({ next: 'c1', checkpoint: undefined });
  });
});

describe('forgetsCheckpoint', () => {
  it('only for the saved cursor', () => {
    const progress = startWalk(prior, startedAt);
    expect(forgetsCheckpoint(progress, prior.cursor)).toBe(true);
    expect(forgetsCheckpoint(progress, 'other')).toBe(false);
    expect(forgetsCheckpoint(progress, null)).toBe(false);
  });
});

describe('checkpointsOrNothing', () => {
  it('keeps valid checkpoints and drops anything else', () => {
    expect(checkpointsOrNothing({ all: prior, open: null })).toEqual({ all: prior, open: null });
    expect(checkpointsOrNothing({ all: { cursor: 1 }, open: null })).toBeUndefined();
    expect(checkpointsOrNothing({ all: { ...prior, from: 'x' }, open: null })).toBeUndefined();
    expect(checkpointsOrNothing(null)).toBeUndefined();
  });
});
