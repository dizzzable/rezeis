import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { authConfig } from '../../../common/config/auth.config';

/**
 * AES-256-GCM encryption/decryption for OAuth client secrets.
 * Uses the same REZEIS_CRYPT_KEY as TOTP secrets.
 *
 * Format: `iv:ciphertext:tag` (all hex-encoded).
 *
 * Key derivation
 *   The 32-byte AES key is derived by hashing the operator secret with a
 *   domain separator (`createHash('sha256')`), exactly like the TOTP and
 *   AI-secret ciphers. The previous implementation instead ran
 *   `Buffer.from(rawKey.padEnd(64,'0').slice(0,64), 'hex')`, which
 *   silently produced an empty/garbage buffer for any realistic non-hex
 *   secret (the documented requirement is only "≥32 chars", not hex) —
 *   `createCipheriv` then threw `Invalid key length` on the first OAuth
 *   secret save / provider login. `legacyHexKey` is kept ONLY for
 *   decryption so any value that was encrypted while a hex crypt key was
 *   configured can still be read (and re-encrypted with the new scheme on
 *   the next save).
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly legacyHexKey: Buffer | null;

  public constructor(
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
  ) {
    const rawKey = this.authConfiguration.cryptKey;
    // Domain-separated SHA-256 → always a valid 32-byte AES-256 key,
    // regardless of the secret's character set or length.
    this.key = createHash('sha256').update(`rezeis-admin:oauth:${rawKey}`).digest();
    // Back-compat: reproduce the old hex derivation so previously-stored
    // ciphertext (if the crypt key happened to be valid hex) stays
    // decryptable. Null when the key can't form a full 32-byte hex buffer.
    const legacyHex = rawKey.padEnd(64, '0').slice(0, 64);
    const legacyBuf = Buffer.from(legacyHex, 'hex');
    this.legacyHexKey = legacyBuf.length === 32 ? legacyBuf : null;
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * Returns format: `iv:ciphertext:tag` (hex-encoded).
   */
  public encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
  }

  /**
   * Decrypts an AES-256-GCM encrypted string.
   * Expects format: `iv:ciphertext:tag` (hex-encoded).
   */
  public decrypt(encryptedValue: string): string {
    const parts = encryptedValue.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format');
    }
    const [ivHex, ciphertextHex, tagHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    try {
      return this.decryptWith(this.key, iv, ciphertext, tag);
    } catch (error: unknown) {
      // Fall back to the legacy hex-derived key for values encrypted before
      // the SHA-256 derivation (only possible when the crypt key was valid
      // hex). Re-throw the original error if there's no legacy key to try.
      if (this.legacyHexKey !== null) {
        return this.decryptWith(this.legacyHexKey, iv, ciphertext, tag);
      }
      throw error;
    }
  }

  private decryptWith(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
