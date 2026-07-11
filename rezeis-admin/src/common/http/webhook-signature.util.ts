import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe-style webhook signature.
 *
 * Format
 *   X-Rezeis-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
 *
 * The HMAC is computed over `<timestamp>.<raw-body>` so receivers must
 * verify the timestamp before checking the digest. Replay attacks are
 * prevented by rejecting timestamps older than ~5 minutes on the
 * receiver side.
 *
 * We chose this format over a single header HMAC because:
 *   - It is the de-facto standard (Stripe, GitHub, Shopify, …) — most
 *     receivers already have library support.
 *   - The timestamp is signed, so a tampering attacker cannot replay
 *     bodies under a fresh `t=` value.
 */
export function buildWebhookSignature(input: {
  readonly secret: string;
  readonly body: string;
  readonly timestampSec?: number;
}): { readonly header: string; readonly timestamp: number } {
  const timestamp = input.timestampSec ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${input.body}`;
  const hmac = createHmac('sha256', input.secret).update(signedPayload).digest('hex');
  return {
    header: `t=${timestamp},v1=${hmac}`,
    timestamp,
  };
}

export type WebhookSignatureFailure = 'malformed' | 'stale' | 'bad_signature';

export interface WebhookVerifyResult {
  readonly valid: boolean;
  readonly reason?: WebhookSignatureFailure;
  readonly timestamp?: number;
}

/**
 * Verifies a `t=<sec>,v1=<hmac>` webhook signature against `<t>.<body>`.
 *
 * Order matters: parse → freshness → constant-time digest compare. The
 * timestamp is checked BEFORE the digest so a replayed body under an old `t=`
 * is rejected as `stale` even if an attacker could somehow forge the digest.
 * Default freshness window is 5 minutes (matches the builder's contract).
 */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly body: string;
  readonly header: string;
  readonly maxAgeSec?: number;
  readonly nowSec?: number;
}): WebhookVerifyResult {
  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) {
    return { valid: false, reason: 'malformed' };
  }

  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = input.maxAgeSec ?? 300;
  // Reject both far-past (replay) and far-future (clock-skew abuse) timestamps.
  if (Math.abs(now - parsed.timestamp) > maxAge) {
    return { valid: false, reason: 'stale', timestamp: parsed.timestamp };
  }

  const expected = createHmac('sha256', input.secret)
    .update(`${parsed.timestamp}.${input.body}`)
    .digest('hex');
  if (!constantTimeEqualHex(parsed.signature, expected)) {
    return { valid: false, reason: 'bad_signature', timestamp: parsed.timestamp };
  }

  return { valid: true, timestamp: parsed.timestamp };
}

function parseSignatureHeader(
  header: string,
): { readonly timestamp: number; readonly signature: string } | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number.parseInt(value, 10);
    } else if (key === 'v1') {
      if (!/^[0-9a-f]{64}$/i.test(value)) return null;
      signature = value.toLowerCase();
    }
  }
  if (timestamp === null || signature === null || !Number.isFinite(timestamp)) {
    return null;
  }
  return { timestamp, signature };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
