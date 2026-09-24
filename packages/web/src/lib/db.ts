import { createDb } from '@bilan/store-d1';

import type { Db } from '@bilan/store-d1';

export type { Db };

export function getDb(env: Pick<Env, 'DB'>): Db {
  return createDb(env.DB);
}
