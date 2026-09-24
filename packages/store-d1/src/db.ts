import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>;

/** A drizzle handle over a D1 binding, with the bilan schema attached for relational queries. */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
