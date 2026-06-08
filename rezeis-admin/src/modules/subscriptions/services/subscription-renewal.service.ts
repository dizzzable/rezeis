import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  SubscriptionQuotePlanInterface,
  SubscriptionQuoteWarningInterface,
} from '../interfaces/subscription-quote.interface';
import {
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
  readonly currency: Currency | null;
  readonly amount: string | null;
  readonly discountPercent: number;
  readonly renewable: boolean;
  readonly warnings: readonly SubscriptionQuoteWarningInterface[];
}

const DURATION_ADJUSTED: SubscriptionQuoteWarningInterface = {
  code: 'DURATION_NOT_AVAILABLE',
  message: 'The originally purchased duration is no longer offered; the nearest available duration was used.',
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
        }),
      );
    }

    const items: RenewalItemInterface[] = quotes.map((quote) => ({
      subscriptionId: quote.subscriptionId,
      planId: quote.planId,
      planName: quote.planName,
      durationDays: quote.durationDays,
      currency: quote.currency,
      amount: quote.amount,
      discountPercent: quote.discountPercent,
      renewable: quote.renewable,
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

    const items: PricedRenewalItemInterface[] = [];
    for (const subscription of subscriptions) {
      const quote = await this.quoteSubscriptionRenewal({
        userId,
        subscriptionId: subscription.id,
        gatewayType: input.gatewayType,
        channel,
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
      });
    }

    const currencies = new Set(items.map((item) => item.currency));
    if (currencies.size > 1) {
      throw new BadRequestException('MIXED_CURRENCY');
    }
    const currency = items[0]!.currency;
    const total = items
      .reduce((sum, item) => sum.add(new Prisma.Decimal(item.amount)), new Prisma.Decimal(0))
      .toString();

    return { userId, currency, total, items };
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

    const targetPlan = pickTargetPlan(discovery.availablePlans, original.planId);
    if (targetPlan === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: null,
        planName: null,
        durationDays: null,
        currency: null,
        amount: null,
        discountPercent: 0,
        renewable: false,
        warnings: discovery.warnings,
      };
    }

    const durationChoice = pickDuration(targetPlan, original.durationDays);
    if (durationChoice === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: targetPlan.id,
        planName: targetPlan.name,
        durationDays: null,
        currency: null,
        amount: null,
        discountPercent: 0,
        renewable: false,
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

    const warnings = mergeWarnings(discovery.warnings, durationChoice.adjusted ? [DURATION_ADJUSTED] : []);

    if (!priced.isEligible || priced.price === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: targetPlan.id,
        planName: targetPlan.name,
        durationDays: durationChoice.days,
        currency: null,
        amount: null,
        discountPercent: 0,
        renewable: false,
        warnings: mergeWarnings(warnings, priced.warnings),
      };
    }

    return {
      subscriptionId: input.subscriptionId,
      planId: targetPlan.id,
      planName: targetPlan.name,
      durationDays: durationChoice.days,
      currency: priced.price.currency,
      amount: priced.price.price,
      discountPercent: priced.price.discountPercent,
      renewable: true,
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

function pickDuration(
  plan: SubscriptionQuotePlanInterface,
  originalDurationDays: number | null,
): { readonly days: number; readonly adjusted: boolean } | null {
  if (plan.durations.length === 0) {
    return null;
  }
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
