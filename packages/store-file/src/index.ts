import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RawPr, RepoMeta, SyncStore } from '@bilan/core';

interface FileShape {
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
 * One JSON file per repo, written atomically. Small enough to hold in memory
 * for any repo the CLI is likely to see; the web app uses a database instead.
 */
export class FileStore implements SyncStore {
  private readonly path: string;
  private readonly data: FileShape;

  constructor(path: string, repo: string) {
    this.path = path;
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as FileShape)
      : { repo, syncedAt: null, prs: {} };
    this.data.repo = repo;
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
    this.flush();
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
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
