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
