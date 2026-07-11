import { Injectable } from '@nestjs/common';
import { Prisma, PromocodeAvailability, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  PromocodeActivationErrorCode,
  PromocodeInterface,
} from '../interfaces/promocode.interface';
import { normalizeCode } from '../utils/code-normalizer.util';
import { PROMOCODE_INCLUDE_ACTIVATIONS_COUNT, mapPromocode } from '../utils/promocode-mappers.util';
import { isPromocodeDepleted, isPromocodeExpired } from '../utils/promocode-state.util';

export interface PromocodeValidationFailureInterface {
  readonly success: false;
  readonly errorCode: PromocodeActivationErrorCode;
  readonly messageKey: string;
}

export interface PromocodeValidationSuccessInterface {
  readonly success: true;
  readonly promocode: PromocodeInterface;
  readonly messageKey: 'ntf-promocode-valid';
}

export type PromocodeValidationResultInterface =
  | PromocodeValidationFailureInterface
  | PromocodeValidationSuccessInterface;

interface ValidatePromocodeContext {
  readonly userId: string;
  readonly userTelegramId: bigint | null;
  /// Whether the user has been recorded as referred — corresponds to the donor
  /// `User.is_invited_user` flag. The caller passes it explicitly so the
  /// service stays free of cross-domain queries.
  readonly isInvitedUser: boolean;
  /// True if the user has any subscription that is not in DELETED status.
  /// Used by NEW / EXISTING / TRIAL availability checks.
  readonly hasActiveSubscriptions: boolean;
}

/**
 * Donor: `src/services/promocode_validation.py`.
 *
 * Validates a promocode string before any reward is applied. The pipeline
 * never mutates state — failures simply produce a typed `errorCode` and a
 * stable i18n message key. The caller (`PromocodeLifecycleService`) is
 * responsible for combining validation with the actual reward execution
 * inside a single transaction.
 */
@Injectable()
export class PromocodeValidationService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async validate(
    rawCode: string,
    context: ValidatePromocodeContext,
  ): Promise<PromocodeValidationResultInterface> {
    const code: string = normalizeCode(rawCode);
    if (code.length === 0) {
      return failure('NOT_FOUND', 'ntf-promocode-not-found');
    }

    const record = await this.prismaService.promocode.findFirst({
      where: { code, archivedAt: null },
      include: PROMOCODE_INCLUDE_ACTIVATIONS_COUNT,
    });
    if (record === null) {
      return failure('NOT_FOUND', 'ntf-promocode-not-found');
    }

    if (!record.isActive) {
      return failure('INACTIVE', 'ntf-promocode-inactive');
    }

    if (
      isPromocodeExpired({
        createdAt: record.createdAt,
        lifetime: record.lifetime,
        expiresAt: record.expiresAt,
      })
    ) {
      return failure('EXPIRED', 'ntf-promocode-expired');
    }

    const promocodeView = mapPromocode(record);

    if (isPromocodeDepleted(promocodeView.activationsCount, record.maxActivations)) {
      return failure('DEPLETED', 'ntf-promocode-depleted');
    }

    const alreadyActivated = await this.prismaService.promocodeActivation.count({
      where: { promocodeId: record.id, userId: context.userId },
    });
    if (alreadyActivated > 0) {
      return failure('ALREADY_ACTIVATED', 'ntf-promocode-already-activated');
    }

    if (!this.checkAvailability(record, context)) {
      return failure('NOT_AVAILABLE_FOR_USER', 'ntf-promocode-not-available');
    }

    return {
      success: true,
      promocode: promocodeView,
      messageKey: 'ntf-promocode-valid',
    };
  }

  /**
   * Donor parity: an active subscription is one whose status is NOT
   * `DELETED`. The caller resolves this with a single `count()` query so we
   * just receive a boolean.
   */
  public async resolveActivationContext(userId: string): Promise<{
    readonly hasActiveSubscriptions: boolean;
    readonly isInvitedUser: boolean;
  }> {
    const [subscriptionCount, referralCount] = await Promise.all([
      this.prismaService.subscription.count({
        where: { userId, NOT: { status: SubscriptionStatus.DELETED } },
      }),
      this.prismaService.referral.count({ where: { referredId: userId } }),
    ]);
    return {
      hasActiveSubscriptions: subscriptionCount > 0,
      isInvitedUser: referralCount > 0,
    };
  }

  /**
   * Returns the eligible active subscription ids the user owns whose plan id
   * matches the promocode `allowedPlanIds`. When the promo has no plan
   * filter, every active subscription is eligible.
   */
  public async getEligibleSubscriptionIds(input: {
    readonly userId: string;
    readonly promocode: PromocodeInterface;
  }): Promise<readonly string[]> {
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId: input.userId,
        status: SubscriptionStatus.ACTIVE,
      },
      select: { id: true, planSnapshot: true },
    });
    const allowedPlanIds = new Set(input.promocode.allowedPlanIds);
    if (allowedPlanIds.size === 0) {
      return subscriptions.map((subscription) => subscription.id);
    }
    return subscriptions
      .filter((subscription) =>
        allowedPlanIds.has(readPlanIdFromSnapshot(subscription.planSnapshot) ?? ''),
      )
      .map((subscription) => subscription.id);
  }

  /**
   * Resolves whether the supplied target subscription belongs to the user,
   * is still in ACTIVE status, and (when the promo restricts plans) sits on
   * an allowed plan. Returns `null` on any failure together with the typed
   * error code so the caller can surface a bounded error response.
   */
  public async resolveTargetSubscription(input: {
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
    readonly promocode: PromocodeInterface;
  }): Promise<{
    readonly subscriptionId: string | null;
    readonly errorCode: PromocodeActivationErrorCode | null;
  }> {
    if (input.targetSubscriptionId === null) {
      return { subscriptionId: null, errorCode: null };
    }
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.targetSubscriptionId },
      select: { id: true, userId: true, status: true, planSnapshot: true },
    });
    if (subscription === null) {
      return { subscriptionId: null, errorCode: 'SUBSCRIPTION_NOT_FOUND' };
    }
    if (subscription.userId !== input.userId) {
      return { subscriptionId: null, errorCode: 'SUBSCRIPTION_FOREIGN' };
    }
    if (subscription.status !== SubscriptionStatus.ACTIVE) {
      return { subscriptionId: null, errorCode: 'SUBSCRIPTION_NOT_ACTIVE' };
    }
    if (input.promocode.allowedPlanIds.length > 0) {
      const planId = readPlanIdFromSnapshot(subscription.planSnapshot);
      if (planId === null || !input.promocode.allowedPlanIds.includes(planId)) {
        return { subscriptionId: null, errorCode: 'PLAN_NOT_ELIGIBLE' };
      }
    }
    return { subscriptionId: subscription.id, errorCode: null };
  }

  /**
   * Donor: `check_availability` — branches by `availability` enum. The
   * caller supplies `hasActiveSubscriptions` and `isInvitedUser` to keep this
   * method free of cross-domain Prisma access.
   */
  private checkAvailability(
    record: { availability: PromocodeAvailability; allowedTelegramIds: bigint[] },
    context: ValidatePromocodeContext,
  ): boolean {
    switch (record.availability) {
      case PromocodeAvailability.ALL:
        return true;
      case PromocodeAvailability.NEW:
        return !context.hasActiveSubscriptions;
      case PromocodeAvailability.EXISTING:
        return context.hasActiveSubscriptions;
      case PromocodeAvailability.INVITED:
        return context.isInvitedUser;
      case PromocodeAvailability.ALLOWED:
        if (context.userTelegramId === null) {
          return false;
        }
        return record.allowedTelegramIds.some((allowed) => allowed === context.userTelegramId);
      default:
        return false;
    }
  }
}

function failure(
  errorCode: PromocodeActivationErrorCode,
  messageKey: string,
): PromocodeValidationFailureInterface {
  return { success: false, errorCode, messageKey };
}

function readPlanIdFromSnapshot(value: Prisma.JsonValue): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>).id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}
