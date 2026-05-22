import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { authConfig } from '../../../common/config/auth.config';

/**
 * AES-256-GCM encryption/decryption for OAuth client secrets.
 * Uses the same REZEIS_CRYPT_KEY as TOTP secrets.
 *
 * Format: `iv:ciphertext:tag` (all hex-encoded).
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  public constructor(
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
  ) {
    // Derive a 32-byte key from the crypt key
    const rawKey = this.authConfiguration.cryptKey;
    // Use first 32 bytes of hex-encoded key, or pad with zeros
    const keyHex = rawKey.padEnd(64, '0').slice(0, 64);
    this.key = Buffer.from(keyHex, 'hex');
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

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }
}
