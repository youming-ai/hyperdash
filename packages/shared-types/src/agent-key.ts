/**
 * Agent private-key encryption.
 *
 * AES-256-GCM via WebCrypto so the identical module runs on Cloudflare Workers
 * (where `node:crypto` is unavailable) and in the Bun copier process. A single
 * implementation matters here: the BE writes these blobs and the executor reads
 * them, and two independent cipher implementations would eventually disagree.
 *
 * Layout: `base64(iv[12] || tag[16] || ciphertext)`. WebCrypto appends the auth
 * tag to the ciphertext, so it is split out to keep that stable, unambiguous
 * order — a tampered blob then fails decryption instead of yielding garbage.
 *
 * @module
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Copy into a fresh ArrayBuffer-backed view; WebCrypto rejects SharedArrayBuffer-backed input. */
function bufferView(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view);
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`agent encryption key must be ${KEY_LENGTH} bytes (got ${key.length})`);
  }
  // `.buffer` is copied because a Uint8Array view may be a slice of a larger one.
  return crypto.subtle.importKey('raw', key.slice().buffer, ALGORITHM, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Encrypt a private key for storage. Returns base64(iv || tag || ciphertext). */
export async function encryptAgentKey(privateKey: string, key: Uint8Array): Promise<string> {
  const cryptoKey = await importKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(privateKey);

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGORITHM, iv }, cryptoKey, plaintext),
  );

  const tag = sealed.subarray(sealed.length - TAG_LENGTH);
  const ciphertext = sealed.subarray(0, sealed.length - TAG_LENGTH);

  const out = new Uint8Array(IV_LENGTH + TAG_LENGTH + ciphertext.length);
  out.set(iv, 0);
  out.set(tag, IV_LENGTH);
  out.set(ciphertext, IV_LENGTH + TAG_LENGTH);
  return toBase64(out);
}

/** Decrypt a stored private key. Throws when the blob is malformed or tampered. */
export async function decryptAgentKey(encrypted: string, key: Uint8Array): Promise<string> {
  const data = fromBase64(encrypted);
  if (data.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('agent key blob is too short to be valid');
  }

  const iv = bufferView(data.subarray(0, IV_LENGTH));
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  // WebCrypto expects the tag appended to the ciphertext.
  const sealed = new Uint8Array(ciphertext.length + TAG_LENGTH);
  sealed.set(ciphertext, 0);
  sealed.set(tag, ciphertext.length);

  const cryptoKey = await importKey(key);
  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, cryptoKey, sealed);
  return new TextDecoder().decode(plaintext);
}

/** Parse a 64-character hex key (32 bytes) from configuration. */
export function parseEncryptionKey(hex: string | undefined): Uint8Array {
  if (!hex || hex.length !== KEY_LENGTH * 2) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  const bytes = new Uint8Array(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Generate a fresh 32-byte key, hex encoded — for provisioning new deployments. */
export function generateEncryptionKeyHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
