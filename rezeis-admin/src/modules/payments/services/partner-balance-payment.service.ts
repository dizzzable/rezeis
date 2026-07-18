import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccessModeGuard, AccessModeGate } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { InternalPaymentCheckoutInterface } from '../interfaces/internal-payment-checkout.interface';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';
import { PaymentsTransactionsService } from './payments-transactions.service';

export interface PartnerBalancePaymentInput {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly purchaseType: PurchaseType;
  readonly planId: string;
  readonly durationDays: number;
  readonly subscriptionId?: string;
  readonly channel?: PurchaseChannel;
  readonly deviceType?: string;
}

/**
 * PartnerBalancePaymentService
 * ────────────────────────────
 * Lets an active partner pay for a subscription (NEW / ADDITIONAL / RENEW /
 * UPGRADE) with their accrued partner balance instead of an external gateway.
 *
 * Flow (mirrors the synchronous "free add-on" completion path):
 *   1. Gate by access mode + the `partnerSettings.allowBalancePayment` toggle.
 *   2. Price the purchase in the partner's balance currency via the shared
 *      quote/draft pipeline (`createDraft` with `currencyOverride`).
 *   3. Atomically debit the balance (guarded `updateMany`, so a concurrent
 *      attempt can't overspend).
 *   4. Fulfil the transaction through the standard mutation service and mark
 *      it COMPLETED.
 *
 * By design there is NO refund-to-balance on later cancellation — an operator
 * can adjust the balance and remove the subscription manually if needed. The
 * only rollback here is a defensive one when fulfillment itself fails (a
 * system error), so the partner is never debited for nothing.
 */
@Injectable()
export class PartnerBalancePaymentService {
  private readonly logger = new Logger(PartnerBalancePaymentService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
    private readonly paymentsTransactionsService: PaymentsTransactionsService,
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly events: SystemEventsService,
  ) {}

  public async pay(input: PartnerBalancePaymentInput): Promise<InternalPaymentCheckoutInterface> {
    const channel = input.channel ?? PurchaseChannel.WEB;

    // 1. Access-mode gate (same gates as a normal purchase of this type).
    const policy = await this.settingsService.getInternalPlatformPolicy();
    const rejection = this.accessModeGuard.evaluate({
      gate: mapPurchaseTypeToAccessGate(input.purchaseType),
      mode: policy.accessMode,
    });
    if (rejection !== null) {
      throw rejection.status === 503
        ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message })
        : new ForbiddenException({ code: rejection.code, message: rejection.message });
    }

    // 2. Resolve the canonical user + their balance currency.
    const user = await this.resolveUser(input);

    // 3. Operator toggle.
    const partnerSettings = await this.settingsService.getPartnerSettings();
    if (partnerSettings['allowBalancePayment'] !== true) {
      throw new ForbiddenException({
        code: 'PARTNER_BALANCE_DISABLED',
        message: 'Paying with partner balance is disabled.',
      });
    }

    // 4. Active partner record.
    const partner = await this.prismaService.partner.findUnique({
      where: { userId: user.id },
      select: { id: true, isActive: true, balance: true },
    });
    if (partner === null || !partner.isActive) {
      throw new ForbiddenException({
        code: 'PARTNER_BALANCE_NOT_AVAILABLE',
        message: 'You are not an active partner.',
      });
    }

    // 5. Balance currency: per-user override → operator default.
    const balanceCurrency: Currency =
      user.partnerBalanceCurrencyOverride ?? (policy.defaultCurrency as Currency);

    // 6. Price the purchase in the balance currency (shared quote pipeline).
    //    Throws PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE when the plan has no price in
    //    that currency or the purchase isn't allowed.
    const draft = await this.paymentsTransactionsService.createDraft({
      userId: user.id,
      purchaseType: input.purchaseType,
      planId: input.planId,
      durationDays: input.durationDays,
      gatewayType: PaymentGatewayType.PARTNER_BALANCE,
      sourceSubscriptionId: input.subscriptionId,
      channel,
      deviceType: input.deviceType,
      currencyOverride: balanceCurrency,
    });

    const amountMinor = toExactMinorUnits(draft.amount.toString());
    if (amountMinor === null) {
      throw new BadRequestException('PARTNER_BALANCE_INVALID_AMOUNT');
    }
    if (partner.balance < amountMinor) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_PARTNER_BALANCE',
        message: 'Partner balance is insufficient for this purchase.',
      });
    }

    // 7. Atomic, guarded debit — a concurrent attempt with the same balance
    //    can't overspend (only one `balance >= amount` update wins).
    const debit = await this.prismaService.partner.updateMany({
      where: { id: partner.id, balance: { gte: amountMinor } },
      data: { balance: { decrement: amountMinor } },
    });
    if (debit.count === 0) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_PARTNER_BALANCE',
        message: 'Partner balance is insufficient for this purchase.',
      });
    }

    // 8. Fulfil + mark COMPLETED. If fulfillment throws (system error), refund
    //    the debit so the partner isn't charged for nothing.
    const transactionRow = await this.prismaService.transaction.findUnique({
      where: { id: draft.id },
    });
    if (transactionRow === null) {
      await this.restoreBalance(partner.id, amountMinor);
      throw new NotFoundException('Transaction draft not found');
    }
    try {
      const { syncJobs } =
        await this.paymentSubscriptionMutationService.applyCompletedTransaction(transactionRow);
      await this.prismaService.transaction.update({
        where: { id: draft.id },
        data: { status: TransactionStatus.COMPLETED },
      });
      for (const syncJob of syncJobs) {
        await this.profileSyncQueueService.enqueue(syncJob.id);
      }
    } catch (err: unknown) {
      await this.restoreBalance(partner.id, amountMinor);
      this.logger.error(
        `Partner-balance payment fulfillment failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }

    this.events.info(
      EVENT_TYPES.PARTNER_BALANCE_ADJUSTED,
      'PARTNER',
      `Partner paid ${draft.amount} ${balanceCurrency} from balance`,
      { userId: user.id, amountMinor, purchaseType: input.purchaseType, paymentId: draft.paymentId },
    );

    const finalTransaction =
      (await this.prismaService.transaction.findUnique({ where: { id: draft.id } })) ?? transactionRow;
    return {
      paymentId: finalTransaction.paymentId,
      transactionStatus: finalTransaction.status,
      gatewayType: finalTransaction.gatewayType,
      purchaseType: finalTransaction.purchaseType,
      amount: finalTransaction.amount.toString(),
      currency: finalTransaction.currency,
      checkoutUrl: null,
      providerMode: 'NONE',
      createdAt: finalTransaction.createdAt.toISOString(),
    };
  }

  private async restoreBalance(partnerId: string, amountMinor: number): Promise<void> {
    await this.prismaService.partner
      .update({ where: { id: partnerId }, data: { balance: { increment: amountMinor } } })
      .catch((): void => undefined);
  }

  private async resolveUser(input: PartnerBalancePaymentInput): Promise<{
    readonly id: string;
    readonly partnerBalanceCurrencyOverride: Currency | null;
  }> {
    if (typeof input.userId === 'string' && input.userId.length > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: { id: true, partnerBalanceCurrencyOverride: true },
      });
      if (user === null) throw new NotFoundException('User not found');
      return user;
    }
    if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(input.telegramId) },
        select: { id: true, partnerBalanceCurrencyOverride: true },
      });
      if (user === null) throw new NotFoundException('User not found');
      return user;
    }
    throw new NotFoundException('A userId or telegramId is required');
  }
}

function toExactMinorUnits(amount: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function mapPurchaseTypeToAccessGate(purchaseType: PurchaseType): AccessModeGate {
  switch (purchaseType) {
    case PurchaseType.UPGRADE:
      return 'purchase.upgrade';
    case PurchaseType.RENEW:
      return 'purchase.renewal';
    case PurchaseType.NEW:
    case PurchaseType.ADDITIONAL:
    default:
      return 'purchase.new';
  }
}
