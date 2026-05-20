import { createHash } from 'node:crypto';

import { registerAs } from '@nestjs/config';

interface AuthConfiguration {
  readonly jwtSecret: string;
  readonly jwtExpiresIn: string;
  readonly cryptKey: string;
}

/**
 * Provides typed authentication configuration values.
 *
 * JWT secret is derived from REZEIS_CRYPT_KEY via SHA-256 so operators only
 * need to manage one master secret. API tokens (for reiwa, bots, etc.) are
 * managed through the admin panel UI — no static env key needed.
 */
export const authConfig = registerAs(
  'auth',
  (): AuthConfiguration => {
    const cryptKey = process.env.REZEIS_CRYPT_KEY ?? '';
    const jwtSecret = deriveJwtSecret(cryptKey);

    return {
      jwtSecret,
      jwtExpiresIn: '24h',
      cryptKey,
    };
  },
);

/**
 * Derives a stable JWT signing secret from the master crypt key.
 * Uses SHA-256 with a domain separator so the raw crypt key is never
 * used directly as a signing secret.
 */
function deriveJwtSecret(cryptKey: string): string {
  return createHash('sha256')
    .update(`rezeis-admin:jwt:${cryptKey}`)
    .digest('hex');
}
