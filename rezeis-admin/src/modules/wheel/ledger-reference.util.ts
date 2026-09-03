/**
 * How a client-supplied handle becomes a ledger reference key.
 *
 * Both journals are unique on `(source, referenceKey)` and neither carries a
 * user column, so the key namespace is GLOBAL. A handle written straight
 * through would therefore be claimed by whoever used it first, for everybody:
 * the second person to send the same string finds the row already there, is
 * told their request was already served, and — because their own spin row
 * does not exist — gets a 500 they can never get past with that handle.
 *
 * The handle comes from the cabinet and is only as unique as the cabinet
 * chose to make it (today a UUID, but the contract accepts any 8–100
 * characters), so this is untrusted input, not a theoretical collision.
 * Prefixing with the user id makes the namespace per-person, which is what
 * every caller already means by "this request".
 */
export function scopedLedgerReference(userId: string, requestKey: string): string {
  return `${userId}:${requestKey}`;
}
