import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Transaction, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { ReferralQualificationService } from '../../referrals/services/referral-qualification.service';
import {
  PAYMENT_WEBHOOK_STATUS_FAILED,
  PaymentWebhookInboxService,
} from './payment-webhook-inbox.service';
import { normalizePaymentProviderError } from '../utils/payment-provider-error.util';
import { PaymentOpsAlertService } from './payment-ops-alert.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly paymentOpsAlertService: PaymentOpsAlertService,
    private readonly partnerEarningsService: PartnerEarningsService,
    private readonly referralQualificationService: ReferralQualificationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
  ) {}

  public async reconcileWebhookEvent(eventId: string): Promise<void> {
    const event = await this.prismaService.paymentWebhookEvent.findUnique({
      where: { id: eventId },
    });
    if (event === null) {
      throw new NotFoundException('Payment webhook event not found');
    }
    await this.paymentWebhookInboxService.incrementReconciliationAttempts(event.id);
    await this.paymentWebhookInboxService.markProcessing(event.id);
    try {
      const transaction = await this.findTransactionForEvent(event.paymentId);
      if (isTerminalTransaction(transaction)) {
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }

      const nextStatus = mapProviderStatusToTransactionStatus(event.eventStatus);
      await this.prismaService.transaction.update({
        where: { id: transaction.id },
        data: {
          status: nextStatus,
          gatewayData: mergeGatewayData(transaction.gatewayData, {
            providerStatus: event.eventStatus,
            reconciledAt: new Date().toISOString(),
          }) as Prisma.InputJsonValue,
        },
      });

      if (nextStatus === TransactionStatus.COMPLETED) {
        const refreshedTransaction = await this.prismaService.transaction.findUnique({
          where: { id: transaction.id },
        });
        if (refreshedTransaction === null) {
          throw new NotFoundException('Payment transaction not found');
        }
        if (refreshedTransaction.subscriptionId === null) {
          const { syncJob } =
            await this.paymentSubscriptionMutationService.applyCompletedTransaction(refreshedTransaction);
          // Push the freshly-created sync job to BullMQ so the Remnawave
          // profile is provisioned immediately. Without this the row would
          // sit PENDING until the profile-sync sweep cron picks it up.
          await this.profileSyncQueueService.enqueue(syncJob.id);
        }
        await this.runReferralAndPartnerHooks(refreshedTransaction);
      }

      await this.paymentWebhookInboxService.markProcessed(event.id);
    } catch (error: unknown) {
      const failedEvent = await this.paymentWebhookInboxService.markFailed(
        event.id,
        normalizePaymentProviderError(error, PAYMENT_WEBHOOK_STATUS_FAILED),
      );
      await this.paymentOpsAlertService.notifyWebhookFailed({
        event: failedEvent,
      });
      throw error;
    }
  }

  private async findTransactionForEvent(paymentReference: string): Promise<Transaction> {
    const transaction =
      (await this.prismaService.transaction.findUnique({
        where: { paymentId: paymentReference },
      })) ??
      (await this.prismaService.transaction.findFirst({
        where: { gatewayId: paymentReference },
      }));
    if (transaction === null) {
      throw new NotFoundException('Payment transaction not found');
    }
    return transaction;
  }

  /**
   * Runs the referral qualification + partner earnings hooks after a
   * transaction is marked COMPLETED. Errors here are logged but do not
   * propagate — a failed accrual must not roll back a successful payment
   * application. Both downstream services are idempotent on
   * `(partnerId, sourceTransactionId)` and on `referral.qualifiedAt`, so
   * a retried webhook event is safe.
   */
  private async runReferralAndPartnerHooks(transaction: Transaction): Promise<void> {
    try {
      await this.referralQualificationService.qualifyReferralAfterPurchase(transaction.id);
    } catch (error: unknown) {
      this.logger.error(
        `Referral qualification hook failed for transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      const minorUnits = decimalToMinorUnits(transaction.amount);
      await this.partnerEarningsService.processPartnerEarning({
        payerUserId: transaction.userId,
        paymentAmountMinorUnits: minorUnits,
        gatewayType: transaction.gatewayType,
        sourceTransactionId: transaction.id,
      });
    } catch (error: unknown) {
      this.logger.error(
        `Partner earnings hook failed for transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function mapProviderStatusToTransactionStatus(providerStatus: string | null): TransactionStatus {
  const normalizedStatus = String(providerStatus ?? '').toUpperCase();
  if (
    normalizedStatus === 'SUCCESSFUL_PAYMENT' ||
    normalizedStatus === 'SUCCEEDED' ||
    normalizedStatus === 'SUCCESS' ||
    normalizedStatus === 'CONFIRMED' ||
    normalizedStatus === 'PAID' ||
    normalizedStatus === 'COMPLETED'
  ) {
    return TransactionStatus.COMPLETED;
  }
  if (
    normalizedStatus === 'REFUNDED_PAYMENT' ||
    normalizedStatus === 'REFUNDED'
  ) {
    return TransactionStatus.CANCELED;
  }
  if (
    normalizedStatus === 'CANCELED' ||
    normalizedStatus === 'CANCELLED' ||
    normalizedStatus === 'FAILED' ||
    normalizedStatus === 'FAIL' ||
    normalizedStatus === 'EXPIRED' ||
    normalizedStatus === 'DECLINED'
  ) {
    return TransactionStatus.CANCELED;
  }
  return TransactionStatus.PENDING;
}

function isTerminalTransaction(transaction: Transaction): boolean {
  return (
    transaction.status === TransactionStatus.COMPLETED ||
    transaction.status === TransactionStatus.CANCELED ||
    transaction.status === TransactionStatus.FAILED
  );
}


function mergeGatewayData(
  currentValue: Transaction['gatewayData'],
  nextValue: Record<string, unknown>,
): Record<string, unknown> {
  const currentRecord =
    typeof currentValue === 'object' && currentValue !== null && !Array.isArray(currentValue)
      ? (currentValue as Record<string, unknown>)
      : {};
  return {
    ...currentRecord,
    ...nextValue,
  };
}

/**
 * Convert a `Decimal(20, 8)` major-unit transaction amount into the
 * minor-unit integer (kopecks/cents) accepted by `PartnerEarningsService`.
 * The product preserves up to two decimal places and floors anything
 * smaller — partner accruals must never round in the user's favour above
 * the integer ledger granularity.
 */
function decimalToMinorUnits(amount: Prisma.Decimal): number {
  const minor = amount.mul(100).toFixed(0, Prisma.Decimal.ROUND_FLOOR);
  return Number(minor);
}
