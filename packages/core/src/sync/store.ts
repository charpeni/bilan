import type { RawPr, RepoMeta, SyncCheckpoints } from '../types.ts';

/**
 * Where synced PRs live. The file store (CLI) and the D1 store (web) both
 * implement this; the engine never touches storage directly.
 */
export interface SyncStore {
  meta(): Promise<RepoMeta>;
  /** `updatedAt` per PR number, used to decide whether a page changed anything. */
  updatedAtByNumber(numbers: number[]): Promise<Map<number, string>>;
  upsert(prs: RawPr[]): Promise<void>;
  all(): Promise<RawPr[]>;
  /**
   * Record that a run is in flight; cleared by a complete `markSynced`. See
   * `RepoMeta.interrupted` and `RepoMeta.syncStartedAt`. Only the first call
   * after a completion takes: consecutive unfinished runs keep the earliest
   * start, which is what `reconciledAt` becomes once a run completes.
   */
  markStarted(at: string): Promise<void>;
  /**
   * Publish a run. Every call stamps `syncedAt = at` and widens coverage:
   * `coverageSince` is the bound this run guaranteed (`null` = full history)
   * and the store keeps the earliest bound it has ever been given.
   *
   * `complete` means the run reconciled everything it set out to (main pass
   * reached `since`, the end, or already-synced pages; open pass reached the
   * end or was not needed): the store then sets `reconciledAt` to the instant
   * recorded by `markStarted`, clears the in-flight marker, and, when
   * `openPrsComplete` is also set, stamps `openPrsSyncedAt = at`. A budget-cut
   * run (`complete: false`) leaves the in-flight marker, `reconciledAt` and
   * `openPrsSyncedAt` untouched, so the next run treats it as interrupted.
   *
   * A complete call is idempotent: when the in-flight marker is already clear
   * (a retried completion), `reconciledAt` keeps its value.
   */
  markSynced(
    at: string,
    coverageSince: string | null,
    openPrsComplete: boolean,
    complete: boolean,
  ): Promise<void>;
  /**
   * Optional: keep `checkpoints` for `meta()`, durably once this resolves,
   * even if the run never reaches `markSynced`. The engine calls it after the
   * page it describes is stored. A store without it (or whose `meta()` omits
   * them) makes every run walk down from the newest page.
   */
  saveCheckpoints?(checkpoints: SyncCheckpoints): Promise<void>;
}
