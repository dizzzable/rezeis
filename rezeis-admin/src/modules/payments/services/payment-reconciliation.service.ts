import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentGatewayType, Prisma, Transaction, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { ReferralQualificationService } from '../../referrals/services/referral-qualification.service';
import {
  PAYMENT_WEBHOOK_STATUS_FAILED,
  PaymentWebhookInboxService,
} from './payment-webhook-inbox.service';
import { normalizePaymentProviderError } from '../utils/payment-provider-error.util';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { PaymentOpsAlertService } from './payment-ops-alert.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';
import { MoyNalogQueueService } from './moy-nalog-queue.service';
import { AdConversionService } from '../../advertising/services/ad-conversion.service';
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
    private readonly systemEvents: SystemEventsService,
    private readonly moyNalogQueueService: MoyNalogQueueService,
    private readonly adConversionService: AdConversionService,
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
      const nextStatus = mapProviderStatusToTransactionStatus(event.eventStatus);

      // A COMPLETED transaction is final — never re-process (idempotent).
      if (transaction.status === TransactionStatus.COMPLETED) {
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }
      // CANCELED/FAILED (e.g. auto-expired) is terminal UNLESS a late SUCCESS
      // webhook arrives — then we revive the transaction and fulfil it so a
      // genuinely-paid-but-late payment is never lost.
      if (isTerminalTransaction(transaction) && nextStatus !== TransactionStatus.COMPLETED) {
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }
      if (
        isTerminalTransaction(transaction) &&
        nextStatus === TransactionStatus.COMPLETED
      ) {
        this.logger.warn(
          `Reviving ${transaction.status} transaction ${transaction.id} on a late SUCCESS webhook`,
        );
      }

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
        // Fulfil exactly once, keyed on `fulfilledAt` — NOT on `subscriptionId`.
        // RENEW/UPGRADE carry the SOURCE subscription id from draft time, so the
        // old `subscriptionId === null` guard silently skipped their provisioning
        // (money captured, nothing delivered).
        //
        // Atomically CLAIM fulfilment: flip `fulfilledAt` from null in a single
        // conditional UPDATE. Only the worker whose update matched (count === 1)
        // provisions — this prevents a double-provision when two distinct
        // webhook events for the same payment (or a manual replay racing a live
        // callback) are reconciled concurrently (processor concurrency > 1, and
        // the api + worker containers both run this processor).
        const claim = await this.prismaService.transaction.updateMany({
          where: { id: refreshedTransaction.id, fulfilledAt: null },
          data: { fulfilledAt: new Date() },
        });
        if (claim.count === 1) {
          let syncJobs;
          try {
            ({ syncJobs } =
              await this.paymentSubscriptionMutationService.applyCompletedTransaction(refreshedTransaction));
          } catch (provisionError: unknown) {
            // Provisioning failed BEFORE commit (the subscription create/renew
            // tx rolled back; post-commit side effects are best-effort and never
            // throw). Release the claim so a BullMQ retry / late webhook can
            // re-provision instead of leaving the payment stuck paid-but-undelivered.
            await this.prismaService.transaction
              .updateMany({
                where: { id: refreshedTransaction.id, fulfilledAt: { not: null } },
                data: { fulfilledAt: null },
              })
              .catch(() => undefined);
            throw provisionError;
          }
          // Push the freshly-created sync job(s) to BullMQ so the Remnawave
          // profile is provisioned immediately. This runs AFTER the fulfilment
          // claim + provisioning have committed, and OUTSIDE the release catch
          // above — so an enqueue failure surfaces the webhook as FAILED (ops
          // visibility + retry) WITHOUT releasing the claim: the retry early-
          // returns on the now-COMPLETED transaction and the PENDING sync jobs
          // are recovered by the profile-sync sweep cron. No double-provision.
          for (const syncJob of syncJobs) {
            await this.profileSyncQueueService.enqueue(syncJob.id);
          }
        }
        await this.runReferralAndPartnerHooks(refreshedTransaction);
        await this.enqueueMoyNalogIncomeBestEffort(refreshedTransaction);
        await this.recordAdConversionBestEffort(refreshedTransaction);
      }

      if (nextStatus === TransactionStatus.FAILED) {
        this.systemEvents.warn(
          EVENT_TYPES.PAYMENT_FAILED,
          'PAYMENT',
          `Платёж не прошёл: ${transaction.purchaseType}`,
          {
            userId: transaction.userId,
            paymentId: transaction.paymentId,
            gatewayType: transaction.gatewayType,
            amount: transaction.amount.toString(),
            currency: transaction.currency,
          },
        );
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

  /**
   * Best-effort enqueue of «Мой Налог» self-employed income registration for
   * a completed YooKassa payment. Gated on the YooKassa gateway having
   * self-employed sync enabled so we don't queue no-op jobs. Every failure
   * (read or enqueue) is logged and swallowed — registering income must never
   * block, delay, or roll back subscription fulfillment.
   */
  private async enqueueMoyNalogIncomeBestEffort(transaction: Transaction): Promise<void> {
    if (transaction.gatewayType !== PaymentGatewayType.YOOKASSA) {
      return;
    }
    try {
      const gateway = await this.prismaService.paymentGateway.findUnique({
        where: { type: PaymentGatewayType.YOOKASSA },
      });
      if (gateway === null) {
        return;
      }
      const settings = readGatewaySettings(gateway.settings);
      if (settings.selfEmployedEnabled !== true) {
        return;
      }
      await this.moyNalogQueueService.enqueueRegisterIncome(transaction.id);
    } catch (error: unknown) {
      this.logger.error(
        `МойНалог enqueue failed for transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Records the first-purchase advertising conversion for an attributed user.
   * Best-effort: registering a marketing conversion must never block, delay, or
   * roll back subscription fulfillment.
   */
  private async recordAdConversionBestEffort(transaction: Transaction): Promise<void> {
    try {
      await this.adConversionService.recordFirstPurchase({
        id: transaction.id,
        userId: transaction.userId,
        amount: transaction.amount,
        currency: transaction.currency,
        completedAt: transaction.updatedAt,
      });
    } catch (error: unknown) {
      this.logger.error(
        `ad conversion record failed for transaction ${transaction.id}: ${
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
