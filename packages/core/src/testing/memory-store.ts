import type { SyncStore } from '../sync/store.ts';
import type { RawPr, RepoMeta, SyncCheckpoints } from '../types.ts';

/**
 * Follows the same rules as the real stores: keeps the earliest bound it is
 * given (the first stamp is taken as is), keeps the earliest start across
 * consecutive unfinished runs, and only a complete run promotes that start to
 * `reconciledAt`, clears it, and may stamp `openPrsSyncedAt`.
 */
export class MemoryStore implements SyncStore {
  prs = new Map<number, RawPr>();
  syncedAt: string | null = null;
  coverageSince: string | null = null;
  openPrsSyncedAt: string | null = null;
  startedAt: string | null = null;
  reconciledAt: string | null = null;
  meta(): Promise<RepoMeta> {
    return Promise.resolve({
      repo: 'acme/widgets',
      syncedAt: this.syncedAt,
      coverageSince: this.coverageSince,
      openPrsSyncedAt: this.openPrsSyncedAt,
      interrupted: this.startedAt !== null,
      syncStartedAt: this.startedAt,
      reconciledAt: this.reconciledAt,
    });
  }
  updatedAtByNumber(numbers: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const n of numbers) {
      const pr = this.prs.get(n);
      if (pr) out.set(n, pr.updatedAt);
    }
    return Promise.resolve(out);
  }
  upsert(prs: RawPr[]): Promise<void> {
    for (const pr of prs) this.prs.set(pr.number, pr);
    return Promise.resolve();
  }
  all(): Promise<RawPr[]> {
    return Promise.resolve([...this.prs.values()]);
  }
  markStarted(at: string): Promise<void> {
    this.startedAt ??= at;
    return Promise.resolve();
  }
  markSynced(
    at: string,
    coverageSince: string | null,
    openPrsComplete: boolean,
    complete: boolean,
  ): Promise<void> {
    if (this.syncedAt === null || coverageSince === null || this.coverageSince === null) {
      this.coverageSince = this.syncedAt === null ? coverageSince : null;
    } else if (Date.parse(coverageSince) < Date.parse(this.coverageSince)) {
      this.coverageSince = coverageSince;
    }
    this.syncedAt = at;
    if (complete) {
      this.reconciledAt = this.startedAt ?? this.reconciledAt;
      this.startedAt = null;
      if (openPrsComplete) this.openPrsSyncedAt = at;
    }
    return Promise.resolve();
  }
}

/** A `MemoryStore` that also keeps checkpoints, as the file store does. */
export class CheckpointStore extends MemoryStore {
  checkpoints: SyncCheckpoints | undefined;
  override meta(): Promise<RepoMeta> {
    return super
      .meta()
      .then((meta) =>
        this.checkpoints === undefined ? meta : { ...meta, checkpoints: this.checkpoints },
      );
  }
  saveCheckpoints(checkpoints: SyncCheckpoints): Promise<void> {
    this.checkpoints = checkpoints;
    return Promise.resolve();
  }
}
