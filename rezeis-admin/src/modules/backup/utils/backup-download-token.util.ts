import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed token for the unauthenticated backup-download endpoint.
 *
 * The reiwa bot fetches a backup file from rezeis to upload it to Telegram,
 * but the bot does not hold an admin API token. Instead rezeis hands it a
 * signed, expiring URL token that the download endpoint validates inline —
 * no JWT, no shared mutable secret beyond the server crypt key.
 *
 * Token format (base64url): `${recordId}.${expMs}.${hmac}` where
 * `hmac = HMAC_SHA256(derivedKey, "${recordId}.${expMs}")`.
 *
 * Single use is enforced by the CONTROLLER, not here: replay protection needs
 * shared state (Redis) and this module has to stay a pure function so it can be
 * reasoned about — and tested — without one. See
 * `InternalBackupDownloadController`.
 */

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Domain-separated HMAC key, matching every other cipher in this tree
 * (`ai-secret-cipher.ts`, `payment-gateway-secret-cipher.ts`,
 * `secret-cipher.ts`, `backup-provenance.util.ts`): the master key is never
 * used raw, so a signature produced for one purpose can never be replayed
 * against another that happens to sign a colliding string.
 *
 * Changing this invalidates tokens already minted — which costs nothing real.
 * A token lives 10 minutes and is minted, handed to reiwa and redeemed within
 * seconds; the only tokens a deploy can strand are ones whose relay was
 * already interrupted by the same restart, and `backup.deliver-telegram`
 * retries with a freshly-minted token (`attempts: 3`). Nothing outside this
 * process ever computes the signature — rezeis signs, reiwa only carries the
 * string — so there is no second implementation to keep in step.
 */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(`rezeis-admin:backup-download:${secret}`).digest();
}

function hmacOf(secret: string, payload: string): string {
  return base64url(createHmac('sha256', deriveKey(secret)).update(payload).digest());
}

/**
 * Stable, non-reversible id for a token, safe to use as a Redis key.
 *
 * The raw token is a bearer credential; putting it in a cache key would leave
 * it in `MONITOR` output, in slow-log entries and in any keyspace dump.
 */
export function backupDownloadTokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
