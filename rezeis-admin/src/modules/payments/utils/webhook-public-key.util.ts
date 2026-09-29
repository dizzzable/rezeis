import { createPublicKey, type KeyObject } from 'node:crypto';

/**
 * Antilopay, Overpay and Wata each verify with an RSA public key the operator
 * pastes in from the provider's own documentation — and the three docs show
 * three different encodings: Antilopay's Node.js sample prints PEM, Wata serves
 * PKCS1 PEM from `GET /api/h2h/public-key`, Overpay documents bare base64 DER.
 *
 * Antilopay's branch used to accept DER only, so an operator who followed
 * Antilopay's documentation to the letter got a 403 on every callback: money
 * taken, the transaction stuck PENDING until the expiry sweep cancelled it.
 * One helper rather than a third copy of the same two-branch check.
 *
 * The `trim()` is defensive but deliberate — a key pasted from a doc page or
 * read out of a file carries a trailing newline, and the private-key side of
 * Antilopay has a documented failure from exactly that. Interior newlines are
 * untouched, so PEM line wrapping still parses.
 *
 * Lives in a file of its own, not beside the callback verification, so that the
 * check made when the key is SAVED (`antilopay-keys.util.ts`) reads the key
 * exactly as the callback later will, without a util importing a service.
 */
export function createWebhookPublicKey(publicKey: string): KeyObject {
  const normalizedKey = publicKey.trim();
  return normalizedKey.includes('BEGIN')
    ? createPublicKey(normalizedKey)
    : createPublicKey({
        key: Buffer.from(normalizedKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
}
