import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(cryptKey: string): Buffer {
  return createHash('sha256').update(`rezeis-admin:olcrtc:${cryptKey}`).digest();
}

export function encryptOlcrtcSecret(plaintext: string, cryptKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(cryptKey), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptOlcrtcSecret(payload: string, cryptKey: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted OLCRTC secret');
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const ct = Buffer.from(ctHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed encrypted OLCRTC secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(cryptKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
