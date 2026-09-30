import {
  chmodSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileStore } from './index.ts';

import type { RawPr } from '@bilan/core';

const pr = (number: number, updatedAt: string): RawPr => ({
  number,
  title: `PR ${number}`,
  state: 'OPEN',
  isDraft: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt,
  closedAt: null,
  mergedAt: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  baseRefName: 'main',
  author: 'alice',
  authorType: 'User',
  mergedBy: null,
  labels: [],
  comments: 0,
  reviewThreads: 0,
  fileSample: [],
  fileCount: 0,
  reviewCount: 0,
  reviews: [],
  readyAt: [],
  draftedAt: [],
  reviewRequests: [],
});

describe('FileStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bilan-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === 'win32')(
    'keeps fresh and replaced private caches owner-only',
    async () => {
      const path = join(dir, 'acme', 'private.json');
      const store = new FileStore(path, 'acme/private');
      await store.upsert([pr(1, 'a')]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);

      // Simulate a cache written by an older release under umask 022.
      chmodSync(path, 0o644);
      chmodSync(dirname(path), 0o755);
      await store.upsert([pr(2, 'b')]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(new FileStore(path, 'acme/private').size).toBe(2);
    },
  );

  it('persists upserts and syncedAt across instances', async () => {
    const path = join(dir, 'acme', 'widgets.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.upsert([pr(1, 'a'), pr(2, 'b')]);
    await store.upsert([pr(2, 'c')]);
    await store.markSynced('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z', true, true);

    const reopened = new FileStore(path, 'acme/widgets');
    expect(reopened.size).toBe(2);
    expect(await reopened.updatedAtByNumber([1, 2, 3])).toEqual(
      new Map([
        [1, 'a'],
        [2, 'c'],
      ]),
    );
    expect(await reopened.meta()).toEqual({
      repo: 'acme/widgets',
      syncedAt: '2026-02-01T00:00:00Z',
      coverageSince: '2026-01-01T00:00:00Z',
      openPrsSyncedAt: '2026-02-01T00:00:00Z',
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: null,
    });
    expect((await reopened.all()).map((p) => p.number).toSorted()).toEqual([1, 2]);
    expect(JSON.parse(readFileSync(path, 'utf8')).repo).toBe('acme/widgets');
  });

  it('persists each page without rewriting the snapshot and compacts on completion', async () => {
    const path = join(dir, 'journal.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markStarted('2026-01-01T00:00:00Z');
    const snapshot = readFileSync(path, 'utf8');
    for (let page = 0; page < 10; page++) {
      await store.upsert(Array.from({ length: 25 }, (_, i) => pr(page * 25 + i + 1, 'a')));
    }
    expect(readFileSync(path, 'utf8') === snapshot).toBe(true);
    expect(new FileStore(path, 'acme/widgets').size).toBe(250);
    if (process.platform !== 'win32') expect(statSync(`${path}.journal`).mode & 0o777).toBe(0o600);
    await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
    expect(existsSync(`${path}.journal`)).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).prs)).toHaveLength(250);
    expect((await new FileStore(path, 'acme/widgets').meta()).interrupted).toBe(false);
  });

  it('recovers complete pages before a torn final journal record and can resume', async () => {
    const path = join(dir, 'torn.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markStarted('2026-01-01T00:00:00Z');
    await store.upsert([pr(1, 'a')]);
    const { journalId } = JSON.parse(readFileSync(path, 'utf8'));
    appendFileSync(
      `${path}.journal`,
      `${JSON.stringify({ journalId, prs: [pr(2, 'b')] })}\n[{"number":3`,
    );
    const reopened = new FileStore(path, 'acme/widgets');
    expect(reopened.size).toBe(2);
    expect((await reopened.meta()).interrupted).toBe(true);
    await reopened.upsert([pr(3, 'c')]);
    expect(new FileStore(path, 'acme/widgets').size).toBe(3);
  });

  it('ignores a journal from an older snapshot left behind during replacement', async () => {
    const path = join(dir, 'replacement.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markStarted('2026-01-01T00:00:00Z');
    await store.upsert([pr(1, 'old')]);
    const oldJournal = readFileSync(`${path}.journal`);
    await store.upsert([pr(1, 'new')]);
    await store.markSynced('2026-01-02T00:00:00Z', null, true, true);
    writeFileSync(`${path}.journal`, oldJournal);
    expect(await new FileStore(path, 'acme/widgets').updatedAtByNumber([1])).toEqual(
      new Map([[1, 'new']]),
    );
  });

  it('starts with no coverage and takes the first bound as given', async () => {
    const store = new FileStore(join(dir, 'fresh.json'), 'acme/widgets');
    expect(await store.meta()).toEqual({
      repo: 'acme/widgets',
      syncedAt: null,
      coverageSince: null,
      openPrsSyncedAt: null,
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: null,
    });
    await store.markSynced('2026-02-01T00:00:00Z', '2026-01-02T00:00:00Z', false, true);
    expect((await store.meta()).coverageSince).toBe('2026-01-02T00:00:00Z');
  });

  it('only widens coverage: earlier wins and null (full history) beats any instant', async () => {
    const store = new FileStore(join(dir, 'widen.json'), 'acme/widgets');
    await store.markSynced('2026-02-01T00:00:00Z', '2026-01-02T00:00:00Z', false, true);
    await store.markSynced('2026-02-02T00:00:00Z', '2026-01-20T00:00:00Z', false, true);
    expect((await store.meta()).coverageSince).toBe('2026-01-02T00:00:00Z');
    await store.markSynced('2026-02-03T00:00:00Z', '2025-12-01T00:00:00Z', false, true);
    expect((await store.meta()).coverageSince).toBe('2025-12-01T00:00:00Z');
    await store.markSynced('2026-02-04T00:00:00Z', null, false, true);
    expect((await store.meta()).coverageSince).toBeNull();
    await store.markSynced('2026-02-05T00:00:00Z', '2026-01-02T00:00:00Z', false, true);
    expect(await store.meta()).toEqual({
      repo: 'acme/widgets',
      syncedAt: '2026-02-05T00:00:00Z',
      coverageSince: null,
      openPrsSyncedAt: null,
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: null,
    });
  });

  it('stamps openPrsSyncedAt on a complete open walk and keeps it across incomplete ones', async () => {
    const path = join(dir, 'open.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markSynced('2026-02-01T00:00:00Z', '2026-01-02T00:00:00Z', false, true);
    expect((await store.meta()).openPrsSyncedAt).toBeNull();
    await store.markSynced('2026-02-02T00:00:00Z', '2026-01-02T00:00:00Z', true, true);
    expect((await store.meta()).openPrsSyncedAt).toBe('2026-02-02T00:00:00Z');
    await store.markSynced('2026-02-03T00:00:00Z', '2026-01-02T00:00:00Z', false, true);
    expect(await store.meta()).toEqual({
      repo: 'acme/widgets',
      syncedAt: '2026-02-03T00:00:00Z',
      coverageSince: '2026-01-02T00:00:00Z',
      openPrsSyncedAt: '2026-02-02T00:00:00Z',
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: null,
    });
    expect((await new FileStore(path, 'acme/widgets').meta()).openPrsSyncedAt).toBe(
      '2026-02-02T00:00:00Z',
    );
  });

  it('treats a file without the fields as full history with no open-PR stamp', async () => {
    const path = join(dir, 'legacy', 'widgets.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ repo: 'acme/widgets', syncedAt: '2026-01-15T00:00:00Z', prs: {} }),
    );
    const store = new FileStore(path, 'acme/widgets');
    expect(await store.meta()).toEqual({
      repo: 'acme/widgets',
      syncedAt: '2026-01-15T00:00:00Z',
      coverageSince: null,
      openPrsSyncedAt: null,
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: null,
    });
    await store.markSynced('2026-02-01T00:00:00Z', '2026-01-02T00:00:00Z', false, true);
    expect((await store.meta()).coverageSince).toBeNull();
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.coverageSince).toBeNull();
    expect(written.openPrsSyncedAt).toBeNull();
    expect(written.syncStartedAt).toBeNull();
    expect(written.reconciledAt).toBeNull();
  });

  it('persists the in-flight stamp so a run that never finished reads as interrupted', async () => {
    const path = join(dir, 'interrupted.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markSynced('2026-02-01T00:00:00Z', '2026-01-02T00:00:00Z', true, true);
    await store.markStarted('2026-02-02T00:00:00Z');
    expect((await store.meta()).interrupted).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).syncStartedAt).toBe('2026-02-02T00:00:00Z');
    // The process dies here; a new one opens the same file.
    const reopened = new FileStore(path, 'acme/widgets');
    expect(await reopened.meta()).toEqual({
      repo: 'acme/widgets',
      syncedAt: '2026-02-01T00:00:00Z',
      coverageSince: '2026-01-02T00:00:00Z',
      openPrsSyncedAt: '2026-02-01T00:00:00Z',
      interrupted: true,
      syncStartedAt: '2026-02-02T00:00:00Z',
      reconciledAt: null,
    });
    await reopened.markSynced('2026-02-03T00:00:00Z', '2026-01-02T00:00:00Z', true, true);
    expect((await reopened.meta()).interrupted).toBe(false);
    expect((await reopened.meta()).reconciledAt).toBe('2026-02-02T00:00:00Z');
    expect(JSON.parse(readFileSync(path, 'utf8')).syncStartedAt).toBeNull();
    expect((await new FileStore(path, 'acme/widgets').meta()).interrupted).toBe(false);
  });

  it('a complete run promotes the start stamp to reconciledAt; an incomplete one keeps everything', async () => {
    const path = join(dir, 'partial.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markStarted('2026-02-01T00:00:00Z');
    await store.markSynced('2026-02-01T00:05:00Z', '2026-01-02T00:00:00Z', true, true);
    expect(await store.meta()).toMatchObject({
      interrupted: false,
      reconciledAt: '2026-02-01T00:00:00Z',
      openPrsSyncedAt: '2026-02-01T00:05:00Z',
    });

    // A budget-cut run: syncedAt moves and coverage widens, nothing else does.
    await store.markStarted('2026-02-02T00:00:00Z');
    await store.markSynced('2026-02-02T00:05:00Z', '2025-12-01T00:00:00Z', false, false);
    const expected = {
      repo: 'acme/widgets',
      syncedAt: '2026-02-02T00:05:00Z',
      coverageSince: '2025-12-01T00:00:00Z',
      openPrsSyncedAt: '2026-02-01T00:05:00Z',
      interrupted: true,
      syncStartedAt: '2026-02-02T00:00:00Z',
      reconciledAt: '2026-02-01T00:00:00Z',
    };
    expect(await store.meta()).toEqual(expected);
    expect(await new FileStore(path, 'acme/widgets').meta()).toEqual(expected);
    expect(JSON.parse(readFileSync(path, 'utf8')).syncStartedAt).toBe('2026-02-02T00:00:00Z');

    // The run after that completes and takes over both stamps.
    await store.markStarted('2026-02-03T00:00:00Z');
    await store.markSynced('2026-02-03T00:05:00Z', '2025-12-01T00:00:00Z', true, true);
    expect(await store.meta()).toEqual({
      ...expected,
      syncedAt: '2026-02-03T00:05:00Z',
      openPrsSyncedAt: '2026-02-03T00:05:00Z',
      interrupted: false,
      syncStartedAt: null,
      // The earliest unfinished start, not this run's: nothing updated since
      // the cut run began had been reconciled until now.
      reconciledAt: '2026-02-02T00:00:00Z',
    });
  });

  it('markStarted keeps the earliest start across consecutive unfinished runs', async () => {
    const path = join(dir, 'earliest.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markStarted('2026-02-01T00:00:00Z');
    await store.markSynced('2026-02-01T00:05:00Z', '2026-01-02T00:00:00Z', false, false);
    await store.markStarted('2026-02-02T00:00:00Z');
    expect((await store.meta()).syncStartedAt).toBe('2026-02-01T00:00:00Z');
    expect(JSON.parse(readFileSync(path, 'utf8')).syncStartedAt).toBe('2026-02-01T00:00:00Z');
    await store.markSynced('2026-02-02T00:05:00Z', '2026-01-02T00:00:00Z', true, true);
    expect(await store.meta()).toMatchObject({
      syncStartedAt: null,
      reconciledAt: '2026-02-01T00:00:00Z',
    });
    // Once cleared, the next start takes.
    await store.markStarted('2026-02-03T00:00:00Z');
    expect((await store.meta()).syncStartedAt).toBe('2026-02-03T00:00:00Z');
  });

  it('a retried complete markSynced keeps the watermark', async () => {
    const path = join(dir, 'retry.json');
    const store = new FileStore(path, 'acme/widgets');
    await store.markStarted('2026-02-01T00:00:00Z');
    await store.markSynced('2026-02-01T00:05:00Z', '2026-01-02T00:00:00Z', true, true);
    expect((await store.meta()).reconciledAt).toBe('2026-02-01T00:00:00Z');
    // The step that followed failed and the completion runs again.
    await store.markSynced('2026-02-01T00:05:00Z', '2026-01-02T00:00:00Z', true, true);
    expect(await store.meta()).toEqual({
      repo: 'acme/widgets',
      syncedAt: '2026-02-01T00:05:00Z',
      coverageSince: '2026-01-02T00:00:00Z',
      openPrsSyncedAt: '2026-02-01T00:05:00Z',
      interrupted: false,
      syncStartedAt: null,
      reconciledAt: '2026-02-01T00:00:00Z',
    });
    expect((await new FileStore(path, 'acme/widgets').meta()).reconciledAt).toBe(
      '2026-02-01T00:00:00Z',
    );
  });
});
