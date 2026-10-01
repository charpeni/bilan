import { describe, expect, it, vi } from 'vitest';

import { payloadKey } from './payload-key.ts';
import { PAYLOAD_GRACE_HOURS, prunePayloads } from './payload-pruning.ts';

import type { PayloadPruningDeps } from './payload-pruning.ts';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const cutoff = now - 48 * 60 * 60 * 1000;
const old = '2026-08-01T00:00:00.000Z';
const newer = '2026-09-01T00:00:00.000Z';

function snapshot(repoId: string, syncedAt: string, uploaded = Date.parse(syncedAt), size = 100) {
  return { key: payloadKey(repoId, syncedAt), uploaded: new Date(uploaded), size };
}

function dependencies(objects: ReturnType<typeof snapshot>[]) {
  return {
    list: vi.fn<PayloadPruningDeps['list']>().mockResolvedValue({ objects }),
    currentKey: vi
      .fn<PayloadPruningDeps['currentKey']>()
      .mockImplementation(async (repoId) => payloadKey(repoId, '2026-01-01T00:00:00.000Z')),
    exists: vi.fn<PayloadPruningDeps['exists']>().mockResolvedValue(true),
    delete: vi.fn<PayloadPruningDeps['delete']>().mockResolvedValue(undefined),
  };
}

describe('payload pruning', () => {
  it('keeps the current snapshot regardless of age, and all uploads within 48 hours', async () => {
    expect(PAYLOAD_GRACE_HOURS).toBe(48);
    const current = snapshot('R_a', old);
    const superseded = snapshot('R_a', newer);
    const recent = snapshot('R_a', '2026-10-01T00:00:00.000Z');
    const deps = dependencies([current, superseded, recent]);
    deps.currentKey.mockResolvedValue(current.key);

    const result = await prunePayloads(deps, { now, dryRun: false });

    expect(deps.delete).toHaveBeenCalledExactlyOnceWith([superseded.key]);
    expect(result).toEqual({
      dryRun: false,
      scanned: 3,
      skippedUnverified: 0,
      candidates: 1,
      candidateBytes: 100,
      deleted: 1,
      deletedBytes: 100,
    });
  });

  it('uses upload time to protect rewritten old keys, including the exact cutoff', async () => {
    const expired = snapshot('R_a', old, cutoff - 1);
    const boundary = snapshot('R_b', old, cutoff);
    const rewritten = snapshot('R_c', old, now);
    const future = snapshot('R_d', old, now + 1);
    const deps = dependencies([expired, boundary, rewritten, future]);

    await prunePayloads(deps, { now, dryRun: false });

    expect(deps.delete).toHaveBeenCalledExactlyOnceWith([expired.key]);
    expect(deps.currentKey).toHaveBeenCalledExactlyOnceWith('R_a');
  });

  it('keeps unknown keys, invalid dates, and recent or future timestamped keys', async () => {
    const object = snapshot('R_a', old);
    const deps = dependencies([
      { ...object, key: 'payload/R_a/notes.json.gz' },
      { ...object, key: 'payload/R_a/subdir/2026-08-01T00:00:00.000Z.json.gz' },
      { ...object, key: 'other/R_a/2026-08-01T00:00:00.000Z.json.gz' },
      snapshot('R_a', '2026-02-30T00:00:00.000Z'),
      { ...object, uploaded: new Date(NaN) },
      snapshot('R_a', new Date(cutoff).toISOString(), cutoff - 1),
      snapshot('R_a', '2026-10-02T00:00:00.000Z', cutoff - 1),
    ]);

    const result = await prunePayloads(deps, { now, dryRun: false });

    expect(result.candidates).toBe(0);
    expect(deps.currentKey).not.toHaveBeenCalled();
    expect(deps.delete).not.toHaveBeenCalled();
  });

  it('defaults to a dry run with the same candidate keys and bytes as an apply', async () => {
    const objects = [snapshot('R_a', old, cutoff - 1, 200), snapshot('R_b', old)];
    const deps = dependencies(objects);
    const onCandidates = vi.fn();

    const preview = await prunePayloads(deps, { now, onCandidates });

    expect(deps.delete).not.toHaveBeenCalled();
    expect(preview).toEqual({
      dryRun: true,
      scanned: 2,
      skippedUnverified: 0,
      candidates: 2,
      candidateBytes: 300,
      deleted: 0,
      deletedBytes: 0,
    });
    expect(onCandidates.mock.calls.flatMap(([batch]) => batch)).toEqual(objects);

    const applied = await prunePayloads(deps, { now, dryRun: false });
    expect(applied.candidates).toBe(preview.candidates);
    expect(applied.deletedBytes).toBe(preview.candidateBytes);
  });

  it('retains recovery copies when there is no repository row or current reference', async () => {
    const orphan = snapshot('R_missing', old);
    const unpublished = snapshot('R_missing', new Date(now).toISOString());
    const deps = dependencies([orphan, unpublished]);
    deps.currentKey.mockResolvedValue(null);

    const result = await prunePayloads(deps, { now, dryRun: false });

    expect(result.skippedUnverified).toBe(1);
    expect(result.candidates).toBe(0);
    expect(deps.exists).not.toHaveBeenCalled();
    expect(deps.delete).not.toHaveBeenCalled();
  });

  it('retains recovery copies if the current R2 snapshot is missing', async () => {
    const deps = dependencies([snapshot('R_a', old), snapshot('R_a', newer)]);
    const missing = payloadKey('R_a', '2026-09-15T00:00:00.000Z');
    deps.currentKey.mockResolvedValue(missing);
    deps.exists.mockResolvedValue(false);

    const result = await prunePayloads(deps, { now, dryRun: false });

    expect(deps.exists).toHaveBeenCalledExactlyOnceWith(missing);
    expect(result.skippedUnverified).toBe(2);
    expect(result.candidates).toBe(0);
    expect(deps.delete).not.toHaveBeenCalled();
  });

  it('fails closed if checking the current R2 object fails', async () => {
    const deps = dependencies([snapshot('R_a', old)]);
    deps.exists.mockRejectedValue(new Error('R2 unavailable'));

    await expect(prunePayloads(deps, { now, dryRun: false })).rejects.toThrow('R2 unavailable');

    expect(deps.delete).not.toHaveBeenCalled();
  });

  it('follows listing cursors and rechecks D1 when a repo spans multiple pages', async () => {
    const first = snapshot('R_a', old);
    const second = snapshot('R_a', newer);
    const deps = dependencies([]);
    deps.list
      .mockResolvedValueOnce({ objects: [first], cursor: 'page-2' })
      .mockResolvedValueOnce({ objects: [], cursor: 'page-3' })
      .mockResolvedValueOnce({ objects: [second] });
    // The reference advances during the scan. The second page must not use a
    // stale cached reference and delete the now-current object.
    deps.currentKey.mockResolvedValueOnce(first.key).mockResolvedValueOnce(second.key);

    const result = await prunePayloads(deps, { now, dryRun: false });

    expect(deps.list.mock.calls).toEqual([[undefined], ['page-2'], ['page-3']]);
    expect(deps.currentKey.mock.calls).toEqual([['R_a'], ['R_a']]);
    expect(result.scanned).toBe(2);
    expect(deps.delete).not.toHaveBeenCalled();
  });

  it('deletes in page-sized batches and can safely run again after a partial failure', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      snapshot('R_a', new Date(Date.parse(old) + index).toISOString()),
    );
    const last = snapshot('R_a', newer);
    const deps = dependencies([]);
    deps.list
      .mockResolvedValueOnce({ objects: firstPage, cursor: 'page-2' })
      .mockResolvedValueOnce({ objects: [last] });
    deps.delete.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('R2 unavailable'));

    await expect(prunePayloads(deps, { now, dryRun: false })).rejects.toThrow('R2 unavailable');
    expect(deps.delete.mock.calls.map(([keys]) => keys.length)).toEqual([1000, 1]);

    deps.list.mockResolvedValue({ objects: [last] });
    const retried = await prunePayloads(deps, { now, dryRun: false });
    expect(retried.deleted).toBe(1);
  });

  it('does not delete when the current D1 reference cannot be read', async () => {
    const deps = dependencies([snapshot('R_a', old)]);
    deps.currentKey.mockRejectedValue(new Error('D1 unavailable'));

    await expect(prunePayloads(deps, { now, dryRun: false })).rejects.toThrow('D1 unavailable');

    expect(deps.delete).not.toHaveBeenCalled();
  });

  it('surfaces listing failures without attempting deletions', async () => {
    const deps = dependencies([]);
    deps.list.mockRejectedValue(new Error('R2 unavailable'));

    await expect(prunePayloads(deps, { now, dryRun: false })).rejects.toThrow('R2 unavailable');

    expect(deps.delete).not.toHaveBeenCalled();
  });
});
