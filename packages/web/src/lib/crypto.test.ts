import { describe, expect, it } from 'vitest';

import { decryptToken, encryptToken, importTokenKey } from './crypto.ts';
import { bytesToBase64, randomBytes } from './encoding.ts';

const keyText = bytesToBase64(randomBytes(32));

describe('importTokenKey', () => {
  it('accepts a 32-byte base64 key, with surrounding whitespace', async () => {
    await expect(importTokenKey(`  ${keyText}\n`)).resolves.toBeDefined();
  });

  it('rejects keys of the wrong length or that are not base64', async () => {
    await expect(importTokenKey(bytesToBase64(randomBytes(16)))).rejects.toThrow(/32 bytes/);
    await expect(importTokenKey('not*base64!')).rejects.toThrow(/base64/);
  });
});

describe('encryptToken / decryptToken', () => {
  it('round-trips and never reuses an IV', async () => {
    const key = await importTokenKey(keyText);
    const a = await encryptToken(key, 'gho_secret');
    const b = await encryptToken(key, 'gho_secret');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(a.split('.')[0]).toHaveLength(16); // 12 bytes of IV
    expect(await decryptToken(key, a)).toBe('gho_secret');
    expect(await decryptToken(key, b)).toBe('gho_secret');
  });

  it('fails under a different key or a tampered payload', async () => {
    const key = await importTokenKey(keyText);
    const other = await importTokenKey(bytesToBase64(randomBytes(32)));
    const stored = await encryptToken(key, 'gho_secret');
    await expect(decryptToken(other, stored)).rejects.toThrow();
    const [iv, ct] = stored.split('.') as [string, string];
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(decryptToken(key, `${iv}.${flipped}`)).rejects.toThrow();
    await expect(decryptToken(key, 'garbage')).rejects.toThrow(/iv\.ciphertext/);
  });
});
