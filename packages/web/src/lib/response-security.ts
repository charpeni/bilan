/**
 * Headers shared by dynamic pages and APIs, including redirects and denials.
 * Set on the route's own response, not a copy: a copy keeps only the status
 * and headers, so the pre-gzipped payloads would lose `encodeBody: 'manual'`
 * and Workers would gzip them a second time.
 */
export function secureResponse(response: Response, url: URL, signedIn: boolean): Response {
  const { headers } = response;
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  // These restrictions do not interfere with the existing inline theme script.
  headers.set(
    'content-security-policy',
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  if (url.protocol === 'https:') headers.set('strict-transport-security', 'max-age=31536000');
  if (signedIn || url.pathname.startsWith('/auth/')) headers.set('cache-control', 'no-store');
  return response;
}
