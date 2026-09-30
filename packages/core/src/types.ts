/** `owner/name` split into its parts. */
export interface RepoRef {
  owner: string;
  name: string;
}

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
export type ActorType = 'User' | 'Bot' | 'Organization' | 'Mannequin' | 'EnterpriseUserAccount';

export interface RawReview {
  author: string | null;
  authorType: ActorType | null;
  state: ReviewState;
  /** ISO timestamp of the submitted review. */
  at: string | null;
}

export interface RawReviewRequest {
  at: string;
  /** User login or team name; null when the reviewer could not be resolved. */
  to: string | null;
}

/**
 * The flat, per-PR shape kept in every sync store. It is what the GraphQL node is
 * compacted into, so it is the unit of incremental sync (`updatedAt` decides
 * whether a PR is stale) and the input of the derive step.
 */
export interface RawPr {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  author: string | null;
  authorType: ActorType | null;
  mergedBy: string | null;
  labels: string[];
  comments: number;
  reviewThreads: number;
  /** Up to the first 30 changed paths; `fileCount` is the true total. */
  fileSample: string[];
  fileCount: number;
  reviewCount: number;
  /** Up to the first 40 reviews; `reviewCount` is the true total. */
  reviews: RawReview[];
  /** Timestamps of ReadyForReviewEvent, in timeline order. */
  readyAt: string[];
  /** Timestamps of ConvertToDraftEvent, in timeline order. */
  draftedAt: string[];
  reviewRequests: RawReviewRequest[];
}

/** What a store knows about a repo beyond its PRs. */
export interface RepoMeta {
  repo: string;
  syncedAt: string | null;
  /**
   * ISO instant: every PR updated at or after this is guaranteed to be in the
   * store, plus every PR that is currently open. `null` means full history.
   * Only ever moves earlier; a shallower later sync never shrinks coverage.
   */
  coverageSince: string | null;
  /**
   * ISO instant of the last run that walked every open PR to the end (or the
   * whole history). `null` means the open-PR set may be incomplete, so the
   * dashboard must not claim "plus all open PRs" and the sync engine must not
   * stop early on unchanged open pages.
   */
  openPrsSyncedAt: string | null;
  /**
   * True when a previous run began (`markStarted`) but never reached
   * `markSynced`: rows written by that run look "unchanged" to the next run,
   * so the next run must not stop early on unchanged pages.
   */
  interrupted: boolean;
  /**
   * ISO instant the earliest unfinished run began (`markStarted`), kept across
   * consecutive unfinished runs and cleared once a run completes. `null` when
   * no run is in flight. While `reconciledAt` is `null` this is the only safe
   * catch-up watermark: nothing updated at/after it has been reconciled.
   */
  syncStartedAt: string | null;
  /**
   * Start time of the last run that reconciled everything it set out to: every
   * PR updated at/after this instant has been compared against GitHub since.
   * Catch-up walks reach back to it. `null` until a run completes.
   */
  reconciledAt: string | null;
}

/** `[reviewer, state, submittedAt]` with the timestamp in epoch ms. */
export type PayloadReview = [string, ReviewState, number];
/** `[reviewer, requestedAt]` with the timestamp in epoch ms. */
export type PayloadReviewRequest = [string, number];

/**
 * The per-PR record the dashboard consumes. Field names are deliberately short:
 * this is embedded in the HTML report and shipped to the browser as JSON.
 */
export interface PayloadPr {
  /** number */
  n: number;
  /** title */
  t: string;
  /** author login */
  a: string | null;
  /** author is a bot (1) or not (0) */
  bot: 0 | 1;
  /** createdAt, epoch ms */
  c: number;
  /** ready-for-review time, epoch ms; null when the PR was never reviewable */
  r: number | null;
  /** opened as draft (1) or ready (0) */
  d: 0 | 1;
  /** mergedAt, epoch ms */
  m: number | null;
  /** closedAt, epoch ms */
  x: number | null;
  /** state */
  s: PrState;
  /** currently a draft (1) or not (0) */
  dr: 0 | 1;
  /** merged-by login */
  mb: string | null;
  /** additions */
  ad: number;
  /** deletions */
  de: number;
  /** changed files */
  cf: number;
  /** areas touched, derived from the file sample */
  ar: string[];
  /** comment count */
  cm: number;
  /** review thread count */
  th: number;
  /** review count (true total) */
  rc: number;
  /** reviews by someone other than the author, sorted by time */
  rv: PayloadReview[];
  /** review requests with a resolved reviewer */
  rq: PayloadReviewRequest[];
}

export interface Payload {
  repo: string;
  syncedAt: string | null;
  /** Absent in older snapshots; true when cached rows may be stale after an unfinished run. */
  interrupted?: boolean;
  /** The last complete run's start, when available; see `RepoMeta.reconciledAt`. */
  reconciledAt?: string | null;
  /** See `RepoMeta.coverageSince`; the dashboard disables ranges that reach past it. */
  coverageSince: string | null;
  /** See `RepoMeta.openPrsSyncedAt`. */
  openPrsSyncedAt: string | null;
  /** Every area that can appear in `PayloadPr.ar`, in display order. */
  areas: string[];
  /** Logins detected as bots, so the dashboard can filter reviewers too. */
  bots: string[];
  /** Sorted by `c` ascending. */
  prs: PayloadPr[];
}
