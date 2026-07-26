import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verification side of the internal reiwa → rezeis HMAC.
 *
 * reiwa has been signing every internal call for a long time and this service
 * never checked the signature, so the documented "second factor" on the internal
 * API did not exist: a leaked API token was enough on its own to write clicks
 * with an arbitrary user id, bind any account to any placement or accept
 * counter-terms on a partner's behalf.
 *
 * Canonical message — must stay byte-identical to `reiwa/src/lib/internal-hmac.ts`:
 *
 *   message   = METHOD "\n" PATH "\n" TIMESTAMP "\n" sha256hex(body)
 *   signature = hex( HMAC-SHA256(secret, message) )
 *
 *   x-request-timestamp : milliseconds since epoch
 *   x-request-signature : the hex signature above
 *
 * `TIMESTAMP` is milliseconds, `PATH` is the request target INCLUDING the query
 * string (reiwa signs the path it passed to its transport, and most internal GETs
 * carry the identity there), and `body` is the raw bytes as they arrived — re-serialising the parsed body would change key
 * order or spacing and break the digest. A known-answer test pins the format on
 * both sides; changing one without the other is what would silently disable this.
 *
 * NOT the Stripe-style `t=…,v1=…` scheme used for operator-facing outbound
 * webhooks (`webhook-signature.util.ts`): that channel talks to third parties and
 * keeps its own format.
 */
export const INTERNAL_TIMESTAMP_HEADER = 'x-request-timestamp';
export const INTERNAL_SIGNATURE_HEADER = 'x-request-signature';

/** A signed timestamp must be within ±5 minutes, bounding replay. */
export const INTERNAL_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export type InternalSignatureFailure =
  | 'missing_headers'
  | 'malformed_timestamp'
  | 'stale'
  | 'malformed_signature'
  | 'mismatch';

export interface InternalSignatureResult {
  readonly valid: boolean;
  readonly reason?: InternalSignatureFailure;
}

/** Computes the expected signature for a canonical internal request. */
export function buildInternalSignature(input: {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: string;
}): string {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  const message = [input.method.toUpperCase(), input.path, input.timestamp, bodyHash].join('\n');
  return createHmac('sha256', input.secret).update(message).digest('hex');
}

/**
 * Constant-time verification of an inbound internal signature. Returns the
 * failure reason so the guard can log something an operator can act on — a
 * missing header during a rollout means very different work from a mismatch.
 */
export function verifyInternalSignature(input: {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly windowMs?: number;
  readonly nowMs?: number;
}): InternalSignatureResult {
  if (input.secret.length === 0 || !input.timestamp || !input.signature) {
    return { valid: false, reason: 'missing_headers' };
  }
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'malformed_timestamp' };
  }
  const now = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? INTERNAL_SIGNATURE_WINDOW_MS;
  // Both directions: a far-past timestamp is a replay, a far-future one is an
  // attempt to buy a longer replay window with clock skew.
  if (Math.abs(now - ts) > windowMs) {
    return { valid: false, reason: 'stale' };
  }

  const expected = buildInternalSignature({
    secret: input.secret,
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp: input.timestamp,
  });
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    providedBuf = Buffer.from(input.signature, 'hex');
  } catch {
    return { valid: false, reason: 'malformed_signature' };
  }
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) {
    return { valid: false, reason: 'malformed_signature' };
  }
  return timingSafeEqual(expectedBuf, providedBuf)
    ? { valid: true }
    : { valid: false, reason: 'mismatch' };
}
