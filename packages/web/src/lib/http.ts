export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** The single 404 for repos, so an invisible private repo and an unknown one are byte-identical. */
export function unknownRepository(): Response {
  return json({ message: 'unknown repository' }, 404);
}

export function loginRequired(): Response {
  return json({ message: 'login required' }, 401);
}

/** GitHub could not answer while deciding what the viewer may see; nothing is exposed or hidden. */
export function githubUnavailable(): Response {
  return json({ message: 'GitHub is unavailable; try again in a minute' }, 503, {
    'retry-after': '60',
    'cache-control': 'no-store',
  });
}

/**
 * A failure nothing above accounts for. What went wrong goes to the Worker's
 * log and never to the client: its message can quote another Worker's reply,
 * a SQL error, or an internal id. The client gets `message`, written for it.
 */
export function serverError(message: string, cause: unknown): Response {
  console.error(message, cause);
  return json({ message }, 500, { 'cache-control': 'no-store' });
}
