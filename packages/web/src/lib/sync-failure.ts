import { RepoChangedError, RepoNotFoundError } from '@bilan/core';

/** The repository a run syncs, by the name the Workflow looks it up with. */
interface RepoName {
  owner: string;
  name: string;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Why a sync failed, in words the sync model may keep. The model's history
 * outlives private data and records repositories by id only, so the reason
 * never names the repository: the two errors that are about the repository
 * get a sentence of their own, and any other message (GitHub's own error
 * text included) has `owner/name`, in any letter case, replaced. The job's
 * owner reads this sentence (`syncErrorText`), and already knows which
 * repository it is about.
 */
export function failureReason(error: unknown, repo: RepoName): string {
  if (error instanceof RepoNotFoundError) {
    return 'The repository was not found or is no longer accessible';
  }
  if (error instanceof RepoChangedError) {
    return 'The repository was renamed, transferred, or replaced; start a new sync';
  }
  const message = error instanceof Error ? error.message : String(error);
  const named = new RegExp(`${escape(repo.owner)}/${escape(repo.name)}`, 'gi');
  return message.replace(named, 'the repository');
}
