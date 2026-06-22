import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Currency,
  PaymentGateway,
  PlanAvailability,
  PurchaseChannel,
  SubscriptionStatus,
  User,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  PlanCatalogPlanInterface,
  PlanCatalogPriceInterface,
  PlanCatalogQueryContextInterface,
} from '../interfaces/plan-catalog.interface';
import { isGatewayAvailableForChannel } from '../utils/purchase-gateway-policy.util';
import { PLAN_INCLUDE, PlanRecord } from '../utils/plan-record.util';
import { getSupportedPaymentAssets } from '../utils/supported-payment-assets.util';
import { readTrialSettings } from '../utils/trial-settings.util';
import { PricingService } from './pricing.service';

interface CatalogUserContext {
  readonly user: Pick<User, 'id' | 'purchaseDiscount' | 'personalDiscount'>;
  readonly hasAnySubscription: boolean;
  readonly isInvitedUser: boolean;
  /** Trials the user has already claimed (free or paid), counted by their
   *  `isTrial` subscriptions including deleted ones. */
  readonly trialClaims: number;
}

@Injectable()
export class PlanCatalogService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly pricingService: PricingService,
  ) {}

  public async getCatalogPlans(
    query: PlanCatalogQueryContextInterface,
  ): Promise<readonly PlanCatalogPlanInterface[]> {
    const channel = query.channel;
    const userContext =
      query.userId === undefined ? null : await this.getCatalogUserContext(query.userId);
    const gateways = (await this.prismaService.paymentGateway.findMany({
      where: {
        isActive: true,
      },
      orderBy: [{ orderIndex: 'asc' }, { type: 'asc' }],
    })).filter((gateway) => isGatewayAvailableForChannel(gateway.type, channel));
    const candidatePlans = await this.prismaService.plan.findMany({
      where:
        userContext === null
          ? {
              isActive: true,
              isArchived: false,
              availability: PlanAvailability.ALL,
            }
          : {
              isActive: true,
              isArchived: false,
            },
      include: PLAN_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
    return candidatePlans
      .filter((plan) => this.isPlanAvailableForContext({ plan, userContext }))
      .map((plan) => this.mapCatalogPlan({ plan, gateways, userContext, channel }));
  }

  private async getCatalogUserContext(userId: string): Promise<CatalogUserContext> {
    const user = await this.prismaService.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        purchaseDiscount: true,
        personalDiscount: true,
      },
    });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
    const [subscription, referral] = await Promise.all([
      this.prismaService.subscription.findFirst({
        where: {
          userId,
          status: {
            not: SubscriptionStatus.DELETED,
          },
        },
        select: {
          id: true,
        },
      }),
      this.prismaService.referral.findFirst({
        where: {
          referredId: userId,
        },
        select: {
          id: true,
        },
      }),
    ]);
    const [partnerReferral, trialClaims] = await Promise.all([
      // Partner-invited users count as "invited" for trial scoping too;
      // the partner program keeps its own edge table separate from referrals.
      referral === null
        ? this.prismaService.partnerReferral.findFirst({
            where: { referralUserId: userId },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.prismaService.subscription.count({
        where: { userId, isTrial: true },
      }),
    ]);
    return {
      user,
      hasAnySubscription: subscription !== null,
      isInvitedUser: referral !== null || partnerReferral !== null,
      trialClaims,
    };
  }

  private isPlanAvailableForContext(input: {
    readonly plan: PlanRecord;
    readonly userContext: CatalogUserContext | null;
  }): boolean {
    const { plan, userContext } = input;
    if (userContext === null) {
      return plan.availability === PlanAvailability.ALL;
    }
    switch (plan.availability) {
      case PlanAvailability.ALL:
        return true;
      case PlanAvailability.NEW:
        return !userContext.hasAnySubscription;
      case PlanAvailability.EXISTING:
        return userContext.hasAnySubscription;
      case PlanAvailability.INVITED:
        return userContext.isInvitedUser;
      case PlanAvailability.ALLOWED:
        return plan.allowedUserIds.includes(userContext.user.id);
      case PlanAvailability.TRIAL: {
        const trial = readTrialSettings(plan.trialSettings);
        // INVITED-scoped trials require a referral/partner invite edge.
        if (trial.availabilityScope === 'INVITED' && !userContext.isInvitedUser) {
          return false;
        }
        // The user must not have exhausted the per-plan claim limit.
        if (userContext.trialClaims >= trial.maxClaims) {
          return false;
        }
        // Free trials are a no-subscription "first taste". Paid trials are
        // purchasable like any plan, so they remain catalog-available even
        // for users who already hold a subscription (subject to the claim
        // limit checked above).
        return trial.free ? !userContext.hasAnySubscription : true;
      }
      default:
        return false;
    }
  }

  private mapCatalogPlan(input: {
    readonly plan: PlanRecord;
    readonly gateways: readonly PaymentGateway[];
    readonly userContext: CatalogUserContext | null;
    readonly channel: PurchaseChannel;
  }): PlanCatalogPlanInterface {
    const { plan, gateways, userContext } = input;
    // A free trial is claimed (not bought), so it must carry NO price in the
    // catalog — otherwise a plan flipped from paid→free trial keeps its stale
    // duration prices and surfaces as a phantom priced slot in the cabinet.
    const isFreeTrial =
      plan.availability === PlanAvailability.TRIAL && readTrialSettings(plan.trialSettings).free;
    return {
      id: plan.id,
      orderIndex: plan.orderIndex,
      name: plan.name,
      description: plan.description,
      tag: plan.tag,
      icon: plan.icon,
      type: plan.type,
      availability: plan.availability,
      trafficLimit: plan.trafficLimit,
      deviceLimit: plan.deviceLimit,
      trafficLimitStrategy: plan.trafficLimitStrategy,
      internalSquads: [...plan.internalSquads],
      externalSquad: plan.externalSquad,
      isTrial: plan.availability === PlanAvailability.TRIAL,
      trialFree: readTrialSettings(plan.trialSettings).free,
      durations: plan.durations.map((duration) => ({
        id: duration.id,
        days: duration.days,
        prices: isFreeTrial
          ? []
          : gateways
              .map((gateway) =>
                this.mapCatalogPrice({
                  gateway,
                  durationPrices: duration.prices,
                  userContext,
                }),
              )
              .filter((value): value is PlanCatalogPriceInterface => value !== null),
      })),
    };
  }

  private mapCatalogPrice(input: {
    readonly gateway: PaymentGateway;
    readonly durationPrices: PlanRecord['durations'][number]['prices'];
    readonly userContext: CatalogUserContext | null;
  }): PlanCatalogPriceInterface | null {
    const matchingPrice = input.durationPrices.find(
      (price) => price.currency === input.gateway.currency,
    );
    if (matchingPrice === undefined) {
      return null;
    }
    const pricingSnapshot = this.pricingService.buildSnapshot({
      amount: matchingPrice.price.toString(),
      currency: matchingPrice.currency as Currency,
      purchaseDiscount: input.userContext?.user.purchaseDiscount ?? 0,
      personalDiscount: input.userContext?.user.personalDiscount ?? 0,
    });
    return {
      gatewayType: input.gateway.type,
      currency: matchingPrice.currency,
      originalPrice: pricingSnapshot.originalPrice,
      price: pricingSnapshot.price,
      discountPercent: pricingSnapshot.discountPercent,
      discountSource: pricingSnapshot.discountSource,
      supportedPaymentAssets: getSupportedPaymentAssets(input.gateway.type),
    };
  }
}
