import { describe, expect, it } from 'vitest';

import { GithubClient, GithubError, RepoNotFoundError } from './client.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GithubClient', () => {
  it('aborts stalled requests and bounds every retry', async () => {
    let calls = 0;
    const client = new GithubClient({
      token: 'test',
      timeoutMs: 10,
      retries: 1,
      sleep: async () => {},
      fetch: async (_url, init) => {
        calls++;
        const signal = init?.signal;
        if (!signal) throw new Error('Missing request deadline');
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    });
    await expect(client.graphql('query {}', {})).rejects.toThrow(/TimeoutError/);
    expect(calls).toBe(2);
  });

  it('sends the token and returns data', async () => {
    let seen: RequestInit | undefined;
    const client = new GithubClient({
      token: 'abc',
      fetch: async (_url, init) => {
        seen = init;
        return json({ data: { ok: true } });
      },
    });
    await expect(client.graphql('query {}', {})).resolves.toEqual({ ok: true });
    const headers = (seen as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer abc');
  });

  it('retries 5xx with backoff and then succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = new GithubClient({
      token: 't',
      fetch: async () => (++calls < 3 ? json({}, 502) : json({ data: { n: calls } })),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await expect(client.graphql('q', {})).resolves.toEqual({ n: 3 });
    expect(waits).toEqual([2000, 4000]);
  });

  it('does not retry 4xx', async () => {
    let calls = 0;
    const client = new GithubClient({
      token: 't',
      fetch: async () => {
        calls++;
        return json({ message: 'Bad credentials' }, 401);
      },
      sleep: async () => {},
    });
    await expect(client.graphql('q', {})).rejects.toThrow('GitHub responded 401: Bad credentials');
    expect(calls).toBe(1);
  });

  it('maps a null repository to RepoNotFoundError', async () => {
    const client = new GithubClient({
      token: 't',
      fetch: async () =>
        json({ data: { repository: null, rateLimit: { cost: 1, remaining: 10, resetAt: '' } } }),
    });
    await expect(client.repoMeta({ owner: 'a', name: 'b' })).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
  });

  describe('NOT_FOUND normalisation', () => {
    const rateLimit = { cost: 1, remaining: 10, resetAt: '' };
    /** What GitHub really sends for a missing or invisible repo. */
    const notFoundBody = () =>
      json({
        data: { repository: null, rateLimit },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['repository'],
            locations: [{ line: 2, column: 3 }],
            message: "Could not resolve to a Repository with the name 'a/b'.",
          },
        ],
      });

    it('maps a null repository with NOT_FOUND errors to RepoNotFoundError', async () => {
      let calls = 0;
      const client = new GithubClient({
        token: 't',
        fetch: async () => {
          calls++;
          return notFoundBody();
        },
        sleep: async () => {},
      });
      await expect(client.repoMeta({ owner: 'a', name: 'b' })).rejects.toBeInstanceOf(
        RepoNotFoundError,
      );
      await expect(client.pullRequestsPage({ owner: 'a', name: 'b' }, 25, null)).rejects.toThrow(
        'Repository a/b not found or not accessible',
      );
      expect(calls).toBe(2);
    });

    it('returns the data when every error is NOT_FOUND', async () => {
      const client = new GithubClient({ token: 't', fetch: async () => notFoundBody() });
      await expect(client.graphql('q', {})).resolves.toEqual({ repository: null, rateLimit });
    });

    it('maps NOT_FOUND without any data to RepoNotFoundError in the repo-level methods', async () => {
      const client = new GithubClient({
        token: 't',
        fetch: async () => json({ data: null, errors: [{ type: 'NOT_FOUND', message: 'nope' }] }),
        sleep: async () => {},
      });
      await expect(client.repoMeta({ owner: 'a', name: 'b' })).rejects.toBeInstanceOf(
        RepoNotFoundError,
      );
      await expect(
        client.pullRequestsPage({ owner: 'a', name: 'b' }, 25, null),
      ).rejects.toBeInstanceOf(RepoNotFoundError);
    });

    it('still throws GithubError, without retrying, when other error types are mixed in', async () => {
      let calls = 0;
      const client = new GithubClient({
        token: 't',
        fetch: async () => {
          calls++;
          return json({
            data: { repository: null, rateLimit },
            errors: [
              { type: 'NOT_FOUND', message: 'nope' },
              { type: 'FORBIDDEN', message: 'Resource not accessible' },
            ],
          });
        },
        sleep: async () => {},
      });
      const failure = client.repoMeta({ owner: 'a', name: 'b' });
      await expect(failure).rejects.toBeInstanceOf(GithubError);
      await expect(failure).rejects.not.toBeInstanceOf(RepoNotFoundError);
      await expect(failure).rejects.toThrow('nope; Resource not accessible');
      expect(calls).toBe(1);
    });

    it('keeps retrying untyped GraphQL errors', async () => {
      let calls = 0;
      const waits: number[] = [];
      const client = new GithubClient({
        token: 't',
        fetch: async () =>
          ++calls < 2
            ? json({ data: null, errors: [{ message: 'Something went wrong' }] })
            : json({ data: { repository: { id: 'R_1' }, rateLimit } }),
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      await expect(client.repoMeta({ owner: 'a', name: 'b' })).resolves.toMatchObject({
        meta: { id: 'R_1' },
      });
      expect(waits).toEqual([2000]);
    });
  });

  it('does not retry NOT_FOUND GraphQL errors', async () => {
    let calls = 0;
    const client = new GithubClient({
      token: 't',
      fetch: async () => {
        calls++;
        return json({ data: null, errors: [{ type: 'NOT_FOUND', message: 'nope' }] });
      },
      sleep: async () => {},
    });
    await expect(client.graphql('q', {})).rejects.toBeInstanceOf(GithubError);
    expect(calls).toBe(1);
  });

  describe('transport failures', () => {
    it('wraps a rejected fetch in a retryable GithubError naming the cause', async () => {
      let calls = 0;
      const waits: number[] = [];
      const client = new GithubClient({
        token: 't',
        retries: 2,
        fetch: async () => {
          calls++;
          throw new TypeError('fetch failed');
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      const failure = client.graphql('q', {});
      await expect(failure).rejects.toBeInstanceOf(GithubError);
      await expect(failure).rejects.toMatchObject({
        name: 'GithubError',
        status: null,
        retryable: true,
        message: 'GitHub request failed: TypeError: fetch failed',
        cause: expect.any(TypeError),
      });
      expect(calls).toBe(3);
      expect(waits).toEqual([2000, 4000]);
    });

    it('includes the system error code when the cause carries one', async () => {
      const client = new GithubClient({
        token: 't',
        retries: 0,
        fetch: async () => {
          throw Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' });
        },
      });
      await expect(client.graphql('q', {})).rejects.toThrow(
        'GitHub request failed: TypeError: fetch failed (ENOTFOUND)',
      );
    });

    it('wraps a non-Error rejection too', async () => {
      const client = new GithubClient({
        token: 't',
        retries: 0,
        fetch: async () => Promise.reject('socket hang up'),
      });
      const failure = client.graphql('q', {});
      await expect(failure).rejects.toBeInstanceOf(GithubError);
      await expect(failure).rejects.toThrow('GitHub request failed: socket hang up');
    });

    it('wraps an unparseable 200 body in a retryable GithubError', async () => {
      let calls = 0;
      const client = new GithubClient({
        token: 't',
        retries: 1,
        fetch: async () => {
          calls++;
          return calls === 1
            ? new Response('<html>502 from a proxy</html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
              })
            : json({ data: { ok: true } });
        },
        sleep: async () => {},
      });
      await expect(client.graphql('q', {})).resolves.toEqual({ ok: true });
      expect(calls).toBe(2);

      const stuck = new GithubClient({
        token: 't',
        retries: 0,
        fetch: async () => new Response('not json', { status: 200 }),
      });
      const failure = stuck.graphql('q', {});
      await expect(failure).rejects.toBeInstanceOf(GithubError);
      await expect(failure).rejects.toMatchObject({ status: null, retryable: true });
      await expect(failure).rejects.toThrow(
        /^GitHub returned an unreadable response: SyntaxError: /,
      );
    });
  });

  it('returns the viewer behind the token', async () => {
    const client = new GithubClient({
      token: 't',
      fetch: async () =>
        json({ data: { viewer: { databaseId: 42, login: 'alice', avatarUrl: null } } }),
    });
    await expect(client.viewer()).resolves.toEqual({
      databaseId: 42,
      login: 'alice',
      avatarUrl: null,
    });
  });
});

describe('field-level FORBIDDEN', () => {
  it('keeps the page when only some fields were refused, and records them', async () => {
    const client = new GithubClient({
      token: 't',
      fetch: async () =>
        json({
          data: {
            repository: {
              pullRequests: {
                nodes: [{ number: 1, timelineItems: { nodes: [{ requestedReviewer: null }] } }],
              },
            },
          },
          errors: [
            {
              type: 'FORBIDDEN',
              message: 'Resource not accessible by integration',
              path: [
                'repository',
                'pullRequests',
                'nodes',
                0,
                'timelineItems',
                'nodes',
                0,
                'requestedReviewer',
              ],
            },
          ],
        }),
      sleep: async () => {},
    });
    const data = await client.graphql<{ repository: { pullRequests: { nodes: unknown[] } } }>(
      'q',
      {},
    );
    expect(data.repository.pullRequests.nodes).toHaveLength(1);
    expect(client.forbiddenFields).toEqual([
      'repository.pullRequests.nodes.timelineItems.nodes.requestedReviewer',
    ]);
  });

  it('still fails when a FORBIDDEN error has no path (the whole query was refused)', async () => {
    const client = new GithubClient({
      token: 't',
      fetch: async () => json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] }),
      sleep: async () => {},
    });
    await expect(client.graphql('q', {})).rejects.toBeInstanceOf(GithubError);
  });
});
