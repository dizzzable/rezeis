import { EntitlementIncidentState, Prisma } from '@prisma/client';

import { readJsonObject } from '../../../common/utils/read-json-object.util';

/**
 * `planSnapshot.snapshotSource` of every term past the first that NOBODY PAID
 * FOR: a plan change an operator or a migration decided. Kept as literals, not
 * imported, so this util depends on no controller or feature service:
 *   - `ADMIN_PLAN_ASSIGNMENT_TERM` — «Назначить план» on the user card
 *     (`admin-user-subscriptions.controller.ts`);
 *   - `BULK_PLAN_ASSIGNMENT_TERM` — «Назначить план импортированным»
 *     (`bulk-plan-assignment.service.ts`);
 *   - `PLAN_MIGRATION_TERM` — the move of a plan migration
 *     (`plan-migration-move.service.ts`);
 *   - `ADDON_REFUND_REBASED_TERM` — a refund taking a legacy add-on out of the
 *     running term's base (`addon-refund.service.ts`). It repeats the rest of
 *     the period it replaces on a lower base and records no payment of its
 *     own. The term it replaced stays in the table (ENDED; only the disposal
 *     below ever deletes a term), so a PAID period a refund rebased is still
 *     money through that term, and a period nobody paid for stays disposable.
 *
 * AN ALLOW-LIST, ON PURPOSE. Every other source — a paid renewal
 * (`RENEWAL_TERM`), a paid upgrade (`UPGRADE_TERM`, `UPGRADE_REBASED_TERM`) —
 * and any source this build does not know is read as MONEY.
 * A new term writer that nobody pays for is added here; forgetting to only
 * makes a merge or a deletion refuse, where the opposite mistake would throw a
 * paid period away. The PostgreSQL specs drive these writers for real
 * (`durable-disposal-postgres.spec.ts`; the refund's rebase in
 * `addon-refund-postgres.spec.ts`), so a renamed source fails them.
 */
export const NON_MONEY_TERM_SOURCES: ReadonlySet<string> = new Set([
  'ADMIN_PLAN_ASSIGNMENT_TERM',
  'BULK_PLAN_ASSIGNMENT_TERM',
  'PLAN_MIGRATION_TERM',
  'ADDON_REFUND_REBASED_TERM',
]);

/**
 * Whether a term records money: anything but the FIRST term — which only
 * `EntitlementCutoverService.ensureTermInTransaction` mints (every other term
 * writer needs an ACTIVE term to exist), from the row's own columns — and the
 * plan changes in {@link NON_MONEY_TERM_SOURCES}.
 */
function isPaidTerm(term: { readonly generation: number; readonly planSnapshot: Prisma.JsonValue }): boolean {
  if (term.generation === 1) return false;
  const source = readJsonObject(term.planSnapshot)['snapshotSource'];
  return typeof source !== 'string' || !NON_MONEY_TERM_SOURCES.has(source);
}

/** The Prisma surface the two functions below read and write through. */
export type DurableRowsClient = Pick<
  Prisma.TransactionClient,
  | 'subscriptionTerm'
  | 'subscriptionResetEpoch'
  | 'subscriptionEffectiveProjection'
  | 'addOnEntitlement'
  | 'deviceReductionPlan'
  | 'entitlementIncident'
>;

/** Every durable row a subscription carries, counted, and whether all of it is disposable. */
export interface DurableRowsOnSubscription {
  readonly terms: number;
  /** Of {@link terms}, those that record money (see {@link NON_MONEY_TERM_SOURCES}). */
  readonly paidTerms: number;
  readonly resetEpochs: number;
  readonly projections: number;
  readonly entitlements: number;
  readonly devicePlans: number;
  readonly incidents: number;
  /** Of {@link incidents}, those still OPEN. */
  readonly openIncidents: number;
  /**
   * `true` when nothing here records money — see {@link describeDurableRows}.
   * Also `true` for a row with no durable rows at all.
   */
  readonly disposable: boolean;
}

/** What {@link discardDisposableRowsInTransaction} deleted. */
export interface DiscardedDurableRows {
  readonly terms: number;
  readonly projections: number;
  /** Closed (ACKNOWLEDGED or RESOLVED) incidents: an OPEN one refuses instead. */
  readonly incidents: number;
}

/**
 * What the term model holds for one subscription, and whether NONE of it
 * records money — and so whether it can go with the row.
 *
 * MONEY here is (since 24.09.2026):
 *   - an add-on entitlement in ANY state — each has a source payment, and an
 *     EXPIRED or REVERSED one is still a sale on the books;
 *   - a term a payment minted: a renewal's, an upgrade's, or one of a source
 *     this build does not know ({@link isPaidTerm});
 *   - a reset epoch, a device-reduction plan, an OPEN incident.
 *
 * Everything else is the model's own derivation from the row: the first term
 * the cutover minted from the columns, the terms a plan change rotated it onto
 * («Назначить план», the bulk assignment, a plan migration — nobody paid, the
 * decision is the subscription's plan, which the row keeps), a refund's
 * rebase of any of these, their projection, and incidents already closed. WHATEVER THE GENERATIONS: a rotated chain
 * used to count as "operator history", so a no-money duplicate an operator
 * had assigned a plan to could be neither merged nor deleted.
 */
export async function describeDurableRows(
  client: DurableRowsClient,
  subscriptionId: string,
): Promise<DurableRowsOnSubscription> {
  const terms = await client.subscriptionTerm.findMany({
    where: { subscriptionId },
    select: { id: true, generation: true, planSnapshot: true },
  });
  const termIds = terms.map((term) => term.id);
  const [resetEpochs, projections, entitlements, devicePlans, incidents, openIncidents] = await Promise.all([
    termIds.length === 0
      ? Promise.resolve(0)
      : client.subscriptionResetEpoch.count({ where: { termId: { in: termIds } } }),
    client.subscriptionEffectiveProjection.count({ where: { subscriptionId } }),
    client.addOnEntitlement.count({ where: { subscriptionId } }),
    client.deviceReductionPlan.count({ where: { subscriptionId } }),
    client.entitlementIncident.count({ where: { subscriptionId } }),
    client.entitlementIncident.count({ where: { subscriptionId, state: EntitlementIncidentState.OPEN } }),
  ]);
  const paidTerms = terms.filter(isPaidTerm).length;
  return {
    terms: terms.length,
    paidTerms,
    resetEpochs,
    projections,
    entitlements,
    devicePlans,
    incidents,
    openIncidents,
    disposable:
      paidTerms === 0 && resetEpochs === 0 && entitlements === 0 && devicePlans === 0 && openIncidents === 0,
  };
}

/**
 * Deletes a subscription's disposable durable rows inside the caller's
 * transaction — its terms, its projection and its closed incidents — and
 * returns what it deleted, or `null`, touching nothing, when any of them
 * records money (see {@link describeDurableRows}).
 *
 * Deleted rather than closed: all of them are `Restrict` on the subscription,
 * and a row that is being RETIRED must not keep rows pointing at it. The
 * projection goes before the terms — it references one.
 *
 * Call it holding the subscription's row lock: every writer of these tables
 * takes that lock first, so what was classified is what gets deleted.
 */
export async function discardDisposableRowsInTransaction(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<DiscardedDurableRows | null> {
  const described = await describeDurableRows(tx, subscriptionId);
  if (!described.disposable) return null;
  if (described.terms === 0 && described.projections === 0 && described.incidents === 0) {
    return { terms: 0, projections: 0, incidents: 0 };
  }
  // Disposable means none of them is OPEN: every incident here is closed.
  const incidents =
    described.incidents === 0
      ? 0
      : (
          await tx.entitlementIncident.deleteMany({
            where: { subscriptionId, state: { not: EntitlementIncidentState.OPEN } },
          })
        ).count;
  const projections = await tx.subscriptionEffectiveProjection.deleteMany({ where: { subscriptionId } });
  const terms = await tx.subscriptionTerm.deleteMany({ where: { subscriptionId } });
  return { terms: terms.count, projections: projections.count, incidents };
}
