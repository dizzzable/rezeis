import { createHash } from 'node:crypto';

/**
 * Canonical checkout fingerprint.
 *
 * A logical checkout attempt (direct add-on purchase or renewal composition)
 * is identified by the stable hash of its full commercial composition, not by
 * its total amount. Two requests with the same client `idempotencyKey` must
 * resolve to the same draft only when their fingerprints match; a different
 * composition under the same key is an `IDEMPOTENCY_KEY_CONFLICT`.
 *
 * The hash is order-independent: object keys are serialized in sorted order so
 * field ordering never changes the fingerprint.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface AddOnCheckoutFingerprintInput {
  readonly contractVersion: number;
  readonly userId: string;
  readonly subscriptionId: string;
  /** Active baseline term id when known (ledger rollout); null on the legacy path. */
  readonly termId: string | null;
  readonly addOnId: string;
  readonly addOnRevision: number;
  readonly type: string;
  readonly value: number;
  readonly lifetime: string;
  readonly gatewayType: string;
  readonly channel: string;
  readonly currency: string;
  /** Server-resolved amount as a canonical decimal string. */
  readonly amount: string;
}

/**
 * Build the canonical fingerprint for a direct add-on checkout. Quantity is
 * fixed at 1 by product rule and included so the shape is stable if quantity
 * ever becomes variable.
 */
export function buildAddOnCheckoutFingerprint(input: AddOnCheckoutFingerprintInput): string {
  return fingerprint({
    kind: 'ADDON',
    quantity: 1,
    contractVersion: input.contractVersion,
    userId: input.userId,
    subscriptionId: input.subscriptionId,
    termId: input.termId,
    addOnId: input.addOnId,
    addOnRevision: input.addOnRevision,
    type: input.type,
    value: input.value,
    lifetime: input.lifetime,
    gatewayType: input.gatewayType,
    channel: input.channel,
    currency: input.currency,
    amount: input.amount,
  });
}

/** One selected add-on line inside a renewal composition. */
export interface RenewalAddOnSelectionInput {
  readonly addOnId: string;
  readonly addOnRevision: number;
  readonly type: string;
  readonly value: number;
  readonly lifetime: string;
  /** When this add-on activates: `NOW` or at the renewed term start. */
  readonly activation: string;
}

/** One subscription's renewal line (plan/duration/term + selected add-ons). */
export interface RenewalLineFingerprintInput {
  readonly subscriptionId: string;
  readonly planId: string;
  readonly durationDays: number;
  /** Scheduled/active baseline term id when known; null on the legacy path. */
  readonly termId: string | null;
  readonly addOns: readonly RenewalAddOnSelectionInput[];
}

export interface RenewalCheckoutFingerprintInput {
  readonly contractVersion: number;
  readonly userId: string;
  readonly gatewayType: string;
  readonly channel: string;
  readonly currency: string;
  readonly lines: readonly RenewalLineFingerprintInput[];
}

/**
 * Build the canonical fingerprint for a combined renewal composition.
 *
 * The fingerprint is over the full commercial COMPOSITION — every line's
 * plan/duration/term and every selected add-on's revision/type/value/lifetime/
 * activation — NOT the total amount (AC-R008: "same amount is irrelevant", so
 * two selections that happen to total the same but differ in products must NOT
 * collide). Ordering is normalized (lines sorted by subscriptionId, add-ons by
 * addOnId) so the client sending the same picks in a different order resolves
 * to the same draft.
 */
export function buildRenewalCheckoutFingerprint(input: RenewalCheckoutFingerprintInput): string {
  const lines = input.lines
    .map((line) => ({
      subscriptionId: line.subscriptionId,
      planId: line.planId,
      durationDays: line.durationDays,
      termId: line.termId,
      addOns: [...line.addOns]
        .map((addOn) => ({
          addOnId: addOn.addOnId,
          addOnRevision: addOn.addOnRevision,
          type: addOn.type,
          value: addOn.value,
          lifetime: addOn.lifetime,
          activation: addOn.activation,
          quantity: 1,
        }))
        .sort((left, right) => (left.addOnId < right.addOnId ? -1 : left.addOnId > right.addOnId ? 1 : 0)),
    }))
    .sort((left, right) =>
      left.subscriptionId < right.subscriptionId ? -1 : left.subscriptionId > right.subscriptionId ? 1 : 0,
    );

  return fingerprint({
    kind: 'RENEWAL',
    contractVersion: input.contractVersion,
    userId: input.userId,
    gatewayType: input.gatewayType,
    channel: input.channel,
    currency: input.currency,
    lines,
  });
}

/**
 * Returns the first `{subscriptionId, addOnId}` selected more than once within
 * a single renewal line, or `null` when every line's add-on picks are unique.
 * One add-on may be bought once per line (quantity is fixed at 1); a duplicate
 * pick is an `ADDON_DUPLICATE_SELECTION` rejection at composition time.
 */
export function findDuplicateAddOnSelection(
  input: RenewalCheckoutFingerprintInput,
): { readonly subscriptionId: string; readonly addOnId: string } | null {
  for (const line of input.lines) {
    const seen = new Set<string>();
    for (const addOn of line.addOns) {
      if (seen.has(addOn.addOnId)) {
        return { subscriptionId: line.subscriptionId, addOnId: addOn.addOnId };
      }
      seen.add(addOn.addOnId);
    }
  }
  return null;
}
