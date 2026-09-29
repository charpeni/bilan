import type { APIRoute } from 'astro';

/** The repo list moved to `/repositories`; old links keep working. */
export const GET: APIRoute = ({ url }) =>
  new Response(null, {
    status: 301,
    headers: { location: `/repositories${url.search}` },
  });
