import { createHmac } from 'node:crypto';

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
