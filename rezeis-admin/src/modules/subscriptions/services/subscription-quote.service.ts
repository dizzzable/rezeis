import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AddOnEntitlementState,
  AddOnType,
  ArchivedPlanRenewMode,
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Subscription,
  SubscriptionEffectiveProjection,
  SubscriptionStatus,
  User,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import { recordedAddOnContributionOf } from '../../add-on-entitlements/services/configured-baseline.util';
import { PlanCatalogService } from '../../plans/services/plan-catalog.service';
import { PricingService } from '../../plans/services/pricing.service';
import { isGatewayAvailableForChannel } from '../../plans/utils/purchase-gateway-policy.util';
import { isPlanSoftDeleted } from '../../plans/utils/plan-deletion.util';
import { PLAN_INCLUDE, PlanRecord } from '../../plans/utils/plan-record.util';
import { evaluateTrialClaim, readTrialSettings } from '../../plans/utils/trial-settings.util';
import { isInvitedUser } from '../../plans/utils/trial-invite.util';
import { SubscriptionActionPolicyDto } from '../dto/subscription-action-policy.dto';
import { SubscriptionQuoteAction, SubscriptionQuoteDto } from '../dto/subscription-quote.dto';
import {
  SubscriptionActionPolicyInterface,
  SubscriptionQuoteActiveAddOnInterface,
  SubscriptionQuoteCarriedLimitsInterface,
  SubscriptionQuoteDurationInterface,
  SubscriptionQuoteInterface,
  SubscriptionQuotePlanInterface,
  SubscriptionQuotePriceInterface,
  SubscriptionQuoteWarningInterface,
} from '../interfaces/subscription-quote.interface';
import {
  pickBestDiscount,
  type PendingDiscountGrant,
} from '../../../common/utils/pending-discount.util';
import {
  readPaidRemainderCandidates,
  resolvePaidRemainderConversion,
} from './paid-remainder-conversion.util';
import {
  resolvePlanChangeLimitCarry,
  withRecordedDevices,
  withRecordedTraffic,
  type PlanChangeLimitCarry,
} from './plan-inherited-limits.util';
import { countCommittedTrialClaimUnits, findResumablePaidTrialClaim } from './trial-claim-ledger.util';

type UserRecord = Pick<User, 'id' | 'maxSubscriptions' | 'purchaseDiscount' | 'personalDiscount'> & {
  /**
   * Unspent discount grants.
   *
   * ── Why the quote needs them and the column is not enough ────────────────
   *
   * THIS is the price the customer is charged. A grant may be restricted to
   * certain plans, so the discount is a property of the pair (user, plan) — and
   * `user.purchaseDiscount` is a single number that remembers only the most
   * recent grant, with none of its restrictions.
   *
   * Pricing the catalog one way and the quote another is how a screen shows
   * one number and the invoice carries a different one. Both call the same
   * `pickBestDiscount`.
   */
  readonly pendingDiscounts: readonly PendingDiscountGrant[];
};
type SubscriptionRecord = Pick<
  Subscription,
  | 'id'
  | 'userId'
  | 'status'
  | 'isTrial'
  | 'planSnapshot'
  | 'createdAt'
  | 'trafficLimit'
  | 'deviceLimit'
  | 'expiresAt'
  | 'startedAt'
> & {
  /**
   * The add-on share the last projection recompute recorded, read beside the
   * row for the upgrade quote's carry. `null` with no projection row — the
   * durable model off, which is the shipped default.
   */
  readonly effectiveProjection: Pick<
    SubscriptionEffectiveProjection,
    'activeTrafficContributionBytes' | 'activeDeviceContribution'
  > | null;
};

const SOURCE_SUBSCRIPTION_REQUIRED: SubscriptionQuoteWarningInterface = {
  code: 'SOURCE_SUBSCRIPTION_REQUIRED',
  message: 'Select a source subscription for this action.',
};
const SOURCE_PLAN_MISSING: SubscriptionQuoteWarningInterface = {
  code: 'SOURCE_PLAN_MISSING',
  message: 'The source subscription plan is no longer available.',
};
const ARCHIVED_PLAN_REPLACEMENT: SubscriptionQuoteWarningInterface = {
  code: 'ARCHIVED_PLAN_REPLACEMENT',
  message: 'The source plan is archived and requires a replacement plan.',
};
const UPGRADE_RESETS_EXPIRY: SubscriptionQuoteWarningInterface = {
  code: 'UPGRADE_RESETS_EXPIRY',
  message: 'Upgrade starts immediately and resets the expiration date.',
};
const TRIAL_UPGRADE_REQUIRED: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_UPGRADE_REQUIRED',
  message:
    'An existing trial subscription must be upgraded instead of creating a new subscription.',
};

/**
 * The trial a purchase converts instead of creating another subscription: one
 * the buyer still holds (`buildContext` reads no DELETED row) and an upgrade
 * may move onto a regular plan. That is every status but DISABLED — an
 * operator's freeze, which the upgrade would lift (its fulfilment writes
 * ACTIVE), and which the cabinet never offers for an upgrade either.
 *
 * While the buyer holds one, a purchase that CREATES a subscription (NEW or
 * ADDITIONAL) is refused: the action policy closes both, and the checkout draft
 * enforces it with `TRIAL_UPGRADE_REQUIRED`. The purchase is an UPGRADE of the
 * trial — same subscription, same link, the trial flag cleared. NEW was already
 * closed this way; ADDITIONAL was not, so with multi-subscription on a
 * subscriber who pressed «Купить» beside a trial came away holding the trial
 * AND a second subscription with a second link.
 */
export function isConvertibleTrial(
  subscription: Pick<Subscription, 'isTrial' | 'status'>,
): boolean {
  return (
    subscription.isTrial &&
    subscription.status !== SubscriptionStatus.DELETED &&
    subscription.status !== SubscriptionStatus.DISABLED
  );
}
const TRIAL_ALREADY_USED: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_ALREADY_USED',
  message: 'The user has already used a trial subscription.',
};
const TRIAL_NOT_RENEWABLE: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_NOT_RENEWABLE',
  message: 'A trial subscription cannot be renewed — upgrade to a regular plan instead.',
};
const TRIAL_PLAN_NOT_RENEWAL_TARGET: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_PLAN_NOT_RENEWAL_TARGET',
  message: 'A trial plan cannot be used as a renewal target.',
};
const SUBSCRIPTION_DISABLED_NOT_RENEWABLE: SubscriptionQuoteWarningInterface = {
  code: 'SUBSCRIPTION_DISABLED_NOT_RENEWABLE',
  message: 'A disabled subscription cannot be renewed. Enable it before renewing.',
};
const SUBSCRIPTION_LIMIT_REACHED: SubscriptionQuoteWarningInterface = {
  code: 'SUBSCRIPTION_LIMIT_REACHED',
  message: 'The user has reached the maximum number of active subscriptions.',
};
const PLAN_SELECTION_REQUIRED: SubscriptionQuoteWarningInterface = {
  code: 'PLAN_SELECTION_REQUIRED',
  message: 'Select a plan before requesting a quote.',
};
const DURATION_SELECTION_REQUIRED: SubscriptionQuoteWarningInterface = {
  code: 'DURATION_SELECTION_REQUIRED',
  message: 'Select a plan duration before requesting a quote.',
};
const GATEWAY_NOT_AVAILABLE: SubscriptionQuoteWarningInterface = {
  code: 'GATEWAY_NOT_AVAILABLE',
  message: 'The selected payment gateway is not available for this quote.',
};
const TRIAL_INVITED_ONLY: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_INVITED_ONLY',
  message: 'This trial is available only to users invited via a referral or partner link.',
};

const TRIAL_REQUIRES_TELEGRAM: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_REQUIRES_TELEGRAM',
  message: 'This trial requires a linked Telegram account. Link Telegram in the cabinet first.',
};

/**
 * Warning codes that are purely INFORMATIONAL — they describe a side-effect of
 * a purchase the user CAN still make (the expiry resets on upgrade; an archived
 * plan is swapped for its replacement), not a reason the quote is ineligible.
 * They MUST NOT count towards the `isEligible` gate:
 *   - `UPGRADE_RESETS_EXPIRY` is attached to every upgrade quote, so treating
 *     it as blocking made `createDraft` reject every UPGRADE checkout with
 *     PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE (a 400 BAD_REQUEST) — most visibly when
 *     upgrading a trial.
 *   - `ARCHIVED_PLAN_REPLACEMENT` is attached when renewing a subscription
 *     whose plan was archived with REPLACE_ON_RENEW — the renewal proceeds
 *     onto the (valid, priced) replacement plan, so it's a notice, not a
 *     blocker. Treating it as blocking made `priceRenewalItems` reject every
 *     such renewal (RENEWAL_ITEM_NOT_PRICEABLE → 400 BAD_REQUEST), i.e. those
 *     subscriptions could never be renewed at all.
 * Eligibility still requires a resolvable priced plan/duration, so a missing
 * replacement or an unpriceable plan stays ineligible via the other guards.
 */
const INFORMATIONAL_WARNING_CODES: ReadonlySet<string> = new Set([
  'UPGRADE_RESETS_EXPIRY',
  'ARCHIVED_PLAN_REPLACEMENT',
]);

/** Blocking warnings are everything that is not purely informational. */
function hasBlockingWarning(warnings: readonly SubscriptionQuoteWarningInterface[]): boolean {
  return warnings.some((warning) => !INFORMATIONAL_WARNING_CODES.has(warning.code));
}

const AVAILABILITY_WARNING_CODES: ReadonlySet<string> = new Set([
  'PLAN_NOT_AVAILABLE',
  'DURATION_NOT_AVAILABLE',
]);

/**
 * True when an ineligible quote is refused ONLY because the chosen plan or term
 * is not offered to this buyer any more — withdrawn, archived, deleted, or no
 * longer a target of this action.
 *
 * Exported for the checkout draft, which names this case with a code of its own
 * (`PAYMENT_DRAFT_PLAN_NOT_AVAILABLE`): a client answers it by refetching the
 * plan list, and that is only right when the plan is gone from that list. Any
 * other blocking warning beside it explains the refusal better and keeps the
 * generic code — a paid trial the buyer cannot claim is also "not available" to
 * them, but it is still listed, so "choose from the updated list" would lead
 * straight back to it.
 */
export function isPlanAvailabilityRefusal(
  warnings: readonly SubscriptionQuoteWarningInterface[],
): boolean {
  const blocking = warnings.filter((warning) => !INFORMATIONAL_WARNING_CODES.has(warning.code));
  return (
    blocking.length > 0 &&
    blocking.every((warning) => AVAILABILITY_WARNING_CODES.has(warning.code))
  );
}

/**
 * What makes a plan a valid upgrade or replacement TARGET: on sale, not a trial,
 * not deleted.
 * Exported for `SubscriptionRenewalService`, which must know whether an archived
 * REPLACE_ON_RENEW plan still has a replacement to renew onto — if the two ever
 * disagreed, the renewal would either ask for a choice the quote does not offer,
 * or silently pick a plan the quote offered only to choose from — and for
 * `PlanReferenceGuardService`'s `replacementOrphans`, which warns about the set
 * the renewal then asks to choose for. All three read this one object.
 *
 * `deletedAt: null` beside the flags: the delete switches a plan off as it stamps
 * it, but an older image running on the same database can switch the flags back
 * on, and a deleted plan is gone for everyone whatever they say.
 */
export const TRANSITION_TARGET_WHERE = {
  isActive: true,
  isArchived: false,
  deletedAt: null,
  availability: { not: PlanAvailability.TRIAL },
} as const satisfies Prisma.PlanWhereInput;

@Injectable()
export class SubscriptionQuoteService {
  private readonly logger = new Logger(SubscriptionQuoteService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly planCatalogService: PlanCatalogService,
    private readonly pricingService: PricingService,
  ) {}

  /**
   * Resolves the canonical `reiwa_id` from either an explicit `userId`
   * (already a reiwa_id) or a `telegramId`. The reiwa edge sends the
   * reiwa_id for web / web-first users and the Telegram id for
   * Telegram-only flows; the admin panel always sends the reiwa_id.
   */
  private async resolveUserId(input: {
    readonly userId?: string;
    readonly telegramId?: string;
  }): Promise<string> {
    if (typeof input.userId === 'string' && input.userId.length > 0) {
      return input.userId;
    }
    if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(input.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }
      return user.id;
    }
    throw new NotFoundException('A userId or telegramId is required');
  }

  /**
   * Capacity snapshot for the subscription cap. `capacityAvailable` uses the
   * SAME definition as {@link getActionPolicy} (`activeSubscriptionCount <
   * effectiveMaxSubscriptions`, counting every non-DELETED subscription) so
   * the server-side purchase guard and the UI action gating never disagree.
   *
   * Enforcing this at draft-creation time (see `PaymentsTransactionsService`)
   * is what actually caps NEW/ADDITIONAL purchases — the action policy alone
   * only hides the button, so a direct checkout call previously let a user
   * exceed `maxSubscriptions`. The cap only ever BLOCKS a new purchase; it
   * never touches subscriptions the user already owns, so lowering the limit
   * (or disabling multi-subscription) can't push existing subs into any
   * restricted state — it just stops further purchases.
   *
   * `convertibleTrialId` is the other reason a purchase may not create a
   * subscription — see {@link isConvertibleTrial}. It is read from the same
   * context, so the draft guard and the action policy agree on it too.
   */
  public async getSubscriptionCapacity(userId: string): Promise<{
    readonly activeSubscriptionCount: number;
    readonly effectiveMaxSubscriptions: number;
    readonly capacityAvailable: boolean;
    readonly convertibleTrialId: string | null;
  }> {
    const context = await this.buildContext({ userId, channel: PurchaseChannel.WEB });
    return {
      activeSubscriptionCount: context.activeSubscriptionCount,
      effectiveMaxSubscriptions: context.effectiveMaxSubscriptions,
      capacityAvailable: context.activeSubscriptionCount < context.effectiveMaxSubscriptions,
      convertibleTrialId: context.activeSubscriptions.find(isConvertibleTrial)?.id ?? null,
    };
  }

  public async getActionPolicy(
    input: SubscriptionActionPolicyDto,
  ): Promise<SubscriptionActionPolicyInterface> {
    const userId = await this.resolveUserId(input);
    const channel = input.channel ?? PurchaseChannel.WEB;
    const context = await this.buildContext({
      userId,
      channel,
      subscriptionId: input.subscriptionId,
    });
    const basePlans = await this.getCatalogOptionPlans({ userId, channel });
    const sourceSelection = await this.getSourceSelection({
      sourceSubscription: context.sourceSubscription,
      purchaseType: PurchaseType.RENEW,
      userId,
      channel,
    });
    const upgradeSelection = await this.getSourceSelection({
      sourceSubscription: context.sourceSubscription,
      purchaseType: PurchaseType.UPGRADE,
      userId,
      channel,
    });
    const trialPlans = basePlans.filter((plan) => plan.availability === 'TRIAL');
    // Only FREE trials are claimable via the dedicated trial action; paid
    // trials are purchased through the NEW flow like any other plan.
    const freeTrialPlans = trialPlans.filter((plan) => readTrialSettings(plan.trialSettings).free);
    const claimableFreeTrials = await this.filterClaimableTrials({
      userId,
      plans: freeTrialPlans,
    });
    const capacityAvailable = context.activeSubscriptionCount < context.effectiveMaxSubscriptions;
    const holdsConvertibleTrial = context.activeSubscriptions.some(isConvertibleTrial);
    const warnings = [
      ...sourceSelection.warnings,
      ...upgradeSelection.warnings,
      ...(holdsConvertibleTrial ? [TRIAL_UPGRADE_REQUIRED] : []),
      ...claimableFreeTrials.warnings,
      ...(!capacityAvailable ? [SUBSCRIPTION_LIMIT_REACHED] : []),
    ];
    return {
      userId,
      channel,
      actions: {
        NEW: capacityAvailable && !holdsConvertibleTrial,
        ADDITIONAL: capacityAvailable && !holdsConvertibleTrial,
        RENEW: sourceSelection.plans.length > 0,
        UPGRADE: upgradeSelection.plans.length > 0,
        TRIAL:
          capacityAvailable &&
          context.activeSubscriptionCount === 0 &&
          claimableFreeTrials.plans.length > 0,
      },
      activeSubscriptionCount: context.activeSubscriptionCount,
      maxSubscriptions: context.effectiveMaxSubscriptions,
      currentSubscriptionId: context.sourceSubscription?.id ?? null,
      availablePlans: basePlans.map(mapQuotePlan),
      warnings: dedupeWarnings(warnings),
    };
  }

  public async getQuote(
    input: SubscriptionQuoteDto & { readonly excludeTrialTransactionId?: string },
  ): Promise<SubscriptionQuoteInterface> {
    const userId = await this.resolveUserId(input);
    const channel = input.channel ?? PurchaseChannel.WEB;
    const context = await this.buildContext({
      userId,
      channel,
      subscriptionId: input.subscriptionId,
    });
    const { plans, warnings } = await this.getPlansForQuoteAction({
      userId,
      channel,
      purchaseType: input.purchaseType,
      sourceSubscription: context.sourceSubscription,
      excludeTrialTransactionId: input.excludeTrialTransactionId,
      selectedPlanId: input.planId,
    });
    const selectedPlan =
      input.planId === undefined ? null : (plans.find((plan) => plan.id === input.planId) ?? null);
    const quoteWarnings = [...warnings];
    if (input.planId === undefined) {
      quoteWarnings.push(PLAN_SELECTION_REQUIRED);
    } else if (selectedPlan === null) {
      quoteWarnings.push({
        code: 'PLAN_NOT_AVAILABLE',
        message: 'The selected plan is not available for this action.',
      });
    }
    const selectedDuration =
      selectedPlan === null || input.durationDays === undefined
        ? null
        : (selectedPlan.durations.find((duration) => duration.days === input.durationDays) ?? null);
    if (selectedPlan !== null && input.durationDays === undefined) {
      quoteWarnings.push(DURATION_SELECTION_REQUIRED);
    } else if (
      selectedPlan !== null &&
      input.durationDays !== undefined &&
      selectedDuration === null
    ) {
      quoteWarnings.push({
        code: 'DURATION_NOT_AVAILABLE',
        message: 'The selected duration is not available for this plan.',
      });
    }
    const price =
      selectedPlan === null || selectedDuration === null
        ? null
        : await this.calculateQuotePrice({
            plan: selectedPlan,
            duration: selectedDuration,
            user: context.user,
            channel,
            preferredGatewayType: input.gatewayType,
            currencyOverride: input.currencyOverride,
          });
    if (
      selectedPlan !== null &&
      selectedDuration !== null &&
      input.gatewayType !== undefined &&
      price === null
    ) {
      quoteWarnings.push(GATEWAY_NOT_AVAILABLE);
    }
    const upgradeCarry =
      input.purchaseType === PurchaseType.UPGRADE &&
      selectedPlan !== null &&
      context.sourceSubscription !== null
        ? { source: context.sourceSubscription, plan: selectedPlan }
        : null;
    const carry =
      upgradeCarry === null ? null : resolveUpgradeLimitCarry(upgradeCarry.source, upgradeCarry.plan);
    const carriedAbovePlan =
      upgradeCarry === null || carry === null ? null : describeCarriedAbovePlan(upgradeCarry.source, carry);
    const paidRemainderDays =
      upgradeCarry === null
        ? null
        : await this.estimatePaidRemainderDays(
            upgradeCarry.source,
            upgradeCarry.plan,
            selectedDuration?.days ?? null,
          );
    const activeAddOns =
      upgradeCarry === null || carry === null
        ? null
        : await this.resolveActiveAddOns({
            source: upgradeCarry.source,
            plan: upgradeCarry.plan,
            carry,
            durationDays: selectedDuration?.days ?? null,
            paidRemainderDays,
          });
    return {
      userId,
      purchaseType: input.purchaseType,
      channel,
      isEligible:
        selectedPlan !== null &&
        selectedDuration !== null &&
        price !== null &&
        !hasBlockingWarning(quoteWarnings),
      selectedSubscriptionId: context.sourceSubscription?.id ?? null,
      selectedPlan: selectedPlan === null ? null : mapQuotePlan(selectedPlan),
      selectedDuration: selectedDuration === null ? null : mapQuoteDuration(selectedDuration),
      availablePlans: plans.map(mapQuotePlan),
      price,
      warnings: dedupeWarnings(quoteWarnings),
      carriedAbovePlan,
      paidRemainderDays,
      activeAddOns,
    };
  }

  /**
   * How many whole days the old plan's paid remainder would add to an UPGRADE
   * onto `plan` if it were paid now — by the function fulfilment converts with
   * (`paid-remainder-conversion.util.ts`), over the same payments, so the two
   * cannot disagree about the rule. They differ only in `now`: fulfilment
   * counts again at payment, when a little less may be left.
   *
   * It describes the purchase and never decides it: data beside the warnings,
   * like `carriedAbovePlan`, and a failure to work it out is `null` — the
   * review then says what it always said — never a quote that fails.
   */
  private async estimatePaidRemainderDays(
    source: SubscriptionRecord,
    plan: PlanRecord,
    durationDays: number | null,
  ): Promise<number | null> {
    try {
      const conversion = resolvePaidRemainderConversion({
        now: new Date(),
        subscription: {
          id: source.id,
          status: source.status,
          expiresAt: source.expiresAt,
          startedAt: source.startedAt,
        },
        candidates: await readPaidRemainderCandidates(this.prismaService, source.id),
        targetPlanDurations: plan.durations,
        purchasedDurationDays: durationDays,
      });
      return conversion.days;
    } catch (error: unknown) {
      this.logger.warn(
        `Paid remainder estimate failed for subscription ${source.id} onto plan ${plan.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * The live durable add-ons an UPGRADE onto `plan` keeps, each with the end it
   * will have: its own date, never later than the subscription's new end —
   * the rule fulfilment applies (`PaymentSubscriptionMutationService`,
   * `carryLiveAddOnsAcrossUpgradeInTransaction`; owner, 24.09.2026).
   *
   * The new end is ESTIMATED as fulfilment will compute it — the chosen
   * duration plus the paid remainder's days — from now; fulfilment counts both
   * again at payment. With no remainder estimate it is taken as 0, which can
   * only put a clamp EARLIER than the real one: the review never promises a
   * later date than the customer gets.
   *
   * An add-on the new plan makes meaningless is left out: one on a resource the
   * plan leaves unlimited, or one an operator's unlimited setting absorbs (the
   * carry keeps that setting). The panel would add nothing with it.
   *
   * Data beside the warnings, like `carriedAbovePlan`: `null` when there is
   * nothing to list, and when it could not be read — logged, never a quote
   * that fails.
   */
  private async resolveActiveAddOns(input: {
    readonly source: SubscriptionRecord;
    readonly plan: PlanRecord;
    readonly carry: PlanChangeLimitCarry;
    readonly durationDays: number | null;
    readonly paidRemainderDays: number | null;
  }): Promise<readonly SubscriptionQuoteActiveAddOnInterface[] | null> {
    if (input.durationDays === null) return null;
    try {
      const rows = await this.prismaService.addOnEntitlement.findMany({
        where: {
          subscriptionId: input.source.id,
          state: AddOnEntitlementState.ACTIVE,
          type: { in: [AddOnType.EXTRA_TRAFFIC, AddOnType.EXTRA_DEVICES] },
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        select: { type: true, totalValue: true, expiresAt: true },
      });
      const newEnd =
        input.durationDays <= 0 ? null : addUtcDays(new Date(), input.durationDays + (input.paidRemainderDays ?? 0));
      const trafficAbsorbed = input.plan.trafficLimit === null || input.carry.carried.unlimitedTraffic;
      const devicesAbsorbed = input.plan.deviceLimit <= 0 || input.carry.carried.unlimitedDevices;
      const kept = rows.flatMap((row): SubscriptionQuoteActiveAddOnInterface[] => {
        const isTraffic = row.type === AddOnType.EXTRA_TRAFFIC;
        if (isTraffic ? trafficAbsorbed : devicesAbsorbed) return [];
        const end =
          newEnd === null
            ? row.expiresAt
            : row.expiresAt === null || row.expiresAt.getTime() > newEnd.getTime()
              ? newEnd
              : row.expiresAt;
        return [
          {
            type: isTraffic ? 'EXTRA_TRAFFIC' : 'EXTRA_DEVICES',
            value: isTraffic ? Number(row.totalValue / GIB_BYTES) : Number(row.totalValue),
            expiresAt: end === null ? null : end.toISOString(),
          },
        ];
      });
      return kept.length === 0 ? null : kept;
    } catch (error: unknown) {
      this.logger.warn(
        `Active add-ons could not be read for the upgrade quote of subscription ${input.source.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async buildContext(input: {
    readonly userId: string;
    readonly channel: PurchaseChannel;
    readonly subscriptionId?: string;
  }): Promise<{
    readonly user: UserRecord;
    readonly activeSubscriptions: readonly SubscriptionRecord[];
    readonly activeSubscriptionCount: number;
    readonly effectiveMaxSubscriptions: number;
    readonly sourceSubscription: SubscriptionRecord | null;
  }> {
    const user = await this.prismaService.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        maxSubscriptions: true,
        purchaseDiscount: true,
        personalDiscount: true,
        pendingDiscounts: {
          where: { consumedAt: null },
          select: {
            id: true,
            percent: true,
            allowedPlanIds: true,
            expiresAt: true,
            consumedAt: true,
          },
        },
      },
    });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
    const effectiveMaxSubscriptions = await this.resolveEffectiveMaxSubscriptions(
      user.maxSubscriptions,
    );
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId: input.userId,
        status: { not: SubscriptionStatus.DELETED },
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        userId: true,
        status: true,
        isTrial: true,
        planSnapshot: true,
        createdAt: true,
        trafficLimit: true,
        deviceLimit: true,
        expiresAt: true,
        startedAt: true,
        effectiveProjection: {
          select: { activeTrafficContributionBytes: true, activeDeviceContribution: true },
        },
      },
    });
    const sourceSubscription = input.subscriptionId
      ? subscriptions.find((subscription) => subscription.id === input.subscriptionId)
      : (subscriptions[0] ?? null);
    if (input.subscriptionId !== undefined && sourceSubscription === undefined) {
      throw new NotFoundException('Subscription not found');
    }
    return {
      user,
      activeSubscriptions: subscriptions,
      activeSubscriptionCount: subscriptions.length,
      effectiveMaxSubscriptions,
      sourceSubscription: sourceSubscription ?? null,
    };
  }

  /**
   * Effective per-user subscription cap. The per-user `user.maxSubscriptions`
   * column (default 1) is the floor; when the operator enables the global
   * multi-subscription policy (`Settings.multiSubscriptionSettings.enabled`),
   * its `defaultMaxSubscriptions` raises the cap for every user that hasn't
   * been bumped higher individually. Without this, setting the global limit to
   * N in the admin panel had no effect (the guard only read the per-user
   * column) so users stayed capped at 1 and could never buy a 2nd subscription.
   */
  private async resolveEffectiveMaxSubscriptions(userMax: number): Promise<number> {
    try {
      const settings = await this.prismaService.settings.findFirst({
        orderBy: { updatedAt: 'asc' },
        select: { multiSubscriptionSettings: true },
      });
      const config = readJsonRecord(settings?.multiSubscriptionSettings);
      const enabled = config['enabled'] === true;
      if (!enabled) {
        return userMax;
      }
      const rawDefault = config['defaultMaxSubscriptions'];
      const globalDefault =
        typeof rawDefault === 'number' && Number.isFinite(rawDefault) && rawDefault >= 1
          ? Math.floor(rawDefault)
          : 1;
      return Math.max(userMax, globalDefault);
    } catch {
      // Never block a purchase on a settings read hiccup — fall back to the
      // per-user cap.
      return userMax;
    }
  }

  private async getPlansForQuoteAction(input: {
    readonly userId: string;
    readonly channel: PurchaseChannel;
    readonly purchaseType: SubscriptionQuoteAction;
    readonly sourceSubscription: SubscriptionRecord | null;
    readonly excludeTrialTransactionId?: string;
    /** The plan being quoted, if any — see the NEW/ADDITIONAL branch. */
    readonly selectedPlanId?: string;
  }): Promise<{
    readonly plans: readonly PlanRecord[];
    readonly warnings: readonly SubscriptionQuoteWarningInterface[];
  }> {
    if (
      input.purchaseType === PurchaseType.NEW ||
      input.purchaseType === PurchaseType.ADDITIONAL ||
      input.purchaseType === 'TRIAL'
    ) {
      const plans = await this.getCatalogOptionPlans({
        userId: input.userId,
        channel: input.channel,
      });
      if (input.purchaseType === 'TRIAL') {
        // FREE-grant trial claim flow. Paid trials are NOT offered here —
        // they go through the NEW purchase pipeline below.
        return this.filterClaimableTrials({
          userId: input.userId,
          excludeTrialTransactionId: input.excludeTrialTransactionId,
          plans: plans.filter(
            (plan) => plan.availability === 'TRIAL' && readTrialSettings(plan.trialSettings).free,
          ),
        });
      }
      // NEW / ADDITIONAL: regular (non-trial) plans plus any PAID trial
      // plans the user is still allowed to claim. Free trials never enter
      // the paid pipeline.
      const nonTrialPlans = plans.filter((plan) => plan.availability !== 'TRIAL');
      const paidTrialPlans = plans.filter(
        (plan) => plan.availability === 'TRIAL' && !readTrialSettings(plan.trialSettings).free,
      );
      if (paidTrialPlans.length === 0) {
        return { plans: nonTrialPlans, warnings: [] };
      }
      const claimable = await this.filterClaimableTrials({
        userId: input.userId,
        plans: paidTrialPlans,
        excludeTrialTransactionId: input.excludeTrialTransactionId,
      });
      // The claim warnings describe the trials that were DROPPED, so they belong
      // to a quote for one of those trials, or to a quote with no plan chosen
      // yet. On any other plan they are noise — and blocking noise: they are not
      // informational, so a regular plan quoted with a price and was then refused
      // at checkout. A web-only subscriber could buy nothing while a paid trial
      // requiring Telegram was on sale.
      const droppedTrialSelected = paidTrialPlans.some(
        (plan) => plan.id === input.selectedPlanId && !claimable.plans.includes(plan),
      );
      return {
        plans: [...nonTrialPlans, ...claimable.plans],
        warnings:
          input.selectedPlanId === undefined || droppedTrialSelected ? claimable.warnings : [],
      };
    }
    return this.getSourceSelection({
      sourceSubscription: input.sourceSubscription,
      purchaseType: input.purchaseType,
      userId: input.userId,
      channel: input.channel,
    });
  }

  /**
   * Applies the per-plan trial abuse guards (`maxClaims`,
   * `availabilityScope`) to a set of free or paid trial plans, returning only the
   * ones the user may still purchase plus a warning describing why any
   * were dropped. The claim count is the user's `isTrial` subscription
   * count (including deleted ones — a consumed trial always counts), which
   * both completion paths stamp.
   */
  private async filterClaimableTrials(input: {
    readonly userId: string;
    readonly plans: readonly PlanRecord[];
    readonly excludeTrialTransactionId?: string;
  }): Promise<{
    readonly plans: readonly PlanRecord[];
    readonly warnings: readonly SubscriptionQuoteWarningInterface[];
  }> {
    const needsInviteCheck = input.plans.some(
      (plan) => readTrialSettings(plan.trialSettings).availabilityScope === 'INVITED',
    );
    const needsTelegramCheck = input.plans.some(
      (plan) => readTrialSettings(plan.trialSettings).requireTelegramLink === true,
    );
    // A reservation the buyer can still resolve themselves must not hide the
    // trial from them. Without this, abandoning a checkout (closed page,
    // blocked redirect, backed out of the card form) reported the trial as
    // already used — while the attempt that "used" it was unpaid and still
    // theirs to finish. Quoting is display-only; the actual reservation is
    // decided under a lock with the unfiltered count, so this cannot grant a
    // second trial. An explicit exclude from the caller always wins.
    const resumable =
      input.excludeTrialTransactionId !== undefined
        ? null
        : await findResumablePaidTrialClaim(this.prismaService, input.userId);
    const [priorTrialClaims, invited, userRow] = await Promise.all([
      countCommittedTrialClaimUnits(
        this.prismaService,
        input.userId,
        input.excludeTrialTransactionId ?? resumable?.transactionId,
      ),
      needsInviteCheck ? isInvitedUser(this.prismaService, input.userId) : Promise.resolve(true),
      needsTelegramCheck
        ? this.prismaService.user.findUnique({
            where: { id: input.userId },
            select: { telegramId: true },
          })
        : Promise.resolve(null),
    ]);
    const hasTelegram =
      !needsTelegramCheck || (userRow?.telegramId !== null && userRow?.telegramId !== undefined);
    const claimable: PlanRecord[] = [];
    const warnings: SubscriptionQuoteWarningInterface[] = [];
    for (const plan of input.plans) {
      const claim = evaluateTrialClaim(readTrialSettings(plan.trialSettings), {
        priorTrialClaims,
        isInvited: invited,
        hasTelegram,
      });
      if (claim.allowed) {
        claimable.push(plan);
      } else if (claim.reason === 'TRIAL_ALREADY_USED') {
        warnings.push(TRIAL_ALREADY_USED);
      } else if (claim.reason === 'TRIAL_INVITED_ONLY') {
        warnings.push(TRIAL_INVITED_ONLY);
      } else if (claim.reason === 'TRIAL_REQUIRES_TELEGRAM') {
        warnings.push(TRIAL_REQUIRES_TELEGRAM);
      }
    }
    return { plans: claimable, warnings };
  }

  private async getSourceSelection(input: {
    readonly sourceSubscription: SubscriptionRecord | null;
    readonly purchaseType: 'RENEW' | 'UPGRADE';
    readonly userId?: string;
    readonly channel?: PurchaseChannel;
  }): Promise<{
    readonly plans: readonly PlanRecord[];
    readonly warnings: readonly SubscriptionQuoteWarningInterface[];
  }> {
    if (input.sourceSubscription === null) {
      return { plans: [], warnings: [SOURCE_SUBSCRIPTION_REQUIRED] };
    }
    // Trial activation limits apply to both free and paid trials. Renewal
    // mutates the existing row and therefore would not increment the
    // `isTrial` subscription count used by `maxClaims`; allowing it would make
    // a maxClaims=1 paid trial renewable forever. A trial is always upgraded
    // to a regular plan instead. Use the immutable subscription marker rather
    // than the current plan availability so changing a plan later cannot
    // reopen this bypass.
    if (input.purchaseType === PurchaseType.RENEW && input.sourceSubscription.isTrial) {
      return { plans: [], warnings: [TRIAL_NOT_RENEWABLE] };
    }
    if (
      input.purchaseType === PurchaseType.RENEW &&
      input.sourceSubscription.status === SubscriptionStatus.DISABLED
    ) {
      return { plans: [], warnings: [SUBSCRIPTION_DISABLED_NOT_RENEWABLE] };
    }
    const sourcePlanId = readSnapshotPlanId(input.sourceSubscription.planSnapshot);
    if (sourcePlanId === null) {
      // A panel-imported subscription carries no rezeis plan snapshot. For
      // RENEW we don't dead-end: offer the active (non-trial) catalog so the
      // user can pick a tariff to renew onto. UPGRADE keeps the old behaviour.
      if (input.purchaseType === 'RENEW' && input.userId !== undefined) {
        const catalog = await this.getCatalogOptionPlans({
          userId: input.userId,
          channel: input.channel ?? PurchaseChannel.WEB,
        });
        const targets = catalog.filter((plan) => plan.availability !== PlanAvailability.TRIAL);
        if (targets.length > 0) {
          // No persistent warning here: `getQuote` adds PLAN_SELECTION_REQUIRED
          // on its own while no plan is chosen, and drops it once one is — so a
          // priced plan-less renewal stays eligible.
          return { plans: targets, warnings: [] };
        }
      }
      return { plans: [], warnings: [SOURCE_PLAN_MISSING] };
    }
    const sourcePlan = await this.prismaService.plan.findUnique({
      where: { id: sourcePlanId },
      include: PLAN_INCLUDE,
    });
    if (
      sourcePlan === null ||
      (input.purchaseType === PurchaseType.RENEW && isPlanSoftDeleted(sourcePlan))
    ) {
      // ── A PLAN THAT NO LONGER EXISTS IS NOT A DEAD END FOR A RENEWAL ──────
      //
      // The snapshot names a plan; the row is gone — or it is a SOFT-deleted
      // row, which for a renewal is the same thing. An operator deleted it
      // (`PlanDeletionService` keeps the row, hidden, while something still
      // uses it), or `RetiredPlanSweeperService` removed it once nothing did.
      //
      // The customer that describes is precisely the one this branch used to
      // turn away: somebody coming back to renew a plan that is gone. They were
      // offered NOTHING — not the replacements the plan names, not the
      // catalogue — while the same method four lines above already hands the
      // catalogue to a renewal whose snapshot has no plan id at all. The cases
      // are the same problem and get the same answer: the active catalogue, to
      // CHOOSE from. `SubscriptionRenewalService` reads the same state and asks
      // the subscriber to pick (`requiresPlanSelection`) instead of silently
      // renewing onto the first plan in the list — and a deleted plan's own
      // replacement list is deliberately not used: the plan is gone for
      // everyone, and the renewal is offered the active plans.
      //
      // UPGRADE is deliberately left alone. For a plan whose row is gone it has
      // nothing to reprice against; for a soft-deleted plan the row is still
      // there, so an upgrade from it keeps working exactly as it did while the
      // plan was merely archived — including the trial → catalogue fallback a
      // trial subscriber on a deleted trial plan depends on.
      if (input.purchaseType === 'RENEW' && input.userId !== undefined) {
        const catalog = await this.getCatalogOptionPlans({
          userId: input.userId,
          channel: input.channel ?? PurchaseChannel.WEB,
        });
        const targets = catalog.filter((plan) => plan.availability !== PlanAvailability.TRIAL);
        if (targets.length > 0) return { plans: targets, warnings: [ARCHIVED_PLAN_REPLACEMENT] };
      }
      return { plans: [], warnings: [SOURCE_PLAN_MISSING] };
    }
    if (input.purchaseType === PurchaseType.UPGRADE) {
      let targets = await this.getTransitionPlans(sourcePlan.upgradeToPlanIds);
      // Trial → regular fallback: a TRIAL plan with no explicitly configured
      // `upgradeToPlanIds` can still be upgraded to ANY active non-trial
      // catalog plan, so a trial user is never stuck without an upgrade path.
      // Applies to both free and paid trials. Operators who want to restrict
      // the targets simply set explicit `upgradeToPlanIds` on the trial plan.
      if (
        targets.length === 0 &&
        sourcePlan.availability === PlanAvailability.TRIAL &&
        input.userId !== undefined
      ) {
        const catalog = await this.getCatalogOptionPlans({
          userId: input.userId,
          channel: input.channel ?? PurchaseChannel.WEB,
        });
        targets = catalog.filter(
          (plan) => plan.availability !== PlanAvailability.TRIAL && plan.id !== sourcePlan.id,
        );
      }
      return {
        plans: targets,
        warnings: [UPGRADE_RESETS_EXPIRY],
      };
    }
    if (
      sourcePlan.availability === PlanAvailability.TRIAL &&
      (!sourcePlan.isArchived ||
        sourcePlan.archivedRenewMode === ArchivedPlanRenewMode.SELF_RENEW)
    ) {
      return { plans: [], warnings: [TRIAL_PLAN_NOT_RENEWAL_TARGET] };
    }
    if (!sourcePlan.isArchived) {
      return { plans: [sourcePlan], warnings: [] };
    }
    if (sourcePlan.archivedRenewMode === ArchivedPlanRenewMode.SELF_RENEW) {
      return { plans: [sourcePlan], warnings: [] };
    }
    const replacements = await this.getTransitionPlans(sourcePlan.replacementPlanIds);
    if (
      replacements.length === 0 &&
      input.purchaseType === PurchaseType.RENEW &&
      input.userId !== undefined
    ) {
      // ── NO REPLACEMENT LEFT ON SALE IS THE SAME DEAD END AS NO PLAN ───────
      //
      // The plan editor refuses an archived REPLACE_ON_RENEW plan without
      // replacements (TRANSITION_REPLACEMENT_REQUIRED), so an empty list here
      // means every replacement has since been deleted — `PlanDeletionService`
      // strips a deleted plan from these lists — or taken off sale. Offering
      // nothing turned the subscriber away with no way to renew at all. Offer
      // the active catalogue to CHOOSE from, as for a deleted plan above;
      // `SubscriptionRenewalService` asks for the choice (`renewalPlanIsGone`).
      const catalog = await this.getCatalogOptionPlans({
        userId: input.userId,
        channel: input.channel ?? PurchaseChannel.WEB,
      });
      const targets = catalog.filter((plan) => plan.availability !== PlanAvailability.TRIAL);
      if (targets.length > 0) return { plans: targets, warnings: [ARCHIVED_PLAN_REPLACEMENT] };
    }
    return {
      plans: replacements,
      warnings: [ARCHIVED_PLAN_REPLACEMENT],
    };
  }

  private async getCatalogOptionPlans(input: {
    readonly userId: string;
    readonly channel: PurchaseChannel;
  }): Promise<readonly PlanRecord[]> {
    const catalogPlans = await this.planCatalogService.getCatalogPlans(input);
    if (catalogPlans.length === 0) {
      return [];
    }
    return this.prismaService.plan.findMany({
      where: {
        id: { in: catalogPlans.map((plan) => plan.id) },
      },
      include: PLAN_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private async getTransitionPlans(planIds: readonly string[]): Promise<readonly PlanRecord[]> {
    if (planIds.length === 0) {
      return [];
    }
    const plans = await this.prismaService.plan.findMany({
      where: {
        id: { in: [...planIds] },
        ...TRANSITION_TARGET_WHERE,
      },
      include: PLAN_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
    return plans.filter((plan) => plan.availability !== PlanAvailability.TRIAL);
  }

  private async calculateQuotePrice(input: {
    readonly plan: PlanRecord;
    readonly duration: PlanRecord['durations'][number];
    readonly user: UserRecord;
    readonly channel: PurchaseChannel;
    readonly preferredGatewayType?: PaymentGatewayType;
    readonly currencyOverride?: Currency;
  }): Promise<SubscriptionQuotePriceInterface | null> {
    // Partner-balance flow: price directly in the requested currency using the
    // plan's price row for it, with no gateway involved. The `gatewayType` on
    // the returned price is the synthetic PARTNER_BALANCE method.
    if (input.currencyOverride !== undefined) {
      const price = input.duration.prices.find(
        (candidate) => candidate.currency === input.currencyOverride,
      );
      if (price === undefined) {
        return null;
      }
      const snapshot = this.pricingService.buildSnapshot({
        amount: price.price.toString(),
        currency: price.currency as Currency,
        // The discount for THIS plan, chosen by the SAME function the catalog
        // quoted with. Reading `user.purchaseDiscount` alone charged whatever
        // the most recent grant happened to be, ignoring the plans it was
        // restricted to — so a six-month-only discount came off a one-month
        // order, and the amount charged differed from the price displayed.
        purchaseDiscount: pickBestDiscount({
          grants: input.user.pendingDiscounts,
          planId: input.plan.id,
          legacyPercent: input.user.purchaseDiscount,
          now: new Date(),
        }).percent,
        personalDiscount: input.user.personalDiscount,
      });
      return {
        gatewayType: PaymentGatewayType.PARTNER_BALANCE,
        currency: price.currency,
        originalPrice: snapshot.originalPrice,
        price: snapshot.price,
        discountPercent: snapshot.discountPercent,
        discountSource: snapshot.discountSource,
      };
    }
    let gateways = (
      await this.prismaService.paymentGateway.findMany({
        where: { isActive: true },
        orderBy: [{ orderIndex: 'asc' }, { type: 'asc' }],
      })
    ).filter((gateway) => isGatewayAvailableForChannel(gateway.type, input.channel));
    if (input.preferredGatewayType !== undefined) {
      gateways = gateways.filter((gateway) => gateway.type === input.preferredGatewayType);
    }
    for (const gateway of gateways) {
      const price = input.duration.prices.find(
        (candidate) => candidate.currency === gateway.currency,
      );
      if (price === undefined) {
        continue;
      }
      const snapshot = this.pricingService.buildSnapshot({
        amount: price.price.toString(),
        currency: price.currency as Currency,
        // The discount for THIS plan, chosen by the SAME function the catalog
        // quoted with. Reading `user.purchaseDiscount` alone charged whatever
        // the most recent grant happened to be, ignoring the plans it was
        // restricted to — so a six-month-only discount came off a one-month
        // order, and the amount charged differed from the price displayed.
        purchaseDiscount: pickBestDiscount({
          grants: input.user.pendingDiscounts,
          planId: input.plan.id,
          legacyPercent: input.user.purchaseDiscount,
          now: new Date(),
        }).percent,
        personalDiscount: input.user.personalDiscount,
      });
      return {
        gatewayType: gateway.type,
        currency: price.currency,
        originalPrice: snapshot.originalPrice,
        price: snapshot.price,
        discountPercent: snapshot.discountPercent,
        discountSource: snapshot.discountSource,
      };
    }
    return null;
  }
}

function mapQuotePlan(plan: PlanRecord): SubscriptionQuotePlanInterface {
  return {
    id: plan.id,
    name: plan.name,
    availability: plan.availability,
    description: plan.description,
    tag: plan.tag,
    type: plan.type,
    icon: plan.icon,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
    trialSettings: readTrialSettings(plan.trialSettings),
    durations: plan.durations.map(mapQuoteDuration),
  };
}

function mapQuoteDuration(
  duration: PlanRecord['durations'][number],
): SubscriptionQuoteDurationInterface {
  return {
    id: duration.id,
    days: duration.days,
  };
}

function readSnapshotPlanId(snapshot: Prisma.JsonValue): string | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return null;
  }
  const planId = snapshot.id;
  return typeof planId === 'string' ? planId : null;
}

function dedupeWarnings(
  warnings: readonly SubscriptionQuoteWarningInterface[],
): readonly SubscriptionQuoteWarningInterface[] {
  const seenCodes = new Set<string>();
  const uniqueWarnings: SubscriptionQuoteWarningInterface[] = [];
  for (const warning of warnings) {
    if (seenCodes.has(warning.code)) {
      continue;
    }
    seenCodes.add(warning.code);
    uniqueWarnings.push(warning);
  }
  return uniqueWarnings;
}

/** Reads a JSON column value into a plain object (defensive, null-safe). */
function readJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * What an UPGRADE onto `plan` writes into the two limit columns — the SAME
 * rule fulfilment writes with (`resolvePlanChangeLimitCarry`), from the same
 * three inputs: the columns, the stored snapshot and the recorded add-on share.
 * Fulfilment carries it on BOTH paths since the durable one writes the carry
 * before its recompute, so the quote no longer answers differently under a
 * durable term.
 */
function resolveUpgradeLimitCarry(source: SubscriptionRecord, plan: PlanRecord): PlanChangeLimitCarry {
  return resolvePlanChangeLimitCarry({
    current: { trafficLimit: source.trafficLimit, deviceLimit: source.deviceLimit },
    planSnapshot: source.planSnapshot,
    plan: { trafficLimit: plan.trafficLimit, deviceLimit: plan.deviceLimit },
    recorded: recordedAddOnContributionOf(source.effectiveProjection),
  });
}

/**
 * What an UPGRADE keeps above the OLD PLAN, told before the customer pays:
 * an operator's raise, a bonus, an add-on bought before the durable model
 * (grandfathered into the term's base). `null` when nothing carries.
 *
 * WITHOUT THE LIVE DURABLE ADD-ONS. The carry adds their recorded share back
 * onto the columns (they mirror `desired`), but those add-ons keep their own
 * end dates and are listed on their own (`activeAddOns`); counted here too,
 * the review would name every one of them twice. The share is taken off
 * exactly as `withRecordedTraffic` / `withRecordedDevices` put it on.
 *
 * It is data BESIDE the warnings rather than an informational warning code:
 * the cabinet's BFF flattens an unpriced quote to its FIRST warning code, and a
 * code no client knows yet would read there as the reason the upgrade cannot
 * be bought. Beside them it cannot reach `isEligible` at all.
 */
function describeCarriedAbovePlan(
  source: SubscriptionRecord,
  carry: PlanChangeLimitCarry,
): SubscriptionQuoteCarriedLimitsInterface | null {
  const recorded = recordedAddOnContributionOf(source.effectiveProjection);
  const recordedGb = withRecordedTraffic(0, recorded.activeTrafficContributionBytes) ?? 0;
  const recordedDevices = withRecordedDevices(1, recorded.activeDeviceContribution) - 1;
  const { carried } = carry;
  const trafficLimitGb = carried.trafficLimitGb > 0 ? Math.max(0, carried.trafficLimitGb - recordedGb) : 0;
  const deviceLimit = carried.deviceLimit > 0 ? Math.max(0, carried.deviceLimit - recordedDevices) : 0;
  const carriesAnything =
    deviceLimit > 0 || trafficLimitGb > 0 || carried.unlimitedDevices || carried.unlimitedTraffic;
  return carriesAnything
    ? {
        deviceLimit,
        trafficLimitGb,
        unlimitedDevices: carried.unlimitedDevices,
        unlimitedTraffic: carried.unlimitedTraffic,
      }
    : null;
}

/** `from` plus whole days, on the UTC calendar — as fulfilment's `calculateExpiry` counts them. */
function addUtcDays(from: Date, days: number): Date {
  const at = new Date(from);
  at.setUTCDate(at.getUTCDate() + days);
  return at;
}
