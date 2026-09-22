import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { formatMinorUnits } from '../../../common/utils/money.util';
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
 *
 * ── Why every money payload carries `amount` AND `amountMinor` ──────────────
 *
 * These events are emitted under dot types (`partner.earning`), and
 * `UserNotificationsService` renders them with the CANONICAL template first:
 * `resolveToggleKey` maps `partner.earning` onto `partner_earning` and
 * `partner.withdrawal_approved` onto `partner_withdrawal_completed`. Those
 * print `<b>{{amount}}</b> {{currency}}`. The payload carried neither — only
 * `amountMinor` — so a partner read «На баланс зачислено <b></b> .» and
 * «Вывод <b></b>  зачислен».
 *
 * So `amount` and `currency` are provided here, and `amountMinor` stays: the
 * dot-type templates the catalogue also seeds print `{{amountMinor}}`, and
 * operators may have written their own copy against it. No template is
 * edited, because a stored template may be one an operator already changed.
 */
@Injectable()
export class PartnerNotificationsService {
  private readonly logger = new Logger(PartnerNotificationsService.name);

  public constructor(
    private readonly userNotifications: UserNotificationsService,
    private readonly prismaService: PrismaService,
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
        ...(await this.balanceMoney(input.partnerUserId, input.amount)),
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
        ...(await this.balanceMoney(input.partnerUserId, input.amount)),
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
        // The stock rejection copy prints only the reason, but it is the same
        // family and an operator who adds the sum should find it there.
        ...(await this.balanceMoney(input.partnerUserId, input.amount)),
        reason: input.reason,
      },
    });
  }

  /**
   * `{ amount, currency }` for a sum held on a partner balance.
   *
   * `amount` is the minor-unit sum in major units — `15050` → `"150.50"`,
   * `15000` → `"150"` — with a dot, because the payload is written before
   * anyone knows the reader's language. `currency` is what the balance is
   * denominated in: the user's `partnerBalanceCurrencyOverride`, else the
   * operator's `defaultCurrency`, the rule `InternalPartnerController` and
   * `PartnerBalancePaymentService` already apply.
   *
   * Never throws: the accrual or payout this announces has already happened,
   * and a failed currency read costs the unit, not the notification.
   */
  private async balanceMoney(
    partnerUserId: string,
    amountMinor: number,
  ): Promise<{ readonly amount: string; readonly currency?: string }> {
    const amount = formatMinorUnits(amountMinor);
    try {
      const [user, settings] = await Promise.all([
        this.prismaService.user.findUnique({
          where: { id: partnerUserId },
          select: { partnerBalanceCurrencyOverride: true },
        }),
        this.prismaService.settings.findUnique({
          where: { id: 1 },
          select: { defaultCurrency: true },
        }),
      ]);
      const currency = user?.partnerBalanceCurrencyOverride ?? settings?.defaultCurrency ?? null;
      return currency === null ? { amount } : { amount, currency };
    } catch (error: unknown) {
      this.logger.warn(
        `Could not resolve the partner balance currency for ${partnerUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { amount };
    }
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
