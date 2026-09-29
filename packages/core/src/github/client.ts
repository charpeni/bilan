import { PULL_REQUESTS_QUERY, REPO_META_QUERY, VIEWER_QUERY } from './query.ts';

import type { PrState, RepoRef } from '../types.ts';
import type { PullRequestsPage, RateLimit, RepoMetaResult, ViewerResult } from './query.ts';

export interface GithubClientOptions {
  token: string;
  /** Override for tests or non-standard hosts. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  endpoint?: string;
  /** Retries on network errors, 5xx, and GraphQL errors. Defaults to 4. */
  retries?: number;
  /** Sleep between retries; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, waitMs: number, error: unknown) => void;
}

export class GithubError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GithubError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** One line naming a thrown value: the message of an `Error`, or the value itself. */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? ` (${error.code})` : '';
    return `${error.name}: ${error.message}${code}`;
  }
  return String(error);
}

/**
 * `fetch` rejections (DNS, TLS, reset connections: usually a bare `TypeError`)
 * and unreadable bodies are transport trouble, not GitHub saying no. They are
 * folded into a retryable `GithubError` so callers only ever see `GithubError`
 * or its subclasses.
 */
function transportError(what: string, cause: unknown): GithubError {
  return new GithubError(`${what}: ${describeCause(cause)}`, null, true, { cause });
}

/**
 * A GraphQL response whose only errors are `NOT_FOUND` and that carries no
 * data at all. The repo-level methods map this to `RepoNotFoundError`.
 */
export class GithubNotFoundError extends GithubError {
  constructor(message: string) {
    super(message, null, false);
    this.name = 'GithubNotFoundError';
  }
}

/** Thrown when GitHub says the repo does not exist or the token cannot see it. */
export class RepoNotFoundError extends GithubError {
  constructor(repo: RepoRef) {
    super(`Repository ${repo.owner}/${repo.name} not found or not accessible`, 404, false);
    this.name = 'RepoNotFoundError';
  }
}

export interface Viewer {
  databaseId: number;
  login: string;
  avatarUrl: string | null;
}

export interface PullRequestsPageOptions {
  /** Only PRs in these states; omit for all states. */
  states?: PrState[];
}

interface GraphqlBody<T> {
  data?: T;
  errors?: { message: string; type?: string; path?: (string | number)[] }[];
}

/** GitHub's error bodies are JSON with a `message`; show that instead of the raw body. */
function errorSummary(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.replaceAll(/\s+/g, ' ').trim().slice(0, 200);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Minimal GraphQL client over `fetch`. Every call returns the rate-limit block
 * from the response so callers can budget and stop early.
 */
export class GithubClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: GithubClientOptions['onRetry'];
  /** Field paths GitHub refused on this token (see `request`); empty when every field was readable. */
  forbiddenFields: string[] = [];

  constructor(options: GithubClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? 'https://api.github.com/graphql';
    this.retries = options.retries ?? 4;
    this.sleep = options.sleep ?? defaultSleep;
    this.onRetry = options.onRetry;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.request<T>(query, variables);
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof GithubError) || error.retryable;
        if (!retryable || attempt === this.retries) throw error;
        const wait = 2 ** attempt * 2000;
        this.onRetry?.(attempt + 1, wait, error);
        await this.sleep(wait);
      }
    }
    throw lastError;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'user-agent': 'bilan',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw transportError('GitHub request failed', error);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryable = response.status >= 500 || response.status === 429;
      throw new GithubError(
        `GitHub responded ${response.status}: ${errorSummary(text)}`,
        response.status,
        retryable,
      );
    }

    let body: GraphqlBody<T>;
    try {
      body = (await response.json()) as GraphqlBody<T>;
    } catch (error) {
      throw transportError('GitHub returned an unreadable response', error);
    }
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join('; ');
      // A missing or invisible object comes back as `{ data: { repository: null },
      // errors: [{ type: 'NOT_FOUND' }] }`: the data is the answer, so hand it to
      // the caller, which maps the null to a domain error. Any other error type
      // means the response is not trustworthy.
      if (body.errors.every((e) => e.type === 'NOT_FOUND')) {
        if (body.data) return body.data;
        throw new GithubNotFoundError(message);
      }
      // A field the token may not read (a GitHub App without the org "Members"
      // permission cannot resolve a team requested as reviewer, for instance)
      // comes back as a FORBIDDEN error with a path, and GitHub nulls just that
      // field. The rest of the page is good: keep it, and remember what was
      // dropped so callers can surface it.
      if (
        body.data &&
        body.errors.every(
          (e) => e.type === 'FORBIDDEN' && Array.isArray(e.path) && e.path.length > 0,
        )
      ) {
        this.forbiddenFields = [
          ...new Set([
            ...this.forbiddenFields,
            ...body.errors.map((e) =>
              (e.path ?? []).filter((x) => typeof x === 'string').join('.'),
            ),
          ]),
        ];
        return body.data;
      }
      throw new GithubError(
        message,
        null,
        body.errors.every((e) => e.type === undefined || e.type === 'RATE_LIMITED'),
      );
    }
    if (!body.data) throw new GithubError('GitHub returned no data', null, true);
    return body.data;
  }

  /** Run a repo-scoped query, turning a null `repository` (or a bare NOT_FOUND) into `RepoNotFoundError`. */
  private async repoQuery<T extends { repository: unknown }>(
    repo: RepoRef,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T & { repository: NonNullable<T['repository']> }> {
    let data: T;
    try {
      data = await this.graphql<T>(query, { owner: repo.owner, name: repo.name, ...variables });
    } catch (error) {
      if (error instanceof GithubNotFoundError) throw new RepoNotFoundError(repo);
      throw error;
    }
    if (!data.repository) throw new RepoNotFoundError(repo);
    return data as T & { repository: NonNullable<T['repository']> };
  }

  async pullRequestsPage(
    repo: RepoRef,
    page: number,
    cursor: string | null,
    options: PullRequestsPageOptions = {},
  ): Promise<{
    page: NonNullable<PullRequestsPage['repository']>['pullRequests'];
    rateLimit: RateLimit;
  }> {
    const data = await this.repoQuery<PullRequestsPage>(repo, PULL_REQUESTS_QUERY, {
      page,
      cursor,
      states: options.states ?? null,
    });
    return { page: data.repository.pullRequests, rateLimit: data.rateLimit };
  }

  async repoMeta(
    repo: RepoRef,
  ): Promise<{ meta: NonNullable<RepoMetaResult['repository']>; rateLimit: RateLimit }> {
    const data = await this.repoQuery<RepoMetaResult>(repo, REPO_META_QUERY, {});
    return { meta: data.repository, rateLimit: data.rateLimit };
  }

  /** Who the token belongs to. Works with a token that has no scopes at all. */
  async viewer(): Promise<Viewer> {
    const data = await this.graphql<ViewerResult>(VIEWER_QUERY, {});
    const { databaseId, login, avatarUrl } = data.viewer;
    return { databaseId, login, avatarUrl: avatarUrl ?? null };
  }
}
