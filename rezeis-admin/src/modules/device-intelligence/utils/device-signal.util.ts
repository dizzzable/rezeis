import { DeviceSignalKind } from '@prisma/client';

/**
 * Normalisation and sanity-checking for device signals.
 *
 * ── These values arrive from the client and are fully attacker-controlled ──
 *
 * The cabinet computes them, but nothing stops somebody posting whatever they
 * like to the endpoint that receives them. That makes two things load-bearing:
 *
 * A SHAPE THE STORE CAN HOLD. Without a length cap and a charset, this endpoint
 * is a free write-anything-you-want column — a megabyte per request, one row
 * per request, indexed. The cap is what stops the table being used as storage.
 *
 * ONE SPELLING PER SIGNAL. The unique index decides what "the same device"
 * means, exactly as it does on the identity blocklist. A writer that stores
 * `AB12` and a reader that looks up `ab12` produce a system that records
 * everything and matches nothing.
 *
 * ── What normalisation deliberately does NOT do ───────────────────────────
 *
 * It does not try to detect a spoofed value. A determined evader can send a
 * fresh random hash on every visit and will never match anything, and no amount
 * of validation here changes that — the signal catches people who did not think
 * to, which is most of them. Pretending otherwise in this file would be the
 * kind of check that reads as protection and provides none.
 */

/**
 * Long enough for a uuid or a 64-character digest with room to spare, short
 * enough that the column cannot be used as a data store.
 */
const MAX_LENGTH = 128;
const MIN_LENGTH = 8;

/**
 * Hex, base36, dashes and underscores. Covers every shape the cabinet produces
 * (uuid v4, SHA-256 hex, base36 digest) and refuses free text, so a value that
 * reaches the table is one that could plausibly be an identifier.
 */
const SAFE_VALUE = /^[a-z0-9_-]+$/;

export type NormalisedSignal =
  | { readonly ok: true; readonly kind: DeviceSignalKind; readonly value: string }
  | { readonly ok: false; readonly reason: 'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'BAD_CHARSET' };

export function normaliseDeviceSignal(
  kind: DeviceSignalKind,
  raw: string | null | undefined,
): NormalisedSignal {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed.length === 0) return { ok: false, reason: 'EMPTY' };
  // A very short value would collide across unrelated people and turn one flag
  // into a flag on everybody.
  if (trimmed.length < MIN_LENGTH) return { ok: false, reason: 'TOO_SHORT' };
  if (trimmed.length > MAX_LENGTH) return { ok: false, reason: 'TOO_LONG' };
  if (!SAFE_VALUE.test(trimmed)) return { ok: false, reason: 'BAD_CHARSET' };
  return { ok: true, kind, value: trimmed };
}

/**
 * The dedup key for a review flag.
 *
 * Keyed on the SIGNAL rather than on the account it matched, because the same
 * device can match several blocked accounts and an operator wants one entry to
 * judge, not one per prior ban. Every session load reports the same device, so
 * without this the queue would grow by a row per page view and stop being read.
 */
export function deviceFlagFingerprint(kind: DeviceSignalKind, value: string): string {
  return `${kind}:${value}`;
}
