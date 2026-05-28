import { Injectable, Logger } from '@nestjs/common';

import { UserNotificationsService } from '../../notifications/services/user-notifications.service';

/**
 * Creates `UserNotificationEvent` rows for partner-program lifecycle
 * events through `UserNotificationsService`. The service writes the
 * cabinet-feed row and (best-effort) pushes the rendered text to the
 * bot for Telegram delivery — the email/push bridges still read the
 * persisted rows on their own schedule.
 *
 * Keeping this service thin — it does not know how the notification is
 * delivered, only that there's something to notify about. That keeps
 * partner concerns out of the delivery layer and lets the operator
 * customize templates per channel through the existing admin UI.
 */
@Injectable()
export class PartnerNotificationsService {
  private readonly logger = new Logger(PartnerNotificationsService.name);

  public constructor(
    private readonly userNotifications: UserNotificationsService,
  ) {}

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
      await this.userNotifications.create(input);
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
