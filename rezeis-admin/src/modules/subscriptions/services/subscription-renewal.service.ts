import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolveAddOnRolloutFlags } from '../../add-on-entitlements/add-on-rollout.config';
import { AddOnEligibilityService } from '../../add-ons/services/add-on-eligibility.service';
import {
  SubscriptionQuotePlanInterface,
  SubscriptionQuoteWarningInterface,
} from '../interfaces/subscription-quote.interface';
import {
  PricedRenewalAddOnLineInterface,
  PricedRenewalInterface,
  PricedRenewalItemInterface,
  RenewalItemInterface,
  RenewalOptionsInterface,
} from '../interfaces/subscription-renewal.interface';
import { SubscriptionQuoteService } from './subscription-quote.service';

interface RenewalIdentity {
  readonly userId?: string;
  readonly telegramId?: string;
}

/** Internal result of pricing a single subscription's renewal. */
interface SingleRenewalQuote {
  readonly subscriptionId: string;
  readonly planId: string | null;
  readonly planName: string | null;
  readonly durationDays: number | null;
  readonly availableDurations: readonly { readonly id: string; readonly days: number }[];
  readonly currency: Currency | null;
  readonly amount: string | null;
  readonly discountPercent: number;
  readonly renewable: boolean;
  readonly requiresPlanSelection: boolean;
  readonly warnings: readonly SubscriptionQuoteWarningInterface[];
}

const DURATION_ADJUSTED: SubscriptionQuoteWarningInterface = {
  code: 'DURATION_NOT_AVAILABLE',
  message: 'The originally purchased duration is no longer offered; the nearest available duration was used.',
};

const DURATION_INVALID: SubscriptionQuoteWarningInterface = {
  code: 'DURATION_INVALID',
  message: 'The requested duration is not offered by this plan; the original duration was used instead.',
};

/**
 * Builds renewal options and prices a renewal selection for a combined,
 * multi-subscription payment. Pricing delegates to {@link SubscriptionQuoteService}
 * so per-user discounts and promocode-driven discount fields are applied
 * identically to the single-item RENEW quote.
 */
@Injectable()
export class SubscriptionRenewalService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionQuoteService: SubscriptionQuoteService,
    private readonly addOnEligibilityService: AddOnEligibilityService,
  ) {}

  /**
   * Lists the user's renewable subscriptions, each priced against the given
   * (or default-resolved) gateway. Non-priceable subscriptions are returned
   * with `renewable: false` and their warnings rather than dropped.
   */
  public async getRenewalOptions(input: {
    readonly identity: RenewalIdentity;
    readonly subscriptionIds?: readonly string[];
    readonly gatewayType?: PaymentGatewayType;
    readonly channel?: PurchaseChannel;
    /** Optional per-subscription chosen renewal duration (days). */
    readonly durations?: ReadonlyMap<string, number>;
    /** Optional per-subscription chosen plan id (for plan-less subscriptions). */
    readonly plans?: ReadonlyMap<string, string>;
  }): Promise<RenewalOptionsInterface> {
    const userId = await this.resolveUserId(input.identity);
    const channel = input.channel ?? PurchaseChannel.WEB;
    const subscriptions = await this.loadCandidateSubscriptions(userId, input.subscriptionIds);

    const quotes: SingleRenewalQuote[] = [];
    for (const subscription of subscriptions) {
      quotes.push(
        await this.quoteSubscriptionRenewal({
          userId,
          subscriptionId: subscription.id,
          gatewayType: input.gatewayType,
          channel,
          chosenDurationDays: input.durations?.get(subscription.id) ?? null,
          chosenPlanId: input.plans?.get(subscription.id) ?? null,
        }),
      );
    }

    const items: RenewalItemInterface[] = quotes.map((quote) => ({
      subscriptionId: quote.subscriptionId,
      planId: quote.planId,
      planName: quote.planName,
      durationDays: quote.durationDays,
      availableDurations: quote.availableDurations,
      currency: quote.currency,
      amount: quote.amount,
      discountPercent: quote.discountPercent,
      renewable: quote.renewable,
      requiresPlanSelection: quote.requiresPlanSelection,
      warnings: quote.warnings,
    }));

    const priceable = quotes.filter(
      (q): q is SingleRenewalQuote & { amount: string; currency: Currency } =>
        q.amount !== null && q.currency !== null,
    );
    const currencies = new Set(priceable.map((q) => q.currency));
    const singleCurrency = currencies.size === 1 ? [...currencies][0] : null;
    const total =
      singleCurrency !== null
        ? priceable
            .reduce((sum, q) => sum.add(new Prisma.Decimal(q.amount)), new Prisma.Decimal(0))
            .toString()
        : null;

    return { userId, items, currency: singleCurrency, total };
  }

  /**
   * Prices a concrete renewal selection for checkout. Throws when the
   * selection is empty, contains a non-priceable item, or mixes currencies.
   */
  public async priceRenewalItems(input: {
    readonly identity: RenewalIdentity;
    readonly subscriptionIds: readonly string[];
    readonly gatewayType: PaymentGatewayType;
    readonly channel?: PurchaseChannel;
    /** Optional per-subscription chosen renewal duration (days). */
    readonly durations?: ReadonlyMap<string, number>;
    /** Optional per-subscription chosen plan id (for plan-less subscriptions). */
    readonly plans?: ReadonlyMap<string, string>;
    /** Optional per-subscription selected renewal add-on ids (T-007). Only
     *  honored when the `renewalAddOns` rollout flag is on. */
    readonly addOns?: ReadonlyMap<string, readonly string[]>;
  }): Promise<PricedRenewalInterface> {
    if (input.subscriptionIds.length === 0) {
      throw new BadRequestException('RENEWAL_NO_ITEMS');
    }
    const userId = await this.resolveUserId(input.identity);
    const channel = input.channel ?? PurchaseChannel.WEB;
    const uniqueIds = [...new Set(input.subscriptionIds)];
    const subscriptions = await this.loadCandidateSubscriptions(userId, uniqueIds);
    if (subscriptions.length !== uniqueIds.length) {
      throw new NotFoundException('RENEWAL_SUBSCRIPTION_NOT_FOUND');
    }

    const renewalAddOnsEnabled = resolveAddOnRolloutFlags().renewalAddOns;
    const items: PricedRenewalItemInterface[] = [];
    for (const subscription of subscriptions) {
      const quote = await this.quoteSubscriptionRenewal({
        userId,
        subscriptionId: subscription.id,
        gatewayType: input.gatewayType,
        channel,
        chosenDurationDays: input.durations?.get(subscription.id) ?? null,
        chosenPlanId: input.plans?.get(subscription.id) ?? null,
      });
      if (
        !quote.renewable ||
        quote.amount === null ||
        quote.currency === null ||
        quote.planId === null ||
        quote.durationDays === null
      ) {
        throw new BadRequestException('RENEWAL_ITEM_NOT_PRICEABLE');
      }
      const selectedAddOnIds = renewalAddOnsEnabled
        ? (input.addOns?.get(subscription.id) ?? [])
        : [];
      const addOnLines = await this.priceRenewalAddOnLines({
        subscriptionId: subscription.id,
        currency: quote.currency,
        selectedAddOnIds,
      });
      items.push({
        subscriptionId: quote.subscriptionId,
        planId: quote.planId,
        planName: quote.planName ?? '',
        durationDays: quote.durationDays,
        currency: quote.currency,
        amount: quote.amount,
        discountPercent: quote.discountPercent,
        planSnapshot: {
          id: quote.planId,
          name: quote.planName,
          selectedDurationDays: quote.durationDays,
          gatewayType: input.gatewayType,
          amount: quote.amount,
          currency: quote.currency,
          purchaseType: 'RENEW',
          snapshotSource: 'RENEWAL_DRAFT',
        },
        addOnLines,
      });
    }

    const currencies = new Set(items.map((item) => item.currency));
    if (currencies.size > 1) {
      throw new BadRequestException('MIXED_CURRENCY');
    }
    const currency = items[0]!.currency;
    // Total = every plan line + every priced add-on line across all lines.
    const total = items
      .reduce((sum, item) => {
        const withPlan = sum.add(new Prisma.Decimal(item.amount));
        return item.addOnLines.reduce(
          (acc, addOn) => acc.add(new Prisma.Decimal(addOn.unitAmount)),
          withPlan,
        );
      }, new Prisma.Decimal(0))
      .toString();

    return { userId, currency, total, items };
  }

  /**
   * Validates + prices the selected renewal add-ons for one subscription line
   * against its authoritative eligibility (contract v2, same-plan proxy). An
   * unknown/ineligible id, a duplicate pick, or a missing gateway-currency
   * price is a hard `BadRequestException` — checkout never silently drops or
   * mis-prices a paid add-on. Returns `[]` when nothing is selected.
   */
  private async priceRenewalAddOnLines(input: {
    readonly subscriptionId: string;
    readonly currency: Currency;
    readonly selectedAddOnIds: readonly string[];
  }): Promise<readonly PricedRenewalAddOnLineInterface[]> {
    if (input.selectedAddOnIds.length === 0) return [];
    const seen = new Set<string>();
    for (const id of input.selectedAddOnIds) {
      if (seen.has(id)) {
        throw new BadRequestException('ADDON_DUPLICATE_SELECTION');
      }
      seen.add(id);
    }

    const eligibility = await this.addOnEligibilityService.listForSubscription(input.subscriptionId);
    if (eligibility.availability !== 'AVAILABLE') {
      throw new BadRequestException('ADDON_NOT_ELIGIBLE');
    }
    const byId = new Map(eligibility.addOns.map((addOn) => [addOn.id, addOn]));

    const lines: PricedRenewalAddOnLineInterface[] = [];
    for (const addOnId of input.selectedAddOnIds) {
      const addOn = byId.get(addOnId);
      if (addOn === undefined) {
        throw new BadRequestException('ADDON_NOT_ELIGIBLE');
      }
      const price = addOn.prices.find((entry) => entry.currency === input.currency);
      if (price === undefined) {
        throw new BadRequestException('ADDON_PRICE_UNAVAILABLE');
      }
      lines.push({
        addOnId: addOn.id,
        catalogRevision: addOn.revision,
        type: addOn.type,
        value: addOn.value,
        lifetime: addOn.lifetime,
        // Renewal add-ons activate at the renewed term start regardless of the
        // discovery-time activation hint (which is computed for the CURRENT term).
        activation: 'TERM_START',
        sourceLineKey: `renew:${input.subscriptionId}:${addOn.id}`,
        unitAmount: price.price,
        receiptName: addOn.name,
      });
    }
    return lines;
  }

  /**
   * Prices a single subscription's renewal. Resolves the renewal target plan
   * (original, or replacement for an archived plan) and the renewal duration
   * (originally purchased, or nearest available) via two quote passes:
   * one to discover the available renewal plans, one to price the choice.
   */
  private async quoteSubscriptionRenewal(input: {
    readonly userId: string;
    readonly subscriptionId: string;
    readonly gatewayType?: PaymentGatewayType;
    readonly channel: PurchaseChannel;
    readonly chosenDurationDays?: number | null;
    readonly chosenPlanId?: string | null;
  }): Promise<SingleRenewalQuote> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.subscriptionId },
    });
    if (subscription === null) {
      throw new NotFoundException('RENEWAL_SUBSCRIPTION_NOT_FOUND');
    }
    const original = readSnapshotSelection(subscription.planSnapshot);

    const discovery = await this.subscriptionQuoteService.getQuote({
      userId: input.userId,
      purchaseType: 'RENEW',
      subscriptionId: input.subscriptionId,
      channel: input.channel,
      gatewayType: input.gatewayType,
    });

    // Plan-less (panel-imported) subscription: the catalog is offered as the
    // renewal target set. Until the user picks a plan we report the sub as
    // renewable-but-needs-a-plan (no price yet); once chosen we price it like
    // a normal renewal onto that plan.
    const planLess = original.planId === null;
    const chosenPlanId = input.chosenPlanId ?? null;
    if (planLess && chosenPlanId === null) {
      const canSelect = discovery.availablePlans.length > 0;
      return {
        subscriptionId: input.subscriptionId,
        planId: null,
        planName: null,
        durationDays: null,
        availableDurations: [],
        currency: null,
        amount: null,
        discountPercent: 0,
        renewable: canSelect,
        requiresPlanSelection: canSelect,
        warnings: discovery.warnings,
      };
    }

    const targetPlan = planLess
      ? (discovery.availablePlans.find((plan) => plan.id === chosenPlanId) ?? null)
      : pickTargetPlan(discovery.availablePlans, original.planId);
    if (targetPlan === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: null,
        planName: null,
        durationDays: null,
        availableDurations: [],
        currency: null,
        amount: null,
        discountPercent: 0,
        renewable: false,
        requiresPlanSelection: false,
        warnings: discovery.warnings,
      };
    }

    const availableDurations = targetPlan.durations.map((d) => ({ id: d.id, days: d.days }));
    const durationChoice = resolveDuration(
      targetPlan,
      original.durationDays,
      input.chosenDurationDays ?? null,
    );
    if (durationChoice === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: targetPlan.id,
        planName: targetPlan.name,
        durationDays: null,
        availableDurations,
        currency: null,
        amount: null,
        discountPercent: 0,
        renewable: false,
        requiresPlanSelection: false,
        warnings: discovery.warnings,
      };
    }

    const priced = await this.subscriptionQuoteService.getQuote({
      userId: input.userId,
      purchaseType: 'RENEW',
      subscriptionId: input.subscriptionId,
      channel: input.channel,
      gatewayType: input.gatewayType,
      planId: targetPlan.id,
      durationDays: durationChoice.days,
    });

    const adjustWarnings: SubscriptionQuoteWarningInterface[] = [];
    if (durationChoice.invalidChosen) adjustWarnings.push(DURATION_INVALID);
    else if (durationChoice.adjusted) adjustWarnings.push(DURATION_ADJUSTED);
    const warnings = mergeWarnings(discovery.warnings, adjustWarnings);

    if (!priced.isEligible || priced.price === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: targetPlan.id,
        planName: targetPlan.name,
        durationDays: durationChoice.days,
        availableDurations,
        currency: null,
        amount: null,
        discountPercent: 0,
        renewable: false,
        requiresPlanSelection: false,
        warnings: mergeWarnings(warnings, priced.warnings),
      };
    }

    return {
      subscriptionId: input.subscriptionId,
      planId: targetPlan.id,
      planName: targetPlan.name,
      durationDays: durationChoice.days,
      availableDurations,
      currency: priced.price.currency,
      amount: priced.price.price,
      discountPercent: priced.price.discountPercent,
      renewable: true,
      requiresPlanSelection: false,
      warnings,
    };
  }

  private async loadCandidateSubscriptions(
    userId: string,
    subscriptionIds?: readonly string[],
  ): Promise<readonly { id: string; planSnapshot: Prisma.JsonValue }[]> {
    return this.prismaService.subscription.findMany({
      where: {
        userId,
        status: { not: SubscriptionStatus.DELETED },
        ...(subscriptionIds !== undefined ? { id: { in: [...subscriptionIds] } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }],
      select: { id: true, planSnapshot: true },
    });
  }

  private async resolveUserId(identity: RenewalIdentity): Promise<string> {
    if (typeof identity.userId === 'string' && identity.userId.length > 0) {
      return identity.userId;
    }
    if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(identity.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }
      return user.id;
    }
    throw new NotFoundException('A userId or telegramId is required');
  }
}

function readSnapshotSelection(planSnapshot: Prisma.JsonValue): {
  readonly planId: string | null;
  readonly durationDays: number | null;
} {
  const snapshot =
    typeof planSnapshot === 'object' && planSnapshot !== null && !Array.isArray(planSnapshot)
      ? (planSnapshot as Record<string, unknown>)
      : {};
  const planId = typeof snapshot['id'] === 'string' ? (snapshot['id'] as string) : null;
  const durationDays =
    typeof snapshot['selectedDurationDays'] === 'number'
      ? (snapshot['selectedDurationDays'] as number)
      : null;
  return { planId, durationDays };
}

function pickTargetPlan(
  availablePlans: readonly SubscriptionQuotePlanInterface[],
  originalPlanId: string | null,
): SubscriptionQuotePlanInterface | null {
  if (availablePlans.length === 0) {
    return null;
  }
  if (originalPlanId !== null) {
    const exact = availablePlans.find((plan) => plan.id === originalPlanId);
    if (exact !== undefined) {
      return exact;
    }
  }
  return availablePlans[0] ?? null;
}

interface DurationChoice {
  readonly days: number;
  /** The originally purchased duration was unavailable; nearest was used. */
  readonly adjusted: boolean;
  /** A user-supplied duration was rejected; the original was used instead. */
  readonly invalidChosen: boolean;
}

/**
 * Resolves the renewal duration for a target plan.
 *
 * When the user explicitly chose a duration (`chosenDurationDays`), it is
 * honoured if the plan offers it; otherwise the choice is rejected
 * (`invalidChosen`) and resolution falls back to the originally purchased
 * duration logic. When no choice is supplied, the originally purchased
 * duration is matched exactly, or the nearest available one is used
 * (`adjusted`). Returns `null` only when the plan offers no durations.
 */
function resolveDuration(
  plan: SubscriptionQuotePlanInterface,
  originalDurationDays: number | null,
  chosenDurationDays: number | null,
): DurationChoice | null {
  if (plan.durations.length === 0) {
    return null;
  }

  if (chosenDurationDays !== null) {
    const chosen = plan.durations.find((duration) => duration.days === chosenDurationDays);
    if (chosen !== undefined) {
      return { days: chosen.days, adjusted: false, invalidChosen: false };
    }
    const fallback = resolveOriginalDuration(plan, originalDurationDays);
    return fallback === null ? null : { ...fallback, invalidChosen: true };
  }

  const resolved = resolveOriginalDuration(plan, originalDurationDays);
  return resolved === null ? null : { ...resolved, invalidChosen: false };
}

/** Matches the originally purchased duration exactly, or the nearest one. */
function resolveOriginalDuration(
  plan: SubscriptionQuotePlanInterface,
  originalDurationDays: number | null,
): { readonly days: number; readonly adjusted: boolean } | null {
  if (originalDurationDays !== null) {
    const exact = plan.durations.find((duration) => duration.days === originalDurationDays);
    if (exact !== undefined) {
      return { days: exact.days, adjusted: false };
    }
    // Nearest available duration by absolute day distance.
    const nearest = [...plan.durations].sort(
      (a, b) => Math.abs(a.days - originalDurationDays) - Math.abs(b.days - originalDurationDays),
    )[0];
    if (nearest !== undefined) {
      return { days: nearest.days, adjusted: true };
    }
  }
  const first = plan.durations[0];
  return first !== undefined ? { days: first.days, adjusted: originalDurationDays !== null } : null;
}

function mergeWarnings(
  ...groups: readonly (readonly SubscriptionQuoteWarningInterface[])[]
): readonly SubscriptionQuoteWarningInterface[] {
  const byCode = new Map<string, SubscriptionQuoteWarningInterface>();
  for (const group of groups) {
    for (const warning of group) {
      byCode.set(warning.code, warning);
    }
  }
  return [...byCode.values()];
}
