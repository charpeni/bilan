import { base64ToBytes, bytesToBase64, randomBytes } from './encoding.ts';

const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Import the base64 `TOKEN_ENCRYPTION_KEY` (32 raw bytes, e.g. from
 * `openssl rand -base64 32`) as an AES-256-GCM key.
 */
export async function importTokenKey(base64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(base64.trim());
  } catch {
    throw new Error('TOKEN_ENCRYPTION_KEY is not valid base64');
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${raw.byteLength}`,
    );
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM with a fresh random IV per call; stored as `base64(iv).base64(ciphertext)`. */
export async function encryptToken(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(key: CryptoKey, stored: string): Promise<string> {
  const [ivText, ciphertextText, ...rest] = stored.split('.');
  if (!ivText || !ciphertextText || rest.length > 0) {
    throw new Error('stored token is not in iv.ciphertext form');
  }
  const iv = base64ToBytes(ivText);
  const ciphertext = base64ToBytes(ciphertextText);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}
