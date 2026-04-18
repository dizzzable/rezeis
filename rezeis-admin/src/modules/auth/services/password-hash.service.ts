import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const HASH_KEY_LENGTH: number = 64;
const SALT_LENGTH: number = 16;
const HASH_DELIMITER: string = '$';
const HASH_PREFIX: string = 'scrypt';

interface HashPasswordInput {
  readonly plainTextPassword: string;
}

interface VerifyPasswordInput {
  readonly plainTextPassword: string;
  readonly passwordHash: string;
}

/**
 * Hashes and verifies admin passwords with Node.js crypto primitives.
 */
@Injectable()
export class PasswordHashService {
  /**
   * Hashes a plain text password with scrypt.
   */
  public async hashPassword(input: HashPasswordInput): Promise<string> {
    const saltBuffer: Buffer = randomBytes(SALT_LENGTH);
    const passwordBuffer: Buffer = await this.deriveKey({
      plainTextPassword: input.plainTextPassword,
      saltBuffer,
    });
    return [HASH_PREFIX, saltBuffer.toString('hex'), passwordBuffer.toString('hex')].join(
      HASH_DELIMITER,
    );
  }

  /**
   * Verifies a plain text password against a stored scrypt hash.
   */
  public async verifyPassword(input: VerifyPasswordInput): Promise<boolean> {
    const parsedHash: ParsedPasswordHash | null = parsePasswordHash(input.passwordHash);
    if (!parsedHash) {
      return false;
    }
    const derivedHash: Buffer = await this.deriveKey({
      plainTextPassword: input.plainTextPassword,
      saltBuffer: parsedHash.saltBuffer,
    });
    if (derivedHash.length !== parsedHash.hashBuffer.length) {
      return false;
    }
    return timingSafeEqual(derivedHash, parsedHash.hashBuffer);
  }

  private async deriveKey(input: DeriveKeyInput): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject): void => {
      scrypt(input.plainTextPassword, input.saltBuffer, HASH_KEY_LENGTH, (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey as Buffer);
      });
    });
  }
}

interface DeriveKeyInput {
  readonly plainTextPassword: string;
  readonly saltBuffer: Buffer;
}

interface ParsedPasswordHash {
  readonly saltBuffer: Buffer;
  readonly hashBuffer: Buffer;
}

function parsePasswordHash(passwordHash: string): ParsedPasswordHash | null {
  const parts: string[] = passwordHash.split(HASH_DELIMITER);
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, saltHex, hashHex] = parts;
  if (prefix !== HASH_PREFIX) {
    return null;
  }
  if (!isHexValue(saltHex) || !isHexValue(hashHex)) {
    return null;
  }
  const saltBuffer: Buffer = Buffer.from(saltHex, 'hex');
  const hashBuffer: Buffer = Buffer.from(hashHex, 'hex');
  if (saltBuffer.length === 0 || hashBuffer.length !== HASH_KEY_LENGTH) {
    return null;
  }
  return {
    saltBuffer,
    hashBuffer,
  };
}

function isHexValue(value: string): boolean {
  if (value.length === 0 || value.length % 2 !== 0) {
    return false;
  }
  return /^[0-9a-f]+$/i.test(value);
}
