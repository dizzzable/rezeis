import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ReferralPointsExchangeType,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { buildPlanSnapshot } from '../../users/utils/plan-snapshot.util';

export type PointsExchangeType = 'SUBSCRIPTION_DAYS' | 'GIFT_SUBSCRIPTION' | 'DISCOUNT' | 'TRAFFIC';

export interface ExchangeTypeConfig {
  enabled: boolean;
  pointsCost: number;
  minPoints: number;
  maxPoints: number;
}

export interface PointsExchangeConfig {
  exchangeEnabled: boolean;
  pointsPerDay: number;
  minExchangePoints: number;
  maxExchangePoints: number;
  subscriptionDays: ExchangeTypeConfig;
  giftSubscription: ExchangeTypeConfig & { giftPlanId: string | null; giftDurationDays: number };
  discount: ExchangeTypeConfig & { maxDiscountPercent: number };
  traffic: ExchangeTypeConfig & { maxTrafficGb: number };
}

export interface ExchangeOption {
  type: PointsExchangeType;
  enabled: boolean;
  available: boolean;
  pointsCost: number;
  minPoints: number;
  maxPoints: number;
  computedValue: number;
}

export interface ExchangeOptionsResponse {
  exchangeEnabled: boolean;
  pointsBalance: number;
  types: ExchangeOption[];
}

interface AppliedExchange {
  readonly targetSubscriptionId: string | null;
  readonly rewardValue: number;
  readonly giftCode: string | null;
  readonly giftPromocodeId: string | null;
  readonly syncJobId: string | null;
  readonly expiresAtBefore: Date | null;
  readonly expiresAtAfter: Date | null;
  readonly trafficLimitBefore: number | null;
  readonly trafficLimitAfter: number | null;
  readonly personalDiscountBefore: number | null;
  readonly personalDiscountAfter: number | null;
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
 * Applies referral point rewards as one durable transaction. A successful
 * exchange always has an immutable ledger record and, for panel-facing
 * rewards, a durable PENDING ProfileSyncJob before points are committed.
 */
@Injectable()
export class ReferralPointsExchangeService {
  private readonly logger = new Logger(ReferralPointsExchangeService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
  ) {}

  public async getExchangeOptions(userId: string): Promise<ExchangeOptionsResponse> {
    const [user, config] = await Promise.all([
      this.prismaService.user.findUnique({ where: { id: userId }, select: { points: true } }),
      this.loadConfig(),
    ]);
    if (user === null) throw new NotFoundException('User not found');

    return {
      exchangeEnabled: config.exchangeEnabled,
      pointsBalance: user.points,
      types: [
        this.buildOption('SUBSCRIPTION_DAYS', config.subscriptionDays, user.points),
        this.buildOption('GIFT_SUBSCRIPTION', config.giftSubscription, user.points),
        this.buildOption('DISCOUNT', config.discount, user.points),
        this.buildOption('TRAFFIC', config.traffic, user.points),
      ],
    };
  }

  public async executeExchange(input: {
    readonly userId: string;
    readonly type: PointsExchangeType;
    readonly points: number;
    readonly subscriptionId?: string;
    readonly idempotencyKey?: string;
  }): Promise<{
    readonly success: boolean;
    readonly message: string;
    readonly value?: number;
    readonly code?: string;
    readonly syncPending?: boolean;
  }> {
    this.validateInput(input);
    // A network retry must replay its already committed result even if an
    // operator changed the exchange configuration in the meantime.
    if (input.idempotencyKey !== undefined) {
      const previous = await this.findPreviousExchange(input.userId, input.idempotencyKey);
      if (previous !== null) return this.replayExchange(previous);
    }

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

    const computedValue = Math.floor(input.points / typeConfig.pointsCost);
    if (computedValue <= 0) {
      throw new BadRequestException('Points amount too low for any reward');
    }
    const pointsToCharge = input.type === 'GIFT_SUBSCRIPTION' ? typeConfig.pointsCost : input.points;

    try {
      const outcome = await this.prismaService.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: input.userId },
          select: { id: true, currentSubscriptionId: true },
        });
        if (user === null) throw new NotFoundException('User not found');

        const targetSubscriptionId =
          input.type === 'SUBSCRIPTION_DAYS' || input.type === 'TRAFFIC'
            ? await this.resolveActiveSubscriptionId(
              tx,
              input.userId,
              input.subscriptionId,
              user.currentSubscriptionId,
            )
            : null;

        const applied = await this.applyExchange({
          tx,
          input,
          config,
          computedValue,
          pointsToCharge,
          targetSubscriptionId,
        });
        const ledger = await tx.referralPointsExchange.create({
          data: {
            userId: input.userId,
            targetSubscriptionId: applied.targetSubscriptionId,
            type: input.type as ReferralPointsExchangeType,
            pointsSpent: pointsToCharge,
            rewardValue: applied.rewardValue,
            expiresAtBefore: applied.expiresAtBefore,
            expiresAtAfter: applied.expiresAtAfter,
            trafficLimitBefore: applied.trafficLimitBefore,
            trafficLimitAfter: applied.trafficLimitAfter,
            personalDiscountBefore: applied.personalDiscountBefore,
            personalDiscountAfter: applied.personalDiscountAfter,
            giftPromocodeId: applied.giftPromocodeId,
            profileSyncJobId: applied.syncJobId,
            idempotencyKey: input.idempotencyKey,
          },
          select: { id: true },
        });
        return { ...applied, ledgerId: ledger.id };
      });

      if (outcome.syncJobId !== null) {
        try {
          await this.profileSyncQueueService.enqueue(outcome.syncJobId);
        } catch (error: unknown) {
          this.logger.warn(
            `Points exchange ${outcome.ledgerId}: persisted sync job ${outcome.syncJobId} will be recovered by sweep: ${toErrorMessage(error)}`,
          );
        }
      }

      this.logger.log(
        `User ${input.userId} exchanged ${pointsToCharge} points for ${input.type} (actual value: ${outcome.rewardValue}, record: ${outcome.ledgerId})`,
      );
      return {
        success: true,
        message: `Exchanged ${pointsToCharge} points`,
        value: outcome.rewardValue,
        code: outcome.giftCode ?? undefined,
        syncPending: outcome.syncJobId !== null,
      };
    } catch (error: unknown) {
      if (input.idempotencyKey !== undefined && isUniqueIdempotencyError(error)) {
        const previous = await this.findPreviousExchange(input.userId, input.idempotencyKey);
        if (previous !== null) return this.replayExchange(previous);
      }
      throw error;
    }
  }

  private async applyExchange(input: {
    readonly tx: Prisma.TransactionClient;
    readonly input: {
      readonly userId: string;
      readonly type: PointsExchangeType;
      readonly subscriptionId?: string;
    };
    readonly config: PointsExchangeConfig;
    readonly computedValue: number;
    readonly pointsToCharge: number;
    readonly targetSubscriptionId: string | null;
  }): Promise<AppliedExchange> {
    const empty = (): Omit<AppliedExchange, 'targetSubscriptionId' | 'rewardValue'> => ({
      giftCode: null,
      giftPromocodeId: null,
      syncJobId: null,
      expiresAtBefore: null,
      expiresAtAfter: null,
      trafficLimitBefore: null,
      trafficLimitAfter: null,
      personalDiscountBefore: null,
      personalDiscountAfter: null,
    });

    switch (input.input.type) {
      case 'SUBSCRIPTION_DAYS': {
        const subscription = await this.loadLockedTarget(
          input.tx,
          input.input.userId,
          input.targetSubscriptionId,
          'No active subscription to extend',
        );
        if (subscription.expiresAt === null) {
          throw new BadRequestException('Unlimited subscription does not need a duration exchange');
        }
        if (subscription.remnawaveId === null) {
          throw new BadRequestException(
            'Subscription needs a Remnawave profile repair before points can be exchanged',
          );
        }
        await this.spendPoints(input.tx, input.input.userId, input.pointsToCharge);
        const base = new Date(Math.max(subscription.expiresAt.getTime(), Date.now()));
        const expiresAtAfter = new Date(base.getTime() + input.computedValue * MS_PER_DAY);
        await input.tx.subscription.update({
          where: { id: subscription.id },
          data: { expiresAt: expiresAtAfter, status: SubscriptionStatus.ACTIVE },
        });
        const syncJobId = await this.createSubscriptionSyncJob(input.tx, subscription, {
          source: 'REFERRAL_EXCHANGE_DAYS',
          pointsExchangeType: input.input.type,
        });
        return {
          ...empty(),
          targetSubscriptionId: subscription.id,
          rewardValue: input.computedValue,
          expiresAtBefore: subscription.expiresAt,
          expiresAtAfter,
          syncJobId,
        };
      }

      case 'TRAFFIC': {
        const subscription = await this.loadLockedTarget(
          input.tx,
          input.input.userId,
          input.targetSubscriptionId,
          'No active subscription for traffic',
        );
        if (subscription.trafficLimit === null) {
          throw new BadRequestException('Unlimited subscription traffic cannot be topped up');
        }
        if (subscription.remnawaveId === null) {
          throw new BadRequestException(
            'Subscription needs a Remnawave profile repair before points can be exchanged',
          );
        }
        const trafficGb = Math.min(input.computedValue, input.config.traffic.maxTrafficGb);
        if (trafficGb <= 0) throw new BadRequestException('Traffic exchange has no reward');
        await this.spendPoints(input.tx, input.input.userId, input.pointsToCharge);
        const trafficLimitAfter = subscription.trafficLimit + trafficGb;
        await input.tx.subscription.update({
          where: { id: subscription.id },
          data: { trafficLimit: trafficLimitAfter },
        });
        const syncJobId = await this.createSubscriptionSyncJob(input.tx, subscription, {
          source: 'REFERRAL_EXCHANGE_TRAFFIC',
          pointsExchangeType: input.input.type,
          topUpGb: trafficGb,
        });
        return {
          ...empty(),
          targetSubscriptionId: subscription.id,
          rewardValue: trafficGb,
          trafficLimitBefore: subscription.trafficLimit,
          trafficLimitAfter,
          syncJobId,
        };
      }

      case 'DISCOUNT': {
        await this.spendPoints(input.tx, input.input.userId, input.pointsToCharge);
        const current = await input.tx.user.findUnique({
          where: { id: input.input.userId },
          select: { personalDiscount: true },
        });
        const personalDiscountBefore = current?.personalDiscount ?? 0;
        const personalDiscountAfter = Math.min(
          personalDiscountBefore + Math.min(input.computedValue, input.config.discount.maxDiscountPercent),
          input.config.discount.maxDiscountPercent,
          100,
        );
        const rewardValue = personalDiscountAfter - personalDiscountBefore;
        if (rewardValue <= 0) {
          throw new BadRequestException('Personal discount is already at its maximum');
        }
        await input.tx.user.update({
          where: { id: input.input.userId },
          data: { personalDiscount: personalDiscountAfter },
        });
        return {
          ...empty(),
          targetSubscriptionId: null,
          rewardValue,
          personalDiscountBefore,
          personalDiscountAfter,
        };
      }

      case 'GIFT_SUBSCRIPTION': {
        const giftConfig = input.config.giftSubscription;
        if (!giftConfig.giftPlanId) {
          throw new BadRequestException('Gift subscription plan is not configured');
        }
        const plan = await input.tx.plan.findUnique({
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
        if (plan === null) throw new BadRequestException('Gift subscription plan not found');
        await this.spendPoints(input.tx, input.input.userId, input.pointsToCharge);
        const giftCode = generateExchangePromoCode();
        const gift = await input.tx.promocode.create({
          data: {
            code: giftCode,
            isActive: true,
            availability: 'ALL',
            rewardType: 'SUBSCRIPTION',
            reward: giftConfig.giftDurationDays,
            plan: {
              ...(buildPlanSnapshot(plan) as Record<string, unknown>),
              duration: giftConfig.giftDurationDays,
            } as Prisma.InputJsonValue,
            maxActivations: 1,
          },
          select: { id: true },
        });
        return {
          ...empty(),
          targetSubscriptionId: null,
          rewardValue: 1,
          giftCode,
          giftPromocodeId: gift.id,
        };
      }
    }
  }

  private async spendPoints(
    tx: Prisma.TransactionClient,
    userId: string,
    points: number,
  ): Promise<void> {
    const updated = await tx.user.updateMany({
      where: { id: userId, points: { gte: points } },
      data: { points: { decrement: points } },
    });
    if (updated.count !== 1) {
      throw new BadRequestException('Insufficient points balance');
    }
  }

  private async loadLockedTarget(
    tx: Prisma.TransactionClient,
    userId: string,
    subscriptionId: string | null,
    missingMessage: string,
  ) {
    if (subscriptionId === null) throw new BadRequestException(missingMessage);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`,
    );
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        status: true,
        expiresAt: true,
        trafficLimit: true,
        remnawaveId: true,
      },
    });
    if (
      subscription === null ||
      subscription.userId !== userId ||
      subscription.status !== SubscriptionStatus.ACTIVE
    ) {
      throw new BadRequestException('Subscription is not an active user subscription');
    }
    return subscription;
  }

  private async createSubscriptionSyncJob(
    tx: Prisma.TransactionClient,
    subscription: { readonly id: string; readonly remnawaveId: string | null },
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (subscription.remnawaveId === null) {
      throw new BadRequestException(
        'Subscription needs a Remnawave profile repair before points can be exchanged',
      );
    }
    const job = await tx.profileSyncJob.create({
      data: {
        subscriptionId: subscription.id,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: payload as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return job.id;
  }

  private async resolveActiveSubscriptionId(
    tx: Prisma.TransactionClient,
    userId: string,
    explicitId: string | undefined,
    currentSubscriptionId: string | null,
  ): Promise<string | null> {
    if (explicitId !== undefined) {
      const explicit = await tx.subscription.findFirst({
        where: { id: explicitId, userId, status: SubscriptionStatus.ACTIVE },
        select: { id: true },
      });
      return explicit?.id ?? null;
    }

    if (currentSubscriptionId !== null) {
      const current = await tx.subscription.findFirst({
        where: { id: currentSubscriptionId, userId, status: SubscriptionStatus.ACTIVE },
        select: { id: true },
      });
      if (current !== null) return current.id;
    }

    const now = new Date();
    const live = await tx.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE, expiresAt: { gte: now } },
      orderBy: [{ expiresAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    if (live !== null) return live.id;

    const unlimited = await tx.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE, expiresAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (unlimited !== null) return unlimited.id;

    const stale = await tx.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      orderBy: [{ expiresAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    return stale?.id ?? null;
  }

  private async findPreviousExchange(userId: string, idempotencyKey: string) {
    return this.prismaService.referralPointsExchange.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: {
        pointsSpent: true,
        rewardValue: true,
        profileSyncJobId: true,
        giftPromocode: { select: { code: true } },
      },
    });
  }

  private replayExchange(exchange: {
    readonly pointsSpent: number;
    readonly rewardValue: number;
    readonly profileSyncJobId: string | null;
    readonly giftPromocode: { readonly code: string } | null;
  }) {
    return {
      success: true,
      message: `Exchanged ${exchange.pointsSpent} points`,
      value: exchange.rewardValue,
      code: exchange.giftPromocode?.code,
      syncPending: exchange.profileSyncJobId !== null,
    };
  }

  private validateInput(input: {
    readonly type: PointsExchangeType;
    readonly points: number;
    readonly idempotencyKey?: string;
  }): void {
    if (!isPointsExchangeType(input.type)) {
      throw new BadRequestException('Unknown points exchange type');
    }
    if (!Number.isSafeInteger(input.points) || input.points <= 0) {
      throw new BadRequestException('Points must be a positive integer');
    }
    if (
      input.idempotencyKey !== undefined &&
      (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 128)
    ) {
      throw new BadRequestException('Invalid idempotency key');
    }
  }

  private buildOption(type: PointsExchangeType, typeConfig: ExchangeTypeConfig, balance: number): ExchangeOption {
    const computedValue = typeConfig.pointsCost > 0 ? Math.floor(balance / typeConfig.pointsCost) : 0;
    return {
      type,
      enabled: typeConfig.enabled,
      available: typeConfig.enabled && balance >= typeConfig.minPoints,
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
    const settings = await this.prismaService.settings.findFirst({ select: { referralSettings: true } });
    if (settings === null) return DEFAULT_CONFIG;
    const json = settings.referralSettings as Record<string, unknown>;
    const pointsExchange = pickObject(json, ['pointsExchange', 'points_exchange']);
    return {
      exchangeEnabled: pickBool(pointsExchange, ['exchangeEnabled', 'exchange_enabled']),
      pointsPerDay: pickNumber(pointsExchange, ['pointsPerDay', 'points_per_day'], 100),
      minExchangePoints: pickNumber(pointsExchange, ['minExchangePoints', 'min_exchange_points'], 100),
      maxExchangePoints: pickNumber(pointsExchange, ['maxExchangePoints', 'max_exchange_points'], -1),
      subscriptionDays: readTypeConfig(pointsExchange, ['subscriptionDays', 'subscription_days']),
      giftSubscription: {
        ...readTypeConfig(pointsExchange, ['giftSubscription', 'gift_subscription']),
        giftPlanId: readSectionString(pointsExchange, ['giftSubscription', 'gift_subscription'], ['giftPlanId', 'gift_plan_id']),
        giftDurationDays: readSectionNumber(pointsExchange, ['giftSubscription', 'gift_subscription'], ['giftDurationDays', 'gift_duration_days'], 30),
      },
      discount: {
        ...readTypeConfig(pointsExchange, ['discount']),
        maxDiscountPercent: readSectionNumber(pointsExchange, ['discount'], ['maxDiscountPercent', 'max_discount_percent'], 50),
      },
      traffic: {
        ...readTypeConfig(pointsExchange, ['traffic']),
        maxTrafficGb: readSectionNumber(pointsExchange, ['traffic'], ['maxTrafficGb', 'max_traffic_gb'], 100),
      },
    };
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isPointsExchangeType(value: string): value is PointsExchangeType {
  return value === 'SUBSCRIPTION_DAYS' || value === 'GIFT_SUBSCRIPTION' || value === 'DISCOUNT' || value === 'TRAFFIC';
}

function isUniqueIdempotencyError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickObject(parent: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> {
  if (parent === undefined) return {};
  for (const key of keys) {
    const value = parent[key];
    if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  }
  return {};
}

function pickBool(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => obj[key] === true);
}

function pickNumber(obj: Record<string, unknown>, keys: readonly string[], fallback: number): number {
  for (const key of keys) {
    if (typeof obj[key] === 'number') return obj[key] as number;
  }
  return fallback;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function readTypeConfig(parent: Record<string, unknown>, sectionKeys: readonly string[]): ExchangeTypeConfig {
  const section = pickObject(parent, sectionKeys);
  const pointsCost = pickNumber(section, ['pointsCost', 'points_cost'], 100);
  return {
    enabled: pickBool(section, ['enabled']),
    pointsCost,
    minPoints: pickNumber(section, ['minPoints', 'min_points'], pointsCost),
    maxPoints: pickNumber(section, ['maxPoints', 'max_points'], -1),
  };
}

function readSectionString(parent: Record<string, unknown>, sectionKeys: readonly string[], keys: readonly string[]): string | null {
  return pickString(pickObject(parent, sectionKeys), keys);
}

function readSectionNumber(parent: Record<string, unknown>, sectionKeys: readonly string[], keys: readonly string[], fallback: number): number {
  return pickNumber(pickObject(parent, sectionKeys), keys, fallback);
}

function generateExchangePromoCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GIFT-';
  for (let index = 0; index < 8; index += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
