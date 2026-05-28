import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { UserNotificationsService } from '../notifications/services/user-notifications.service';

const BATCH_SIZE = 100;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Auto-renewal service — donor: altshop `src/services/auto_renew.py` +
 * scheduled Taskiq tasks.
 *
 * Responsibilities:
 *  1. Detect ACTIVE subscriptions past their `expiresAt` → mark EXPIRED
 *  2. (Future) Attempt partner-balance auto-renewal before expiring
 *  3. Create `UserNotificationEvent` rows for expiry warnings (3d, 1d)
 *
 * This service is designed to be called from a cron interval (e.g., every
 * 30 seconds via `@nestjs/schedule`). The worker module will wire the cron
 * once `@nestjs/schedule` is added to the project.
 */
@Injectable()
export class AutoRenewService {
  private readonly logger = new Logger(AutoRenewService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly userNotifications: UserNotificationsService,
  ) {}

  /**
   * Marks expired subscriptions as EXPIRED. Returns the count of affected
   * rows so the caller can log/alert.
   */
  public async markExpiredSubscriptions(): Promise<number> {
    const now = new Date();
    const expired = await this.prismaService.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: { lt: now, not: null },
      },
      select: { id: true },
      take: BATCH_SIZE,
    });

    if (expired.length === 0) {
      return 0;
    }

    const ids = expired.map((s) => s.id);
    const result = await this.prismaService.subscription.updateMany({
      where: { id: { in: ids }, status: SubscriptionStatus.ACTIVE },
      data: { status: SubscriptionStatus.EXPIRED },
    });

    this.logger.log(`Marked ${result.count} subscriptions as EXPIRED`);
    return result.count;
  }

  /**
   * Creates expiry warning notification events for subscriptions expiring
   * within the given horizon (e.g., 3 days, 1 day). Idempotent — skips
   * users who already have a recent notification of the same type.
   */
  public async createExpiryWarnings(input: {
    readonly daysAhead: number;
    readonly notificationType: string;
  }): Promise<number> {
    const now = new Date();
    const horizon = new Date(now.getTime() + input.daysAhead * ONE_DAY_MS);
    const windowStart = new Date(horizon.getTime() - 3 * 60 * 60 * 1000);
    const recentThreshold = new Date(now.getTime() - 20 * 60 * 60 * 1000);

    const expiringSoon = await this.prismaService.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        expiresAt: { gt: windowStart, lt: horizon },
      },
      select: { id: true, userId: true, expiresAt: true, planSnapshot: true },
      take: 200,
    });

    let created = 0;
    for (const sub of expiringSoon) {
      // Skip if already notified recently
      const existing = await this.prismaService.userNotificationEvent.findFirst({
        where: {
          userId: sub.userId,
          type: input.notificationType,
          createdAt: { gt: recentThreshold },
        },
        select: { id: true },
      });
      if (existing !== null) {
        continue;
      }

      const planName = readPlanName(sub.planSnapshot);
      await this.userNotifications.create({
        userId: sub.userId,
        type: input.notificationType,
        payload: {
          subscriptionId: sub.id,
          expiresAt: sub.expiresAt?.toISOString() ?? null,
          plan: planName,
          planName,
          daysLeft: input.daysAhead,
        },
      });
      created++;
    }

    if (created > 0) {
      this.logger.log(
        `Created ${created} "${input.notificationType}" notifications`,
      );
    }
    return created;
  }

  /**
   * Full cycle: mark expired + send warnings. Designed to be called from a
   * single cron tick.
   */
  public async runCycle(): Promise<{
    readonly expired: number;
    readonly warnings3d: number;
    readonly warnings1d: number;
  }> {
    const expired = await this.markExpiredSubscriptions();
    const warnings3d = await this.createExpiryWarnings({
      daysAhead: 3,
      notificationType: 'subscription_expiring_3d',
    });
    const warnings1d = await this.createExpiryWarnings({
      daysAhead: 1,
      notificationType: 'subscription_expiring_1d',
    });
    return { expired, warnings3d, warnings1d };
  }
}

function readPlanName(snapshot: unknown): string {
  if (typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)) {
    const candidate = (snapshot as Record<string, unknown>).name;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return 'Unknown';
}
