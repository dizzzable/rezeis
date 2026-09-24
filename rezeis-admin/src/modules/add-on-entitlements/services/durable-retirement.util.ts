import {
  DeviceReductionPlanState,
  EffectiveProjectionState,
  Prisma,
} from '@prisma/client';

import type { AddOnEntitlementService } from './add-on-entitlement.service';
import type { SubscriptionTermService } from './subscription-term.service';

export interface DurableRetirementServices {
  readonly entitlements: Pick<AddOnEntitlementService, 'terminateForSubscriptionDeletion'>;
  readonly terms: Pick<SubscriptionTermService, 'closeForSubscriptionDeletion'>;
}

export interface DurableRetirementInput {
  readonly subscriptionId: string;
  readonly correlationId: string;
  /** `terminalReason` on the reversed entitlements, e.g. `SUBSCRIPTION_DELETED`, `USER_DELETED`. */
  readonly reason: string;
}

export interface DurableRetirementResult {
  /** Live entitlements (PENDING_ACTIVATION, ACTIVE, EXPIRING) found and reversed. */
  readonly entitlements: number;
  readonly projections: number;
  readonly devicePlans: number;
}

/**
 * WHAT A SUBSCRIPTION THAT IS GOING AWAY OWES THE TERM MODEL, inside the
 * caller's transaction: its live add-ons reversed, its ACTIVE term ended and its
 * SCHEDULED ones cancelled, its projection marked DELETED, and its open
 * device-reduction plans superseded.
 *
 * Every path that retires a subscription calls this, so the four writes cannot
 * drift apart: `SubscriptionDeletionService` before it marks a row DELETED, a
 * full user deletion, and the boundary sweep meeting a row some older path
 * deleted without them.
 * Leaving them out is not neutral: a DELETED row with an ACTIVE add-on past its
 * end is picked by the boundary sweep every tick, and the projection recompute
 * refuses a DELETED subscription, so the whole boundary transaction rolled back
 * and came back five minutes later — one of the rows that could fill the
 * sweep's window and starve healthy add-ons of their expiry.
 *
 * Idempotent: the reversal's command key is per subscription, and the other
 * three writes match nothing the second time.
 */
export async function retireDurableRowsInTransaction(
  tx: Prisma.TransactionClient,
  services: DurableRetirementServices,
  input: DurableRetirementInput,
): Promise<DurableRetirementResult> {
  const entitlements = await services.entitlements.terminateForSubscriptionDeletion(tx, {
    subscriptionId: input.subscriptionId,
    correlationId: input.correlationId,
    reason: input.reason,
  });
  await services.terms.closeForSubscriptionDeletion(tx, input.subscriptionId);
  const projections = await tx.subscriptionEffectiveProjection.updateMany({
    where: { subscriptionId: input.subscriptionId, state: { not: EffectiveProjectionState.DELETED } },
    data: { state: EffectiveProjectionState.DELETED },
  });
  const devicePlans = await tx.deviceReductionPlan.updateMany({
    where: {
      subscriptionId: input.subscriptionId,
      state: {
        in: [
          DeviceReductionPlanState.PENDING,
          DeviceReductionPlanState.IN_PROGRESS,
          DeviceReductionPlanState.BLOCKED,
        ],
      },
    },
    data: { state: DeviceReductionPlanState.SUPERSEDED },
  });
  return { entitlements, projections: projections.count, devicePlans: devicePlans.count };
}
