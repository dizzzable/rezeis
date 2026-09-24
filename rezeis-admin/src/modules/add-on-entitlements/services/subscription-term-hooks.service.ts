import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { readAddOnRolloutFlags } from '../add-on-rollout.config';
import { AddOnSwitchesService } from '../switches/add-on-switches.service';
import { EffectiveProjectionService, type RecomputeProjectionResult } from './effective-projection.service';
import { EntitlementCutoverService, type EnsureTermResult } from './entitlement-cutover.service';
import {
  SubscriptionTermService,
  type AlignTailOptions,
  type AlignTailResult,
  type RotateForPlanChangeInput,
  type RotateForPlanChangeResult,
} from './subscription-term.service';
import {
  grantTermLimitBonusInTransaction,
  type GrantTermLimitBonusInput,
  type TermLimitBonusGrant,
} from './term-limit-bonus.util';

/** The two services {@link rotatePlanChangeTermInTransaction} needs. */
export interface PlanChangeTermServices {
  readonly terms: Pick<SubscriptionTermService, 'alignTailToExpiryInTransaction' | 'rotateForPlanChangeInTransaction'>;
  readonly projections: Pick<EffectiveProjectionService, 'recomputeInTransaction'>;
}

export type PlanChangeTermResult =
  /** Not in the term model: the caller stays on the column path. */
  | Extract<RotateForPlanChangeResult, { readonly outcome: 'NO_ACTIVE_TERM' }>
  /** Queued terms refused the rotation; nothing but the alignment was written. */
  | Extract<RotateForPlanChangeResult, { readonly outcome: 'SCHEDULED_TERMS_BLOCK' }>
  /** The row is DELETED: nothing written, and a deleted row is not moved onto a plan. */
  | { readonly outcome: 'SUBSCRIPTION_DELETED' }
  | (Extract<RotateForPlanChangeResult, { readonly outcome: 'ROTATED' }> & {
      /** The projection recomputed in ACTIVE mode on the new term — what the columns must mirror. */
      readonly projection: RecomputeProjectionResult;
    });

/**
 * A PLAN CHANGE THAT SELLS NO TIME, in the term model: «Назначить план», the
 * bulk plan assignment of imported subscriptions, and plan migration. Inside the
 * caller's transaction.
 *
 * Everything below reads the row as it is at this moment — its `expiresAt`, its
 * snapshot, its limit columns — so a caller writes first whatever this must
 * see. «Назначить план», the bulk assignment and plan migration write the new
 * snapshot, the limits they carry and any new expiry first: the recompute
 * builds `desired` on the subscription's own share of its columns
 * (`entitlement-baseline.ts`), so that is how the new plan — and what sat above
 * the old one — reaches it.
 *
 * Three steps, in this order, and the order is the point:
 *
 *  1. ALIGN THE TAIL to `expiresAt` (`alignTailToExpiryInTransaction`). The
 *     rotation ends the ACTIVE term where it stands and starts the new one at
 *     `expiresAt`, so the old tail's end is frozen from then on. An
 *     UNTIL_SUBSCRIPTION_END add-on that ended with a DRIFTED tail — bonus days
 *     the hourly drift sweep has not reached yet, or the new expiry written in
 *     this same request — would keep that stale date forever: nothing re-times
 *     it afterwards, because the drift sweep compares only the TAIL, and the
 *     rotation has just made the tail right. Aligned first, it moves with the
 *     subscription. It aligns while any SCHEDULED term is still there, so an
 *     add-on that ends with the CURRENT period (at the queued renewal's start)
 *     keeps that date even when the rotation then cancels the renewal term: a
 *     renewal does not carry an add-on.
 *  2. ROTATE (`rotateForPlanChangeInTransaction`): end the ACTIVE term, activate
 *     one on the plan. Decided by the term row, never by a rollout flag.
 *  3. RECOMPUTE in ACTIVE mode, on the columns just written: their own share
 *     is the baseline (`resolveEntitlementBaseline`), the new term's base only
 *     the fallback, and live add-ons are summed once, on top — the limit
 *     columns already hold the recorded add-on share (they mirror the last
 *     projection, and the plan-change carry adds it back), and the recompute
 *     subtracts exactly that share first.
 *
 * Not for a PAID upgrade: there an add-on keeps its own end date (owner,
 * 24.09.2026), and step 1 would move it to the new expiry.
 */
export async function rotatePlanChangeTermInTransaction(
  tx: Prisma.TransactionClient,
  services: PlanChangeTermServices,
  input: RotateForPlanChangeInput,
  align: AlignTailOptions = {},
): Promise<PlanChangeTermResult> {
  const alignment = await services.terms.alignTailToExpiryInTransaction(tx, input.subscriptionId, align);
  if (alignment.outcome === 'SUBSCRIPTION_DELETED') return { outcome: 'SUBSCRIPTION_DELETED' };
  const rotation = await services.terms.rotateForPlanChangeInTransaction(tx, input);
  if (rotation.outcome !== 'ROTATED') return rotation;
  const projection = await services.projections.recomputeInTransaction(tx, {
    subscriptionId: input.subscriptionId,
    mode: 'ACTIVE',
  });
  return { ...rotation, projection };
}

/**
 * WHAT A SUBSCRIPTION WRITER OUTSIDE THE TERM MODEL OWES IT — the three calls a
 * path that creates a subscription, moves its expiry or changes its plan makes
 * inside its own transaction. One dependency for those paths, and the one place
 * the stage-1 gate on ENTERING the model is read.
 *
 * Only entry is flag-gated. Following an expiry and rotating a plan read no
 * flag: once a subscription has a term, what happens to that term follows the
 * term row, so turning stage 1 off stops new entrants and strands nobody.
 */
@Injectable()
export class SubscriptionTermHooksService {
  public constructor(
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly entitlementCutoverService: EntitlementCutoverService,
    /** The stage switches; `@Optional()` only for the specs that build this by hand. */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
  ) {}

  /**
   * A subscription this transaction has just CREATED (a free trial, the
   * operator's «Выдать подписку», a promo code's subscription) gets its first
   * term — while stage 1 («Новый учёт докупок») is on, and `null`
   * otherwise. Its columns are the plan's, so the baseline is MATCHED and the
   * SHADOW projection equals them; an add-on bought a minute later is then
   * ledgered rather than falling back to the permanent increment. Idempotent
   * (`ensureTermInTransaction`), so a path that runs twice mints one term.
   */
  public async enterNewSubscriptionInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<EnsureTermResult | null> {
    if (!(await readAddOnRolloutFlags(this.addOnSwitches)).entitlementShadow) return null;
    return this.entitlementCutoverService.ensureTermInTransaction(tx, subscriptionId);
  }

  /**
   * After a write that moved `subscription.expiresAt`, in the same transaction:
   * the tail term, and the add-ons that end with the subscription, follow it —
   * see `SubscriptionTermService.alignTailToExpiryInTransaction`. `NOT_IN_MODEL`
   * for a subscription with no term, which is every one while stage 1 is off.
   */
  public followExpiryInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    options: AlignTailOptions = {},
  ): Promise<AlignTailResult> {
    return this.subscriptionTermService.alignTailToExpiryInTransaction(tx, subscriptionId, options);
  }

  /** {@link rotatePlanChangeTermInTransaction} with this module's services. */
  public rotateForPlanChangeInTransaction(
    tx: Prisma.TransactionClient,
    input: RotateForPlanChangeInput,
    align: AlignTailOptions = {},
  ): Promise<PlanChangeTermResult> {
    return rotatePlanChangeTermInTransaction(
      tx,
      { terms: this.subscriptionTermService, projections: this.effectiveProjectionService },
      input,
      align,
    );
  }

  /**
   * A free limit bonus — a promo code's traffic or devices, a points
   * exchange's traffic — on a subscription in the term model: recorded on its
   * terms and projected (`grantTermLimitBonusInTransaction`). `NOT_IN_MODEL`,
   * with nothing written, for a subscription with no ACTIVE term; the caller
   * then raises the column the legacy way. The caller holds the row lock.
   */
  public grantLimitBonusInTransaction(
    tx: Prisma.TransactionClient,
    input: GrantTermLimitBonusInput,
  ): Promise<TermLimitBonusGrant> {
    return grantTermLimitBonusInTransaction(tx, input, this.effectiveProjectionService);
  }
}
