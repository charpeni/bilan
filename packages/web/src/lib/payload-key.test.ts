import { expect, it } from 'vitest';

import { payloadKey } from './payload-key.ts';

it('nests by repo id then sync time', () => {
  expect(payloadKey('R_kgDOabc', '2026-05-01T00:00:00.000Z')).toBe(
    'payload/R_kgDOabc/2026-05-01T00:00:00.000Z.json.gz',
  );
});
