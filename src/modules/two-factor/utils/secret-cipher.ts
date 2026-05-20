/**
 * AES-256-GCM cipher used to encrypt TOTP secrets at rest.
 *
 * Key derivation
 *   The master key comes from `REZEIS_CRYPT_KEY` (already used to derive
 *   the JWT secret). We pass it through SHA-256 to obtain a 32-byte key
 *   suitable for AES-256. This keeps operator surface to a single secret.
 *
 * Storage format
 *   `<iv-hex>:<ciphertext-hex>:<auth-tag-hex>` — single string column,
 *   trivial to inspect and rotate.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;

function deriveKey(cryptKey: string): Buffer {
  return createHash('sha256').update(`rezeis-admin:totp:${cryptKey}`).digest();
}

export function encryptTotpSecret(plaintext: string, cryptKey: string): string {
  const key = deriveKey(cryptKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptTotpSecret(payload: string, cryptKey: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted TOTP secret');
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const ct = Buffer.from(ctHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed encrypted TOTP secret');
  }
  const key = deriveKey(cryptKey);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}
