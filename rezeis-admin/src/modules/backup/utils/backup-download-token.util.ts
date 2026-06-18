import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed token for the unauthenticated backup-download endpoint.
 *
 * The reiwa bot fetches a backup file from rezeis to upload it to Telegram,
 * but the bot does not hold an admin API token. Instead rezeis hands it a
 * signed, expiring URL token that the download endpoint validates inline —
 * no JWT, no shared mutable secret beyond the server crypt key.
 *
 * Token format (base64url): `${recordId}.${expMs}.${hmac}` where
 * `hmac = HMAC_SHA256(secret, "${recordId}.${expMs}")`.
 */

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function hmacOf(secret: string, payload: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export function signBackupDownloadToken(
  recordId: string,
  secret: string,
  ttlMs = 10 * 60_000,
): string {
  const exp = Date.now() + ttlMs;
  const payload = `${recordId}.${exp}`;
  return base64url(`${payload}.${hmacOf(secret, payload)}`);
}

/**
 * Returns the `recordId` when the token is valid and unexpired, otherwise
 * `null`. Comparison is constant-time to avoid signature oracle leaks.
 */
export function verifyBackupDownloadToken(token: string, secret: string): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const lastDot = decoded.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const payload = decoded.slice(0, lastDot);
  const sig = decoded.slice(lastDot + 1);
  const dotIndex = payload.indexOf('.');
  if (dotIndex <= 0) return null;
  const recordId = payload.slice(0, dotIndex);
  const expRaw = payload.slice(dotIndex + 1);
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;

  const expected = hmacOf(secret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return recordId.length > 0 ? recordId : null;
}
