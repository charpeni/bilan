import type { ActorType, RawPr } from '../types.ts';
import type { PullRequestNode } from './query.ts';

/** Shrink a GraphQL node into the flat shape every store keeps. */
export function compact(pr: PullRequestNode): RawPr {
  const timeline = pr.timelineItems.nodes;
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    mergedAt: pr.mergedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    baseRefName: pr.baseRefName,
    author: pr.author?.login ?? null,
    authorType: (pr.author?.__typename as ActorType | undefined) ?? null,
    mergedBy: pr.mergedBy?.login ?? null,
    labels: pr.labels.nodes.map((l) => l.name),
    comments: pr.comments.totalCount,
    reviewThreads: pr.reviewThreads.totalCount,
    fileSample: pr.files?.nodes.map((f) => f.path) ?? [],
    fileCount: pr.files?.totalCount ?? pr.changedFiles,
    reviewCount: pr.reviews.totalCount,
    reviews: pr.reviews.nodes.map((r) => ({
      author: r.author?.login ?? null,
      authorType: (r.author?.__typename as ActorType | undefined) ?? null,
      state: r.state,
      at: r.submittedAt,
    })),
    readyAt:
      pr.readyEvents?.nodes.map((t) => t.createdAt) ??
      timeline.filter((t) => t.__typename === 'ReadyForReviewEvent').map((t) => t.createdAt),
    draftedAt:
      pr.draftEvents?.nodes.map((t) => t.createdAt) ??
      timeline.filter((t) => t.__typename === 'ConvertToDraftEvent').map((t) => t.createdAt),
    reviewRequests: timeline
      .filter((t) => t.__typename === 'ReviewRequestedEvent')
      .map((t) => ({
        at: t.createdAt,
        to:
          t.requestedReviewer === null
            ? null
            : 'login' in t.requestedReviewer
              ? t.requestedReviewer.login
              : t.requestedReviewer.name,
      })),
  };
}
