import { createHash } from 'node:crypto';

import { registerAs } from '@nestjs/config';

/**
 * How strictly the internal API enforces reiwa's request signature.
 *
 * `log` is the default on purpose: reiwa has been signing all along and this
 * service never verified, so nobody knows yet whether every caller in a given
 * deployment (api, bot, worker) actually carries the secret. `log` verifies and
 * reports without rejecting, which turns that unknown into log lines; `require`
 * is flipped on once those lines are clean.
 */
export type InternalSignatureMode = 'off' | 'log' | 'require';

interface AuthConfiguration {
  readonly jwtSecret: string;
  readonly jwtExpiresIn: string;
  readonly cryptKey: string;
  /** Shared with reiwa; empty means signature checking cannot run at all. */
  readonly internalSharedSecret: string;
  readonly internalSignatureMode: InternalSignatureMode;
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
      internalSharedSecret: (process.env.REZEIS_INTERNAL_SHARED_SECRET ?? '').trim(),
      internalSignatureMode: parseSignatureMode(process.env.REZEIS_INTERNAL_SIGNATURE_MODE),
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

function parseSignatureMode(raw: string | undefined): InternalSignatureMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'off' || value === 'require') {
    return value;
  }
  return 'log';
}
