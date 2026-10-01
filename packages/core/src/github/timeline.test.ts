import { describe, expect, it } from 'vitest';

import { readyInfo } from '../derive/ready.ts';
import { timelineGithub } from '../testing/timeline.ts';
import { GithubRateLimitError, RepoChangedError } from './client.ts';
import { compact } from './compact.ts';
import { PULL_REQUESTS_QUERY, PULL_REQUEST_TIMELINE_QUERY } from './query.ts';

const repo = { owner: 'acme', name: 'widgets' };

describe('pull request timelines', () => {
  it('requests names for every reviewer type supported by GitHub', () => {
    for (const query of [PULL_REQUESTS_QUERY, PULL_REQUEST_TIMELINE_QUERY]) {
      for (const actor of ['Bot', 'Mannequin', 'User']) {
        expect(query).toContain(`... on ${actor} { login }`);
      }
      for (const team of ['EnterpriseTeam', 'Team']) {
        expect(query).toContain(`... on ${team} { name }`);
      }
    }
  });

  it('keeps draft readiness independent of requests and follows every request page', async () => {
    const { client, cursors } = timelineGithub({ events: 125 });
    const result = await client.pullRequestsPage(repo, 25, null);
    const pr = compact(result.page.nodes[0]!);
    expect(pr.reviewRequests).toHaveLength(125);
    expect(pr.reviewRequests[0]?.to).toBeNull();
    expect(pr.reviewRequests.at(-1)?.to).toBe('reviewer124');
    expect(readyInfo(pr)).toEqual({
      openedAsDraft: true,
      readyAt: Date.parse('2026-01-02T10:00:00Z'),
    });
    expect(result.rateLimit).toMatchObject({ cost: 2, remaining: 4998 });
    expect(cursors).toHaveLength(2);
  });

  it('stops before a follow-up request once GitHub reports less than the reserve', async () => {
    const { client, cursors } = timelineGithub({ events: 205, remaining: (call) => 101 - call });
    const page = client.pullRequestsPage(repo, 25, null, { rateLimitReserve: 200 });
    await expect(page).rejects.toThrow(GithubRateLimitError);
    await expect(page).rejects.toMatchObject({ resetAt: '2026-10-01T00:00:00Z', pointsSpent: 1 });
    expect(cursors).toEqual([null]);
  });

  it('keeps the points of successful requests when a follow-up is rate limited', async () => {
    const { client, cursors } = timelineGithub({
      events: 305,
      fail: (call) =>
        call === 3
          ? new Response('{"message":"You have exceeded a secondary rate limit"}', {
              status: 403,
              headers: { 'retry-after': '600' },
            })
          : undefined,
    });
    const page = client.pullRequestsPage(repo, 25, null, { rateLimitReserve: 200 });
    await expect(page).rejects.toThrow(GithubRateLimitError);
    await expect(page).rejects.toMatchObject({ pointsSpent: 2 });
    expect(cursors).toEqual([null, '100', '200']);
  });

  it('follows requests while GitHub reports at least the reserve', async () => {
    const { client, cursors } = timelineGithub({
      events: 205,
      remaining: (call) => (call === 1 ? 300 : 150),
    });
    await expect(
      client.pullRequestsPage(repo, 25, null, { rateLimitReserve: 200 }),
    ).rejects.toThrow(/150 points, under the 200-point reserve/);
    expect(cursors).toEqual([null, '100']);

    // Without a reserve (the web workflow parks between pages instead), every page is followed.
    const unbounded = timelineGithub({ events: 205, remaining: () => 100 });
    const result = await unbounded.client.pullRequestsPage(repo, 25, null);
    expect(compact(result.page.nodes[0]!).reviewRequests).toHaveLength(205);
    expect(unbounded.cursors).toEqual([null, '100', '200']);
  });
});

describe('pull request pages for a pinned repository', () => {
  it('returns the repository the name resolved to', async () => {
    const { client } = timelineGithub({ events: 1 });
    const result = await client.pullRequestsPage(repo, 25, null, { repoId: 'R_repo' });
    expect(result.repoId).toBe('R_repo');
  });

  it('refuses a page once the name resolves to another repository', async () => {
    const { client, cursors } = timelineGithub({ events: 125, repoId: () => 'R_other' });
    const page = client.pullRequestsPage(repo, 25, null, { repoId: 'R_repo' });
    await expect(page).rejects.toThrow(RepoChangedError);
    await expect(page).rejects.toMatchObject({ retryable: false });
    // Not even its review-request follow-ups are fetched.
    expect(cursors).toEqual([null]);
  });

  it('refuses a follow-up that resolves to another repository than its page', async () => {
    const { client, cursors } = timelineGithub({
      events: 205,
      repoId: (call) => (call === 1 ? 'R_repo' : 'R_other'),
    });
    // Without a pinned ID too: the page's own repository is the reference.
    await expect(client.pullRequestsPage(repo, 25, null)).rejects.toThrow(RepoChangedError);
    expect(cursors).toEqual([null, '100']);
  });
});
