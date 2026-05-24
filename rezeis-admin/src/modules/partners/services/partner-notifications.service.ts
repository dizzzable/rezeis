import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Creates `UserNotificationEvent` rows for partner-program lifecycle
 * events. The existing email/Telegram delivery bridges (see
 * `EmailEventBridgeService`, `UserNotificationDeliveryQueueService`) pick
 * those rows up automatically, render any matching template, and dispatch.
 *
 * Keeping this service thin — it does not know how the notification is
 * delivered, only that there's something to notify about. That keeps
 * partner concerns out of the delivery layer and lets the operator
 * customize templates per channel through the existing admin UI.
 */
@Injectable()
export class PartnerNotificationsService {
  private readonly logger = new Logger(PartnerNotificationsService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async notifyEarning(input: {
    readonly partnerUserId: string;
    readonly amount: number;
    readonly level: number;
    readonly payerUserId: string;
  }): Promise<void> {
    await this.create({
      userId: input.partnerUserId,
      type: 'partner.earning',
      payload: {
        amountMinor: input.amount,
        level: input.level,
        payerUserId: input.payerUserId,
      },
    });
  }

  public async notifyWithdrawalApproved(input: {
    readonly partnerUserId: string;
    readonly withdrawalId: string;
    readonly amount: number;
  }): Promise<void> {
    await this.create({
      userId: input.partnerUserId,
      type: 'partner.withdrawal_approved',
      payload: {
        withdrawalId: input.withdrawalId,
        amountMinor: input.amount,
      },
    });
  }

  public async notifyWithdrawalRejected(input: {
    readonly partnerUserId: string;
    readonly withdrawalId: string;
    readonly amount: number;
    readonly reason: string | null;
  }): Promise<void> {
    await this.create({
      userId: input.partnerUserId,
      type: 'partner.withdrawal_rejected',
      payload: {
        withdrawalId: input.withdrawalId,
        amountMinor: input.amount,
        reason: input.reason,
      },
    });
  }

  private async create(input: {
    readonly userId: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prismaService.userNotificationEvent.create({
        data: {
          userId: input.userId,
          type: input.type,
          payload: input.payload as Prisma.InputJsonObject,
        },
      });
    } catch (error: unknown) {
      // Non-fatal — accrual must not roll back if the notification row
      // can't be persisted (e.g., user gone, FK violation).
      this.logger.warn(
        `Failed to create UserNotificationEvent for ${input.userId}/${input.type}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
