/**
 * Pull requests newest-updated first, with just enough nested data for the
 * metrics. `$states` narrows to those states; omit it (or pass null) for all.
 */
export const PULL_REQUESTS_QUERY = `
query($owner:String!, $name:String!, $page:Int!, $cursor:String, $states:[PullRequestState!]) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:$page, after:$cursor, states:$states, orderBy:{field:UPDATED_AT, direction:DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft
        createdAt updatedAt closedAt mergedAt
        additions deletions changedFiles
        baseRefName
        author { login __typename }
        mergedBy { login }
        labels(first:10) { nodes { name } }
        comments { totalCount }
        reviewThreads { totalCount }
        files(first:30) { totalCount nodes { path } }
        reviews(first:40) {
          totalCount
          nodes { author { login __typename } state submittedAt }
        }
        readyEvents: timelineItems(first:1, itemTypes:[READY_FOR_REVIEW_EVENT]) {
          nodes { ... on ReadyForReviewEvent { createdAt } }
        }
        draftEvents: timelineItems(first:1, itemTypes:[CONVERT_TO_DRAFT_EVENT]) {
          nodes { ... on ConvertToDraftEvent { createdAt } }
        }
        timelineItems(first:100, itemTypes:[REVIEW_REQUESTED_EVENT]) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on ReadyForReviewEvent { createdAt }
            ... on ConvertToDraftEvent { createdAt }
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer { ... on User { login } ... on Team { name } }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export const PULL_REQUEST_TIMELINE_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      timelineItems(first:100, after:$cursor, itemTypes:[REVIEW_REQUESTED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ReviewRequestedEvent {
            createdAt
            requestedReviewer { ... on User { login } ... on Team { name } }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

/** Cheap probe used for access checks and sync sizing. */
export const REPO_META_QUERY = `
query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    id isPrivate viewerPermission
    pullRequests { totalCount }
  }
  rateLimit { cost remaining resetAt }
}`;

/** The signed-in user behind a token; `databaseId` is the numeric id used as `users.id`. */
export const VIEWER_QUERY = `
query {
  viewer { databaseId login avatarUrl }
}`;

export interface ViewerResult {
  viewer: {
    databaseId: number;
    login: string;
    avatarUrl: string | null;
  };
}

export interface RateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

interface Actor {
  login: string;
  __typename: string;
}

export interface PullRequestNode {
  /** Separate first transitions cannot be crowded out by review requests. */
  readyEvents?: { nodes: { createdAt: string }[] };
  draftEvents?: { nodes: { createdAt: string }[] };
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  author: Actor | null;
  mergedBy: { login: string } | null;
  labels: { nodes: { name: string }[] };
  comments: { totalCount: number };
  reviewThreads: { totalCount: number };
  files: { totalCount: number; nodes: { path: string }[] } | null;
  reviews: {
    totalCount: number;
    nodes: {
      author: Actor | null;
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
      submittedAt: string | null;
    }[];
  };
  timelineItems: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    nodes: (
      | { __typename: 'ReadyForReviewEvent'; createdAt: string }
      | { __typename: 'ConvertToDraftEvent'; createdAt: string }
      | {
          __typename: 'ReviewRequestedEvent';
          createdAt: string;
          requestedReviewer: { login: string } | { name: string } | null;
        }
    )[];
  };
}
export interface PullRequestTimelinePage {
  repository: { pullRequest: { timelineItems: PullRequestNode['timelineItems'] } | null } | null;
  rateLimit: RateLimit;
}

export interface PullRequestsPage {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: PullRequestNode[];
    };
  } | null;
  rateLimit: RateLimit;
}

/** What `GithubClient.repoMeta` returns for a repo the token can see. */
export interface GithubRepoMeta {
  id: string;
  isPrivate: boolean;
  viewerPermission: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ' | null;
  pullRequests: { totalCount: number };
}

export interface RepoMetaResult {
  repository: GithubRepoMeta | null;
  rateLimit: RateLimit;
}
