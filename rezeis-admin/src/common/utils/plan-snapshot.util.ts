import { readJsonObject } from './read-json-object.util';

/**
 * The plan's name out of a `planSnapshot` column — the snapshot taken when the
 * subscription was bought (`Subscription.planSnapshot`) or when the invoice was
 * drafted (`Transaction.planSnapshot`).
 *
 * WHY THE SNAPSHOT AND NOT `Plan.name`. The snapshot is what the customer
 * bought; the plan row is what the plan is called today. An operator reading
 * «Платёж получен» for a renewal wants the first — a plan renamed last week, or
 * soft-deleted since, still has to name itself on the card of the payment that
 * bought it, and a join that returns nothing for a deleted plan would leave the
 * card exactly as silent as it was before.
 *
 * No unsuffixing here, and none is needed: every snapshot writer copies the
 * name through `displayPlanName`, so the «(deleted …)» tail a soft-deleted plan
 * wears for the unique index never reaches the snapshot. A second pass over it
 * would be a second rule about what a plan is called.
 *
 * Returns `null`, never `''` or `'Plan'`: an absent name is a fact the caller
 * has to decide about, and a placeholder that looks like a name is worse on a
 * card than no line at all.
 */
export function planNameFromSnapshot(snapshot: unknown): string | null {
  const name = readJsonObject(snapshot)['name'];
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** How long the joined plan name may get before it is cut. */
const PLAN_NAME_LINE_LIMIT = 120;

/**
 * `{ planName }` for an event whose subject is one or MORE plans — a combined
 * renewal pays for several subscriptions at once, and the card has one line for
 * them. Distinct names in the order they were paid; nothing at all when not one
 * of them can be read, so the card omits the line rather than printing «План: ».
 *
 * Spread into the metadata object (`...planNamesMetadata(...)`) so the absent
 * case adds no key: `planName: undefined` would serialize into the audit row's
 * JSON as a key with no value, and `meta['planName']` is tested for truth.
 */
export function planNamesMetadata(snapshots: readonly unknown[]): { planName?: string } {
  return planNameMetadata(snapshots.map(planNameFromSnapshot));
}

/**
 * The key a combined renewal's draft writes its plan names under.
 *
 * A combined renewal's `Transaction.planSnapshot` is a MARKER, not a plan:
 * `{ combinedRenewal: true, snapshotVersion: 1, itemCount }`. The plans live on
 * the `TransactionItem` rows. Every later card about that payment — it failed,
 * it expired, it was refunded — holds the transaction and not the items, so
 * without this the name would cost each of them a second query, or be missing.
 * The draft knows the names; it writes them down once.
 */
export const COMBINED_RENEWAL_PLAN_NAMES_KEY = 'planNames';

/**
 * `{ planName }` from a `Transaction.planSnapshot` alone, for either shape: a
 * single purchase's plan snapshot, or a combined renewal's marker carrying
 * {@link COMBINED_RENEWAL_PLAN_NAMES_KEY}.
 *
 * A combined draft created BEFORE that key existed has neither, and its card
 * stays as silent as it was — nothing invents a name from an id.
 */
export function planNamesFromTransactionSnapshot(snapshot: unknown): { planName?: string } {
  const object = readJsonObject(snapshot);
  const single = planNameFromSnapshot(object);
  if (single !== null) return { planName: single };
  const many = object[COMBINED_RENEWAL_PLAN_NAMES_KEY];
  if (!Array.isArray(many)) return {};
  return planNameMetadata(many.map((name) => (typeof name === 'string' ? name : null)));
}

/**
 * `{ planName }` from names already in hand — for a caller holding the plan
 * ROWS it acted on rather than the snapshots. Distinct, in order, joined, and
 * cut rather than allowed to run a card over.
 */
export function planNameMetadata(names: readonly (string | null)[]): { planName?: string } {
  const distinct: string[] = [];
  for (const name of names) {
    const trimmed = name === null ? '' : name.trim();
    if (trimmed.length > 0 && !distinct.includes(trimmed)) distinct.push(trimmed);
  }
  if (distinct.length === 0) return {};
  const joined = distinct.join(', ');
  return {
    planName:
      joined.length > PLAN_NAME_LINE_LIMIT
        ? `${joined.slice(0, PLAN_NAME_LINE_LIMIT - 1).trimEnd()}…`
        : joined,
  };
}

/** The names to write into a combined renewal's marker at draft time. */
export function combinedRenewalPlanNames(snapshots: readonly unknown[]): string[] {
  const distinct: string[] = [];
  for (const snapshot of snapshots) {
    const name = planNameFromSnapshot(snapshot);
    if (name !== null && !distinct.includes(name)) distinct.push(name);
  }
  return distinct;
}
