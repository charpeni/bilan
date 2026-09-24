import { expect, it } from 'vitest';

import { gunzip, gzip } from './gzip.ts';

it('round-trips text through gzip', async () => {
  const text = JSON.stringify({ prs: Array.from({ length: 200 }, (_, i) => ({ n: i })) });
  const bytes = await gzip(text);
  expect(bytes[0]).toBe(0x1f);
  expect(bytes[1]).toBe(0x8b);
  expect(bytes.byteLength).toBeLessThan(text.length);
  expect(await gunzip(bytes)).toBe(text);
});
