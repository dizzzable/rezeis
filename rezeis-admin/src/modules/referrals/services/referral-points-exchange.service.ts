import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { buildPlanSnapshot } from '../../users/utils/plan-snapshot.util';

/**
 * Points exchange types — what the user can trade their referral points for.
 * Donor: `PointsExchangeType` enum in altshop.
 */
export type PointsExchangeType = 'SUBSCRIPTION_DAYS' | 'GIFT_SUBSCRIPTION' | 'DISCOUNT' | 'TRAFFIC';

/**
 * Per-type exchange configuration from `Settings.referralSettings.points_exchange`.
 */
export interface ExchangeTypeConfig {
  enabled: boolean;
  pointsCost: number;
  minPoints: number;
  maxPoints: number; // -1 = unlimited
}

/**
 * Full points exchange configuration.
 */
export interface PointsExchangeConfig {
  exchangeEnabled: boolean;
  pointsPerDay: number;
  minExchangePoints: number;
  maxExchangePoints: number; // -1 = unlimited
  subscriptionDays: ExchangeTypeConfig & { /* no extra fields */ };
  giftSubscription: ExchangeTypeConfig & { giftPlanId: string | null; giftDurationDays: number };
  discount: ExchangeTypeConfig & { maxDiscountPercent: number };
  traffic: ExchangeTypeConfig & { maxTrafficGb: number };
}

/**
 * Exchange option returned to the user — shows what's available and computed values.
 */
export interface ExchangeOption {
  type: PointsExchangeType;
  enabled: boolean;
  available: boolean;
  pointsCost: number;
  minPoints: number;
  maxPoints: number;
  computedValue: number; // days / percent / GB depending on type
}

export interface ExchangeOptionsResponse {
  exchangeEnabled: boolean;
  pointsBalance: number;
  types: ExchangeOption[];
}

const DEFAULT_CONFIG: PointsExchangeConfig = {
  exchangeEnabled: false,
  pointsPerDay: 100,
  minExchangePoints: 100,
  maxExchangePoints: -1,
  subscriptionDays: { enabled: false, pointsCost: 100, minPoints: 100, maxPoints: -1 },
  giftSubscription: { enabled: false, pointsCost: 500, minPoints: 500, maxPoints: -1, giftPlanId: null, giftDurationDays: 30 },
  discount: { enabled: false, pointsCost: 200, minPoints: 200, maxPoints: -1, maxDiscountPercent: 50 },
  traffic: { enabled: false, pointsCost: 50, minPoints: 50, maxPoints: -1, maxTrafficGb: 100 },
};

/**
 * Handles the referral points exchange system.
 *
 * Donor: `referral_exchange.py`, `referral_exchange_execution.py`,
 *        `referral_exchange_options.py`, `referral_exchange_values.py`.
 *
 * Users accumulate `points` on their User record via referral rewards.
 * They can then exchange those points for:
 *   - SUBSCRIPTION_DAYS: extend current subscription by N days
 *   - GIFT_SUBSCRIPTION: generate a single-use promo code for a friend
 *   - DISCOUNT: get a personal discount percent on next purchase
 *   - TRAFFIC: add GB to current subscription traffic limit
 */
@Injectable()
export class ReferralPointsExchangeService {
  private readonly logger = new Logger(ReferralPointsExchangeService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
  ) {}

  /**
   * Creates a PENDING `ProfileSyncJob` (UPDATE / CREATE) for the given
   * subscription and enqueues it so the worker pushes the local limit /
   * expiry change to the Remnawave panel via `updatePanelUser`.
   */
  private async enqueueProfileSync(
    subscriptionId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true },
    });
    const job = await this.prismaService.profileSyncJob.create({
      data: {
        subscriptionId,
        action:
          subscription?.remnawaveId == null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: payload as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    await this.profileSyncQueueService.enqueue(job.id);
  }

  /**
   * Returns the available exchange options for a user, including their
   * current points balance and computed values for each type.
   */
  public async getExchangeOptions(userId: string): Promise<ExchangeOptionsResponse> {
    const [user, config] = await Promise.all([
      this.prismaService.user.findUnique({
        where: { id: userId },
        select: { points: true },
      }),
      this.loadConfig(),
    ]);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const balance = user.points;
    const types: ExchangeOption[] = [
      this.buildOption('SUBSCRIPTION_DAYS', config.subscriptionDays, balance, config),
      this.buildOption('GIFT_SUBSCRIPTION', config.giftSubscription, balance, config),
      this.buildOption('DISCOUNT', config.discount, balance, config),
      this.buildOption('TRAFFIC', config.traffic, balance, config),
    ];

    return {
      exchangeEnabled: config.exchangeEnabled,
      pointsBalance: balance,
      types,
    };
  }

  /**
   * Executes a points exchange for the given user.
   *
   * @param userId - The user performing the exchange
   * @param type - Which exchange type to execute
   * @param points - How many points to spend
   * @param subscriptionId - Target subscription (for SUBSCRIPTION_DAYS / TRAFFIC)
   */
  public async executeExchange(input: {
    readonly userId: string;
    readonly type: PointsExchangeType;
    readonly points: number;
    readonly subscriptionId?: string;
  }): Promise<{ success: boolean; message: string; value?: number; code?: string }> {
    const config = await this.loadConfig();
    if (!config.exchangeEnabled) {
      throw new BadRequestException('Points exchange is currently disabled');
    }

    const typeConfig = this.getTypeConfig(config, input.type);
    if (!typeConfig.enabled) {
      throw new BadRequestException(`Exchange type ${input.type} is not enabled`);
    }

    if (input.points < typeConfig.minPoints) {
      throw new BadRequestException(`Minimum ${typeConfig.minPoints} points required`);
    }
    if (typeConfig.maxPoints > 0 && input.points > typeConfig.maxPoints) {
      throw new BadRequestException(`Maximum ${typeConfig.maxPoints} points allowed`);
    }

    // Deduct points atomically
    const user = await this.prismaService.user.findUnique({
      where: { id: input.userId },
      select: { id: true, points: true, currentSubscriptionId: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.points < input.points) {
      throw new BadRequestException('Insufficient points balance');
    }

    const computedValue = Math.floor(input.points / typeConfig.pointsCost);
    if (computedValue <= 0) {
      throw new BadRequestException('Points amount too low for any reward');
    }

    // A gift subscription is a fixed-price item: it always costs exactly one
    // `pointsCost` and yields one promo code, regardless of how many points the
    // user typed. Every other reward scales linearly with the points spent.
    const pointsToCharge =
      input.type === 'GIFT_SUBSCRIPTION' ? typeConfig.pointsCost : input.points;
    if (user.points < pointsToCharge) {
      throw new BadRequestException('Insufficient points balance');
    }

    // Subscriptions whose Remnawave profile must be re-synced after the
    // local mutation commits (expiry extension / traffic top-up). We
    // collect ids inside the tx and enqueue the sync jobs afterwards so
    // a rollback never leaves an orphan job — and, critically, so the
    // panel actually receives the change (the previous implementation
    // wrote the local row only and never synced).
    let trafficTopUp: { readonly subscriptionId: string; readonly gb: number } | null = null;
    let expiryExtended: { readonly subscriptionId: string } | null = null;
    // The single-use promo code minted by a GIFT_SUBSCRIPTION exchange — must
    // be surfaced to the user (otherwise the reward is invisible/unusable).
    let giftCode: string | null = null;

    await this.prismaService.$transaction(async (tx) => {
      // Deduct points
      await tx.user.update({
        where: { id: input.userId },
        data: { points: { decrement: pointsToCharge } },
      });

      // Apply effect based on type
      switch (input.type) {
        case 'SUBSCRIPTION_DAYS': {
          const subId = input.subscriptionId ?? user.currentSubscriptionId;
          if (!subId) throw new BadRequestException('No active subscription to extend');
          const sub = await tx.subscription.findUnique({
            where: { id: subId },
            select: { id: true, expiresAt: true, status: true },
          });
          if (!sub || sub.status === SubscriptionStatus.DELETED) {
            throw new BadRequestException('Subscription not found or deleted');
          }
          const baseDate = sub.expiresAt ?? new Date();
          const newExpiry = new Date(baseDate);
          newExpiry.setUTCDate(newExpiry.getUTCDate() + computedValue);
          await tx.subscription.update({
            where: { id: sub.id },
            data: { expiresAt: newExpiry },
          });
          expiryExtended = { subscriptionId: sub.id };
          break;
        }

        case 'GIFT_SUBSCRIPTION': {
          const giftConfig = config.giftSubscription;
          if (!giftConfig.giftPlanId) {
            throw new BadRequestException('Gift subscription plan is not configured');
          }
          // Build a COMPLETE plan snapshot from the configured gift plan.
          // A bare `{ id }` snapshot crashes on activation (the SUBSCRIPTION
          // reward reads `plan.internalSquads`/`deviceLimit`/`duration`).
          const plan = await tx.plan.findUnique({
            where: { id: giftConfig.giftPlanId },
            select: {
              id: true,
              name: true,
              tag: true,
              type: true,
              trafficLimit: true,
              deviceLimit: true,
              trafficLimitStrategy: true,
              internalSquads: true,
              externalSquad: true,
            },
          });
          if (!plan) {
            throw new BadRequestException('Gift subscription plan not found');
          }
          const snapshot = {
            ...(buildPlanSnapshot(plan) as Record<string, unknown>),
            duration: giftConfig.giftDurationDays,
          };
          // Create a single-use promo code with a SUBSCRIPTION reward.
          const code = generateExchangePromoCode();
          await tx.promocode.create({
            data: {
              code,
              isActive: true,
              availability: 'ALL',
              rewardType: 'SUBSCRIPTION',
              reward: giftConfig.giftDurationDays,
              plan: snapshot as Prisma.InputJsonValue,
              maxActivations: 1,
            },
          });
          giftCode = code;
          break;
        }

        case 'DISCOUNT': {
          const discountConfig = config.discount;
          const discountPercent = Math.min(computedValue, discountConfig.maxDiscountPercent);
          // Clamp the CUMULATIVE personal discount to the configured cap (and
          // hard-cap at 100) so repeated exchanges can't stack past the limit.
          const current = await tx.user.findUnique({
            where: { id: input.userId },
            select: { personalDiscount: true },
          });
          const nextDiscount = Math.min(
            (current?.personalDiscount ?? 0) + discountPercent,
            discountConfig.maxDiscountPercent,
            100,
          );
          await tx.user.update({
            where: { id: input.userId },
            data: { personalDiscount: nextDiscount },
          });
          break;
        }

        case 'TRAFFIC': {
          const trafficConfig = config.traffic;
          const trafficGb = Math.min(computedValue, trafficConfig.maxTrafficGb);
          const subId = input.subscriptionId ?? user.currentSubscriptionId;
          if (!subId) throw new BadRequestException('No active subscription for traffic');
          const sub = await tx.subscription.findUnique({
            where: { id: subId },
            select: { id: true, trafficLimit: true },
          });
          if (!sub) throw new BadRequestException('Subscription not found');
          if (sub.trafficLimit === null) {
            // Unlimited traffic — nothing to add
            break;
          }
          await tx.subscription.update({
            where: { id: sub.id },
            data: { trafficLimit: { increment: trafficGb } },
          });
          trafficTopUp = { subscriptionId: sub.id, gb: trafficGb };
          break;
        }
      }
    });

    // Post-commit Remnawave sync. Both the traffic top-up and the expiry
    // extension change the panel profile, so enqueue an UPDATE sync job.
    // Failures here are logged but don't reverse the (committed) points
    // spend — the sweep/retry path and admin re-sync are the safety net.
    try {
      if (trafficTopUp !== null) {

        await this.enqueueProfileSync(trafficTopUp.subscriptionId, {
          source: 'REFERRAL_EXCHANGE_TRAFFIC',

          topUpGb: trafficTopUp.gb,
        });
      }
      if (expiryExtended !== null) {

        await this.enqueueProfileSync(expiryExtended.subscriptionId, {
          source: 'REFERRAL_EXCHANGE_DAYS',
        });
      }
    } catch (err: unknown) {
      this.logger.error(
        `Points-exchange Remnawave sync enqueue failed for user ${input.userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.logger.log(
      `User ${input.userId} exchanged ${pointsToCharge} points for ${input.type} (value: ${computedValue})`,
    );

    return {
      success: true,
      message: `Exchanged ${pointsToCharge} points`,
      value: giftCode !== null ? 1 : computedValue,
      code: giftCode ?? undefined,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private buildOption(
    type: PointsExchangeType,
    typeConfig: ExchangeTypeConfig,
    balance: number,
    _globalConfig: PointsExchangeConfig,
  ): ExchangeOption {
    const computedValue = typeConfig.pointsCost > 0
      ? Math.floor(balance / typeConfig.pointsCost)
      : 0;
    const available = typeConfig.enabled && balance >= typeConfig.minPoints;
    return {
      type,
      enabled: typeConfig.enabled,
      available,
      pointsCost: typeConfig.pointsCost,
      minPoints: typeConfig.minPoints,
      maxPoints: typeConfig.maxPoints,
      computedValue,
    };
  }

  private getTypeConfig(config: PointsExchangeConfig, type: PointsExchangeType): ExchangeTypeConfig {
    switch (type) {
      case 'SUBSCRIPTION_DAYS': return config.subscriptionDays;
      case 'GIFT_SUBSCRIPTION': return config.giftSubscription;
      case 'DISCOUNT': return config.discount;
      case 'TRAFFIC': return config.traffic;
    }
  }

  private async loadConfig(): Promise<PointsExchangeConfig> {
    const settings = await this.prismaService.settings.findFirst({
      select: { referralSettings: true },
    });
    if (!settings) return DEFAULT_CONFIG;
    const json = settings.referralSettings as Record<string, unknown>;
    const pe = (json?.points_exchange ?? {}) as Record<string, unknown>;
    return {
      exchangeEnabled: pe.exchange_enabled === true,
      pointsPerDay: typeof pe.points_per_day === 'number' ? pe.points_per_day : 100,
      minExchangePoints: typeof pe.min_exchange_points === 'number' ? pe.min_exchange_points : 100,
      maxExchangePoints: typeof pe.max_exchange_points === 'number' ? pe.max_exchange_points : -1,
      subscriptionDays: readTypeConfig(pe, 'subscription_days'),
      giftSubscription: {
        ...readTypeConfig(pe, 'gift_subscription'),
        giftPlanId: readString(pe, 'gift_subscription', 'gift_plan_id'),
        giftDurationDays: readNumber(pe, 'gift_subscription', 'gift_duration_days', 30),
      },
      discount: {
        ...readTypeConfig(pe, 'discount'),
        maxDiscountPercent: readNumber(pe, 'discount', 'max_discount_percent', 50),
      },
      traffic: {
        ...readTypeConfig(pe, 'traffic'),
        maxTrafficGb: readNumber(pe, 'traffic', 'max_traffic_gb', 100),
      },
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readTypeConfig(parent: Record<string, unknown>, key: string): ExchangeTypeConfig {
  const obj = (parent[key] ?? {}) as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    pointsCost: typeof obj.points_cost === 'number' ? obj.points_cost : 100,
    minPoints: typeof obj.min_points === 'number' ? obj.min_points : 100,
    maxPoints: typeof obj.max_points === 'number' ? obj.max_points : -1,
  };
}

function readString(parent: Record<string, unknown>, section: string, key: string): string | null {
  const obj = (parent[section] ?? {}) as Record<string, unknown>;
  const val = obj[key];
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function readNumber(parent: Record<string, unknown>, section: string, key: string, fallback: number): number {
  const obj = (parent[section] ?? {}) as Record<string, unknown>;
  const val = obj[key];
  return typeof val === 'number' ? val : fallback;
}

function generateExchangePromoCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GIFT-';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
