import { json } from '../../lib/http.ts';

import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ locals }) => {
  if (!locals.user)
    return json({ message: 'login required' }, 401, { 'cache-control': 'no-store' });
  return json({ user: locals.user }, 200, { 'cache-control': 'no-store' });
};
