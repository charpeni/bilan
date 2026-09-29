/**
 * What a sync page can honestly say about progress. A full-history run has a
 * known target (the repository's PR count from GitHub), so it gets a ratio. A
 * bounded run (the 30-day default, or deeper "load more") reads only the PRs
 * updated in its window plus every open one; that count is not known until the
 * walk ends, so the page shows what has been read against the repository's
 * total without pretending to know the fraction. A staged first sync (see
 * `syncStages`) says which stage it is in instead.
 */
export interface SyncProgress {
  /** Rows stored for the repo so far. */
  read: number;
  /** PRs the repository has in total on GitHub, when known. */
  total: number | null;
  /** 0..1 when the target is known (full runs), null otherwise. */
  fraction: number | null;
  /** Human sentence for the page. */
  label: string;
}

/**
 * Where a staged first sync is (see `syncStages`): the interim 7-day stage,
 * or the 30-day stage after the interim payload was published.
 */
export interface SyncStageInfo {
  current: number;
  total: number;
  /** The window this stage reads, for the progress sentence: `last 7 days`. */
  window: string;
  /** Human sentence for the page. */
  label: string;
}

/**
 * `GET /payload` answers the repo's `coverage_since` (empty for none or full
 * history) so a page watching an interim payload can say how far it reaches.
 */
export const COVERAGE_SINCE_HEADER = 'x-bilan-coverage-since';

const STAGES: readonly SyncStageInfo[] = [
  {
    current: 1,
    total: 2,
    window: 'last 7 days',
    label: 'Reading the last 7 days; up to 30 days follow',
  },
  {
    current: 2,
    total: 2,
    window: 'up to 30 days',
    label: 'Last 7 days published; reading up to 30 days',
  },
];

/**
 * Which stage a running job is in, derived from the rows alone: the job row
 * does not record its depth, so a first sync (no payload yet) is taken to be
 * the default, staged one (the page only ever starts a repo's first sync at
 * the default depth; an explicit deeper first load through the API reads as
 * stage 1 until it publishes). A payload published after the job was queued,
 * while the job still runs and the store's in-flight marker is still set, can
 * only be this job's interim one: stage 2. A payload older than the job is a
 * previous sync's: a single-stage run, no stage to report.
 */
export function syncStage(input: {
  job: { status: string; createdAt: string };
  repo: { lastSyncedAt: string | null; syncStartedAt: string | null } | null | undefined;
}): SyncStageInfo | null {
  const { job, repo } = input;
  if (job.status !== 'running' || !repo) return null;
  if (repo.lastSyncedAt === null) return STAGES[0] ?? null;
  if (repo.syncStartedAt === null) return null;
  return Date.parse(repo.lastSyncedAt) >= Date.parse(job.createdAt) ? (STAGES[1] ?? null) : null;
}

const n = (v: number) => v.toLocaleString('en-US');

export function syncProgress(input: {
  mode: string;
  prsStored: number;
  totalPrs: number | null;
  /** The stage of a staged first sync, when the run is one (see `syncStage`). */
  stage?: SyncStageInfo | null;
}): SyncProgress {
  const read = Math.max(0, input.prsStored);
  const total = input.totalPrs !== null && input.totalPrs > 0 ? input.totalPrs : null;
  const stage = input.stage ?? null;
  if (stage !== null) {
    return {
      read,
      total,
      fraction: null,
      label: `${n(read)} pull requests read · stage ${stage.current} of ${stage.total} (${stage.window})`,
    };
  }
  if (input.mode === 'full' && total !== null) {
    const fraction = Math.min(1, read / total);
    return {
      read,
      total,
      fraction,
      label: `${n(read)} of ${n(total)} pull requests · ${Math.round(fraction * 100)}%`,
    };
  }
  return {
    read,
    total,
    fraction: null,
    label:
      total === null
        ? `${n(read)} pull requests read`
        : `${n(read)} pull requests read · the repository has ${n(total)} in total`,
  };
}
