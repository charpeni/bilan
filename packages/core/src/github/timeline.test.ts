import { describe, expect, it } from 'vitest';

import { readyInfo } from '../derive/ready.ts';
import { timelineGithub } from '../testing/timeline.ts';
import { GithubRateLimitError } from './client.ts';
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
    await expect(page).rejects.toMatchObject({ resetAt: '2026-10-01T00:00:00Z' });
    expect(cursors).toEqual([null]);
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
