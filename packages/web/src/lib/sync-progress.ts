/**
 * What a sync page can honestly say about progress. A full-history run has a
 * known target (the repository's PR count from GitHub), so it gets a ratio. A
 * bounded run (the 30-day default, or deeper "load more") reads only the PRs
 * updated in its window plus every open one; that count is not known until the
 * walk ends, so the page shows what has been read against the repository's
 * total without pretending to know the fraction.
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

const n = (v: number) => v.toLocaleString('en-US');

export function syncProgress(input: {
  mode: string;
  prsStored: number;
  totalPrs: number | null;
}): SyncProgress {
  const read = Math.max(0, input.prsStored);
  const total = input.totalPrs !== null && input.totalPrs > 0 ? input.totalPrs : null;
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
