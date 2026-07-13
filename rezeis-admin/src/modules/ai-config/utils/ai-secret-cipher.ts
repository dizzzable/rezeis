/**
 * AES-256-GCM cipher for the AI-support provider API key at rest.
 *
 * Mirrors the TOTP/OAuth secret pattern: the master key comes from
 * `REZEIS_CRYPT_KEY`, passed through SHA-256 (with an `ai-config` domain
 * separator) to derive a 32-byte AES key. Storage format is
 * `<iv-hex>:<ciphertext-hex>:<auth-tag-hex>`. The raw key is never persisted
 * in plaintext and never leaves the server except to the trusted BFF via the
 * InternalAdminAuthGuard-protected endpoint.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;

function deriveKey(cryptKey: string): Buffer {
  return createHash('sha256').update(`rezeis-admin:ai-config:${cryptKey}`).digest();
}

/** True when `value` looks like our `iv:ct:tag` hex payload (vs legacy plaintext). */
export function isEncryptedApiKey(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return parts.every((p) => /^[0-9a-f]+$/i.test(p) && p.length > 0);
}

export function encryptApiKey(plaintext: string, cryptKey: string): string {
  const key = deriveKey(cryptKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptApiKey(payload: string, cryptKey: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted AI API key');
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const ct = Buffer.from(ctHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed encrypted AI API key');
  }
  const key = deriveKey(cryptKey);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}
