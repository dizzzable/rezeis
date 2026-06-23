import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ArchivedPlanRenewMode,
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Subscription,
  SubscriptionStatus,
  User,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanCatalogService } from '../../plans/services/plan-catalog.service';
import { PricingService } from '../../plans/services/pricing.service';
import { isGatewayAvailableForChannel } from '../../plans/utils/purchase-gateway-policy.util';
import { PLAN_INCLUDE, PlanRecord } from '../../plans/utils/plan-record.util';
import { evaluateTrialClaim, readTrialSettings } from '../../plans/utils/trial-settings.util';
import { isInvitedUser } from '../../plans/utils/trial-invite.util';
import { SubscriptionActionPolicyDto } from '../dto/subscription-action-policy.dto';
import { SubscriptionQuoteAction, SubscriptionQuoteDto } from '../dto/subscription-quote.dto';
import {
  SubscriptionActionPolicyInterface,
  SubscriptionQuoteDurationInterface,
  SubscriptionQuoteInterface,
  SubscriptionQuotePlanInterface,
  SubscriptionQuotePriceInterface,
  SubscriptionQuoteWarningInterface,
} from '../interfaces/subscription-quote.interface';

type UserRecord = Pick<User, 'id' | 'maxSubscriptions' | 'purchaseDiscount' | 'personalDiscount'>;
type SubscriptionRecord = Pick<
  Subscription,
  'id' | 'userId' | 'status' | 'isTrial' | 'planSnapshot' | 'createdAt'
>;

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
  message: 'An existing trial subscription must be upgraded instead of creating a new subscription.',
};
const TRIAL_ALREADY_USED: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_ALREADY_USED',
  message: 'The user has already used a trial subscription.',
};
const TRIAL_FREE_NOT_RENEWABLE: SubscriptionQuoteWarningInterface = {
  code: 'TRIAL_FREE_NOT_RENEWABLE',
  message: 'A free trial cannot be renewed — upgrade to a paid plan instead.',
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

@Injectable()
export class SubscriptionQuoteService {
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
    });
    const upgradeSelection = await this.getSourceSelection({
      sourceSubscription: context.sourceSubscription,
      purchaseType: PurchaseType.UPGRADE,
    });
    const trialPlans = basePlans.filter((plan) => plan.availability === 'TRIAL');
    // Only FREE trials are claimable via the dedicated trial action; paid
    // trials are purchased through the NEW flow like any other plan.
    const freeTrialPlans = trialPlans.filter((plan) => readTrialSettings(plan.trialSettings).free);
    const capacityAvailable = context.activeSubscriptionCount < context.effectiveMaxSubscriptions;
    const hasActiveTrial = context.activeSubscriptions.some((subscription) => subscription.isTrial);
    const warnings = [
      ...sourceSelection.warnings,
      ...upgradeSelection.warnings,
      ...(hasActiveTrial ? [TRIAL_UPGRADE_REQUIRED] : []),
      ...(context.hasUsedTrial ? [TRIAL_ALREADY_USED] : []),
      ...(!capacityAvailable ? [SUBSCRIPTION_LIMIT_REACHED] : []),
    ];
    return {
      userId,
      channel,
      actions: {
        NEW: capacityAvailable && !hasActiveTrial,
        ADDITIONAL: capacityAvailable,
        RENEW: sourceSelection.plans.length > 0,
        UPGRADE: upgradeSelection.plans.length > 0,
        TRIAL:
          capacityAvailable &&
          !context.hasUsedTrial &&
          context.activeSubscriptionCount === 0 &&
          freeTrialPlans.length > 0,
      },
      activeSubscriptionCount: context.activeSubscriptionCount,
      maxSubscriptions: context.effectiveMaxSubscriptions,
      currentSubscriptionId: context.sourceSubscription?.id ?? null,
      availablePlans: basePlans.map(mapQuotePlan),
      warnings: dedupeWarnings(warnings),
    };
  }

  public async getQuote(input: SubscriptionQuoteDto): Promise<SubscriptionQuoteInterface> {
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
    });
    const selectedPlan =
      input.planId === undefined ? null : plans.find((plan) => plan.id === input.planId) ?? null;
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
        : selectedPlan.durations.find((duration) => duration.days === input.durationDays) ?? null;
    if (selectedPlan !== null && input.durationDays === undefined) {
      quoteWarnings.push(DURATION_SELECTION_REQUIRED);
    } else if (selectedPlan !== null && input.durationDays !== undefined && selectedDuration === null) {
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
    if (selectedPlan !== null && selectedDuration !== null && input.gatewayType !== undefined && price === null) {
      quoteWarnings.push(GATEWAY_NOT_AVAILABLE);
    }
    return {
      userId,
      purchaseType: input.purchaseType,
      channel,
      isEligible: selectedPlan !== null && selectedDuration !== null && price !== null && quoteWarnings.length === 0,
      selectedSubscriptionId: context.sourceSubscription?.id ?? null,
      selectedPlan: selectedPlan === null ? null : mapQuotePlan(selectedPlan),
      selectedDuration:
        selectedDuration === null ? null : mapQuoteDuration(selectedDuration),
      availablePlans: plans.map(mapQuotePlan),
      price,
      warnings: dedupeWarnings(quoteWarnings),
    };
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
    readonly hasUsedTrial: boolean;
    readonly sourceSubscription: SubscriptionRecord | null;
  }> {
    const user = await this.prismaService.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        maxSubscriptions: true,
        purchaseDiscount: true,
        personalDiscount: true,
      },
    });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
    const effectiveMaxSubscriptions = await this.resolveEffectiveMaxSubscriptions(
      user.maxSubscriptions,
    );
    const [subscriptions, trialGrant] = await Promise.all([
      this.prismaService.subscription.findMany({
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
        },
      }),
      this.prismaService.trialGrant.findUnique({
        where: { userId: input.userId },
        select: { id: true },
      }),
    ]);
    const sourceSubscription = input.subscriptionId
      ? subscriptions.find((subscription) => subscription.id === input.subscriptionId)
      : subscriptions[0] ?? null;
    if (input.subscriptionId !== undefined && sourceSubscription === undefined) {
      throw new NotFoundException('Subscription not found');
    }
    return {
      user,
      activeSubscriptions: subscriptions,
      activeSubscriptionCount: subscriptions.length,
      effectiveMaxSubscriptions,
      hasUsedTrial: trialGrant !== null,
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
  }): Promise<{ readonly plans: readonly PlanRecord[]; readonly warnings: readonly SubscriptionQuoteWarningInterface[] }> {
    if (input.purchaseType === PurchaseType.NEW || input.purchaseType === PurchaseType.ADDITIONAL || input.purchaseType === 'TRIAL') {
      const plans = await this.getCatalogOptionPlans({ userId: input.userId, channel: input.channel });
      if (input.purchaseType === 'TRIAL') {
        // FREE-grant trial claim flow. Paid trials are NOT offered here —
        // they go through the NEW purchase pipeline below.
        if (await this.hasUsedTrial(input.userId)) {
          return { plans: [], warnings: [TRIAL_ALREADY_USED] };
        }
        return {
          plans: plans.filter(
            (plan) => plan.availability === 'TRIAL' && readTrialSettings(plan.trialSettings).free,
          ),
          warnings: [],
        };
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
      const claimable = await this.filterClaimablePaidTrials({
        userId: input.userId,
        plans: paidTrialPlans,
      });
      return {
        plans: [...nonTrialPlans, ...claimable.plans],
        warnings: claimable.warnings,
      };
    }
    return this.getSourceSelection({
      sourceSubscription: input.sourceSubscription,
      purchaseType: input.purchaseType,
    });
  }

  /**
   * Applies the per-plan trial abuse guards (`maxClaims`,
   * `availabilityScope`) to a set of paid trial plans, returning only the
   * ones the user may still purchase plus a warning describing why any
   * were dropped. The claim count is the user's `isTrial` subscription
   * count (including deleted ones — a consumed trial always counts), which
   * the paid-completion path stamps just like the free grant.
   */
  private async filterClaimablePaidTrials(input: {
    readonly userId: string;
    readonly plans: readonly PlanRecord[];
  }): Promise<{ readonly plans: readonly PlanRecord[]; readonly warnings: readonly SubscriptionQuoteWarningInterface[] }> {
    const needsInviteCheck = input.plans.some(
      (plan) => readTrialSettings(plan.trialSettings).availabilityScope === 'INVITED',
    );
    const [priorTrialClaims, invited] = await Promise.all([
      this.prismaService.subscription.count({
        where: { userId: input.userId, isTrial: true },
      }),
      needsInviteCheck ? isInvitedUser(this.prismaService, input.userId) : Promise.resolve(true),
    ]);
    const claimable: PlanRecord[] = [];
    const warnings: SubscriptionQuoteWarningInterface[] = [];
    for (const plan of input.plans) {
      const claim = evaluateTrialClaim(readTrialSettings(plan.trialSettings), {
        priorTrialClaims,
        isInvited: invited,
      });
      if (claim.allowed) {
        claimable.push(plan);
      } else if (claim.reason === 'TRIAL_ALREADY_USED') {
        warnings.push(TRIAL_ALREADY_USED);
      } else if (claim.reason === 'TRIAL_INVITED_ONLY') {
        warnings.push(TRIAL_INVITED_ONLY);
      }
    }
    return { plans: claimable, warnings };
  }

  private async hasUsedTrial(userId: string): Promise<boolean> {
    const trialGrant = await this.prismaService.trialGrant.findUnique({
      where: { userId },
      select: { id: true },
    });
    return trialGrant !== null;
  }

  private async getSourceSelection(input: {
    readonly sourceSubscription: SubscriptionRecord | null;
    readonly purchaseType: 'RENEW' | 'UPGRADE';
  }): Promise<{ readonly plans: readonly PlanRecord[]; readonly warnings: readonly SubscriptionQuoteWarningInterface[] }> {
    if (input.sourceSubscription === null) {
      return { plans: [], warnings: [SOURCE_SUBSCRIPTION_REQUIRED] };
    }
    const sourcePlanId = readSnapshotPlanId(input.sourceSubscription.planSnapshot);
    if (sourcePlanId === null) {
      return { plans: [], warnings: [SOURCE_PLAN_MISSING] };
    }
    const sourcePlan = await this.prismaService.plan.findUnique({
      where: { id: sourcePlanId },
      include: PLAN_INCLUDE,
    });
    if (sourcePlan === null) {
      return { plans: [], warnings: [SOURCE_PLAN_MISSING] };
    }
    if (input.purchaseType === PurchaseType.UPGRADE) {
      return {
        plans: await this.getTransitionPlans(sourcePlan.upgradeToPlanIds),
        warnings: [UPGRADE_RESETS_EXPIRY],
      };
    }
    // A free trial is a one-time grant — it cannot be renewed. The user must
    // upgrade to a paid plan instead (UPGRADE stays available when the trial
    // has `upgradeToPlanIds` configured). Paid trials remain renewable.
    if (
      sourcePlan.availability === PlanAvailability.TRIAL &&
      readTrialSettings(sourcePlan.trialSettings).free
    ) {
      return { plans: [], warnings: [TRIAL_FREE_NOT_RENEWABLE] };
    }
    if (!sourcePlan.isArchived) {
      return { plans: [sourcePlan], warnings: [] };
    }
    if (sourcePlan.archivedRenewMode === ArchivedPlanRenewMode.SELF_RENEW) {
      return { plans: [sourcePlan], warnings: [] };
    }
    return {
      plans: await this.getTransitionPlans(sourcePlan.replacementPlanIds),
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
    return this.prismaService.plan.findMany({
      where: {
        id: { in: [...planIds] },
        isActive: true,
        isArchived: false,
      },
      include: PLAN_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
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
        purchaseDiscount: input.user.purchaseDiscount,
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
    let gateways = (await this.prismaService.paymentGateway.findMany({
      where: { isActive: true },
      orderBy: [{ orderIndex: 'asc' }, { type: 'asc' }],
    })).filter((gateway) => isGatewayAvailableForChannel(gateway.type, input.channel));
    if (input.preferredGatewayType !== undefined) {
      gateways = gateways.filter((gateway) => gateway.type === input.preferredGatewayType);
    }
    for (const gateway of gateways) {
      const price = input.duration.prices.find((candidate) => candidate.currency === gateway.currency);
      if (price === undefined) {
        continue;
      }
      const snapshot = this.pricingService.buildSnapshot({
        amount: price.price.toString(),
        currency: price.currency as Currency,
        purchaseDiscount: input.user.purchaseDiscount,
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
    tag: plan.tag,
    type: plan.type,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    durations: plan.durations.map(mapQuoteDuration),
  };
}

function mapQuoteDuration(duration: PlanRecord['durations'][number]): SubscriptionQuoteDurationInterface {
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

function dedupeWarnings(warnings: readonly SubscriptionQuoteWarningInterface[]): readonly SubscriptionQuoteWarningInterface[] {
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
