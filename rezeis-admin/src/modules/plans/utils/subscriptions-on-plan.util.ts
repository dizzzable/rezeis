import { Prisma, SubscriptionStatus } from '@prisma/client';

/**
 * "SUBSCRIPTION S IS ON PLAN P" — ONE SPELLING FOR EVERY READER.
 *
 * A subscription has no plan column. It is on a plan when it is not DELETED and
 * its stored `planSnapshot` names the plan: under `id`, which every snapshot
 * writer records, or under `planId`, which the re-importers write
 * (`bulk-plan-assignment.service.ts`).
 *
 * Three readers must agree about this set, and before this file they would
 * have been three expressions of it:
 *
 *   - `PlanReferenceGuardService` counts it as the `subscriptions` kind, which
 *     decides whether a deleted plan's row may go;
 *   - the delete dialog lists it (`GET /admin/plans/:planId/subscriptions`);
 *   - the plan migration re-checks a subscription against it under the row
 *     lock before moving it, and skips one that has left.
 *
 * If the listing and the guard disagreed, the dialog would offer to move a set
 * that is not the set keeping the plan — the operator moves "everything" and
 * the plan still counts subscribers, or a subscriber the guard counts is never
 * offered. Hence a function rather than a copied `where`.
 *
 * Combine it with `AND`, never by spreading: the fragment carries its own `OR`,
 * and a spread next to another `OR` silently replaces one of them.
 */
export function subscriptionsOnPlanWhere(planId: string): Prisma.SubscriptionWhereInput {
  return {
    status: { not: SubscriptionStatus.DELETED },
    OR: [
      { planSnapshot: { path: ['id'], equals: planId } },
      { planSnapshot: { path: ['planId'], equals: planId } },
    ],
  };
}
