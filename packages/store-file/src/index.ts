import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { writePrivateFile } from './private-file.ts';

import type { RawPr, RepoMeta, SyncStore } from '@bilan/core';

export { writePrivateFile } from './private-file.ts';

interface FileShape {
  /** Matches page records to the snapshot they extend. */
  journalId?: string;
  repo: string;
  syncedAt: string | null;
  /** Absent in files written before coverage existed; those came from full walks. */
  coverageSince?: string | null;
  /** Absent in files written before the open-PR completeness stamp existed. */
  openPrsSyncedAt?: string | null;
  /**
   * Set by the first `markStarted` after a completion, cleared by a complete
   * `markSynced`; still set on load means the last run never finished. Absent
   * in older files, which counts as finished.
   */
  syncStartedAt?: string | null;
  /** See `RepoMeta.reconciledAt`. Absent in files written before it existed. */
  reconciledAt?: string | null;
  prs: Record<string, RawPr>;
}

/** Earliest of two coverage bounds, where `null` (full history) beats any instant. */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/**
 * An atomic JSON snapshot plus an append-only journal of pages. A completed
 * run compacts the journal, keeping writes linear in the synced data size.
 */
export class FileStore implements SyncStore {
  private readonly path: string;
  private readonly data: FileShape;
  private readonly journalPath: string;
  private tornJournalAt: number | undefined;

  constructor(path: string, repo: string) {
    this.path = path;
    this.journalPath = `${path}.journal`;
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as FileShape)
      : { repo, syncedAt: null, prs: {} };
    this.data.repo = repo;
    if (existsSync(this.journalPath)) {
      const journal = readFileSync(this.journalPath);
      const end = journal.lastIndexOf(10) + 1;
      // A killed process can leave an incomplete final record. Its earlier
      // pages are durable; discard the torn tail before the next append.
      if (end < journal.length) this.tornJournalAt = end;
      for (const line of journal.subarray(0, end).toString('utf8').split('\n')) {
        if (line) {
          const record = JSON.parse(line) as { journalId: string; prs: RawPr[] };
          if (record.journalId === this.data.journalId) {
            for (const pr of record.prs) this.data.prs[pr.number] = pr;
          }
        }
      }
    }
  }

  meta(): Promise<RepoMeta> {
    return Promise.resolve({
      repo: this.data.repo,
      syncedAt: this.data.syncedAt,
      coverageSince: this.data.coverageSince ?? null,
      openPrsSyncedAt: this.data.openPrsSyncedAt ?? null,
      interrupted: (this.data.syncStartedAt ?? null) !== null,
      syncStartedAt: this.data.syncStartedAt ?? null,
      reconciledAt: this.data.reconciledAt ?? null,
    });
  }

  updatedAtByNumber(numbers: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const n of numbers) {
      const pr = this.data.prs[n];
      if (pr) out.set(n, pr.updatedAt);
    }
    return Promise.resolve(out);
  }

  upsert(prs: RawPr[]): Promise<void> {
    for (const pr of prs) this.data.prs[pr.number] = pr;
    if (
      !existsSync(this.path) ||
      this.data.journalId === undefined ||
      lstatSync(this.path).isSymbolicLink() ||
      (process.platform !== 'win32' && (lstatSync(this.path).mode & 0o777) !== 0o600)
    ) {
      this.flush();
    } else if (prs.length) {
      chmodSync(dirname(this.path), 0o700);
      if (this.tornJournalAt !== undefined) {
        truncateSync(this.journalPath, this.tornJournalAt);
        this.tornJournalAt = undefined;
      }
      const fd = openSync(
        this.journalPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, `${JSON.stringify({ journalId: this.data.journalId, prs })}\n`);
      } finally {
        closeSync(fd);
      }
    }
    return Promise.resolve();
  }

  all(): Promise<RawPr[]> {
    return Promise.resolve(Object.values(this.data.prs));
  }

  markStarted(at: string): Promise<void> {
    // Keep the earliest start across consecutive unfinished runs.
    this.data.syncStartedAt ??= at;
    this.flush();
    return Promise.resolve();
  }

  markSynced(
    at: string,
    coverageSince: string | null,
    openPrsComplete: boolean,
    complete: boolean,
  ): Promise<void> {
    this.data.coverageSince =
      this.data.syncedAt === null
        ? coverageSince
        : earliest(this.data.coverageSince ?? null, coverageSince);
    this.data.syncedAt = at;
    // Older files lack these fields; write them out explicitly from now on.
    this.data.openPrsSyncedAt ??= null;
    this.data.reconciledAt ??= null;
    if (complete) {
      // The run began at `syncStartedAt`; everything updated since then has
      // now been compared against GitHub. A retried completion finds the
      // marker already cleared and keeps the watermark as it is.
      this.data.reconciledAt = this.data.syncStartedAt ?? this.data.reconciledAt;
      this.data.syncStartedAt = null;
      if (openPrsComplete) this.data.openPrsSyncedAt = at;
    }
    this.flush();
    return Promise.resolve();
  }

  get size(): number {
    return Object.keys(this.data.prs).length;
  }

  private flush(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode does not tighten a cache directory created by an older CLI.
    chmodSync(directory, 0o700);
    const journalId = randomUUID();
    writePrivateFile(this.path, JSON.stringify({ ...this.data, journalId }));
    this.data.journalId = journalId;
    // Old records cannot overwrite a newer snapshot if the process dies
    // after this rename, or a fresh sync replaces the snapshot separately.
    rmSync(this.journalPath, { force: true });
    this.tornJournalAt = undefined;
  }
}
