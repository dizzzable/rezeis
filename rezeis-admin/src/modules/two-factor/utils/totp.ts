/**
 * RFC 6238 TOTP — HOTP-with-time-window implementation in ~40 lines.
 *
 * The algorithm is small, well-defined, and broadly compatible with every
 * authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, …).
 * We default to SHA-1 / 30-second window / 6 digits — the parameters every
 * authenticator app supports out of the box.
 *
 * `verify()` accepts a small drift window (`±1` step) so users who type the
 * code right after a rollover still get in.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { base32Encode } from './base32';

const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_SEC = 30;
const DEFAULT_ALGORITHM: 'sha1' | 'sha256' | 'sha512' = 'sha1';
const DEFAULT_WINDOW = 1;

export interface TotpParameters {
  readonly digits: number;
  readonly period: number;
  readonly algorithm: 'sha1' | 'sha256' | 'sha512';
}

const DEFAULT_PARAMS: TotpParameters = {
  digits: DEFAULT_DIGITS,
  period: DEFAULT_PERIOD_SEC,
  algorithm: DEFAULT_ALGORITHM,
};

/**
 * Generates a fresh random 20-byte secret (160 bits), the size recommended
 * by RFC 4226 for HMAC-SHA1. Returns the secret as Base32 — the format
 * accepted by `otpauth://` URIs.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Computes the TOTP code for `secret` at `time` (seconds since epoch).
 */
export function computeTotpCode(
  secret: Buffer,
  time: number,
  params: TotpParameters = DEFAULT_PARAMS,
): string {
  const counter = Math.floor(time / params.period);
  const counterBuffer = Buffer.alloc(8);
  // 64-bit big-endian counter. Keeps things compatible with HOTP wire format.
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = createHmac(params.algorithm, secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    10 ** params.digits;
  return code.toString().padStart(params.digits, '0');
}

/**
 * Verifies `code` against `secret` allowing for a ±`window` step drift.
 * Uses constant-time comparison to avoid timing leaks.
 */
export function verifyTotpCode(
  secret: Buffer,
  code: string,
  options: { readonly window?: number; readonly time?: number; readonly params?: TotpParameters } = {},
): boolean {
  const window = options.window ?? DEFAULT_WINDOW;
  const time = options.time ?? Math.floor(Date.now() / 1000);
  const params = options.params ?? DEFAULT_PARAMS;
  const trimmed = code.replace(/\s+/g, '');
  if (trimmed.length !== params.digits) return false;
  const expectedBuffer = Buffer.alloc(params.digits);
  const candidateBuffer = Buffer.alloc(params.digits);
  for (let i = -window; i <= window; i++) {
    const candidate = computeTotpCode(secret, time + i * params.period, params);
    expectedBuffer.write(candidate);
    candidateBuffer.write(trimmed);
    try {
      if (timingSafeEqual(expectedBuffer, candidateBuffer)) {
        return true;
      }
    } catch {
      // length mismatch already rejected above
    }
  }
  return false;
}

/**
 * Builds the `otpauth://` URI consumed by authenticator apps when the
 * operator scans a QR code.
 */
export function buildOtpAuthUri(input: {
  readonly secret: string;
  readonly accountName: string;
  readonly issuer: string;
  readonly params?: TotpParameters;
}): string {
  const params = input.params ?? DEFAULT_PARAMS;
  const issuer = encodeURIComponent(input.issuer);
  const account = encodeURIComponent(input.accountName);
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: params.algorithm.toUpperCase(),
    digits: params.digits.toString(),
    period: params.period.toString(),
  });
  return `otpauth://totp/${issuer}:${account}?${query.toString()}`;
}
