import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PaymentGatewayType,
  Prisma,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
  Transaction,
  TransactionStatus,
} from '@prisma/client';

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
import { SavedPaymentMethodService } from './saved-payment-method.service';
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
    private readonly savedPaymentMethodService: SavedPaymentMethodService,
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
      await this.disablePermissionRevokedAutopayBestEffort(transaction, event.rawPayload, nextStatus);

      // Refund / chargeback on an already-fulfilled payment: the provider is
      // telling us a COMPLETED payment was reversed. This MUST undo the
      // side-effects fulfillment produced (partner accruals, referral rewards,
      // МойНалог income, ad conversion) — otherwise the platform keeps paying
      // out on money it no longer has. Handled here explicitly because the
      // block below would otherwise early-return and silently swallow it.
      if (
        isRefundProviderStatus(event.eventStatus) &&
        transaction.status === TransactionStatus.COMPLETED &&
        transaction.fulfilledAt !== null
      ) {
        await this.handleRefundReversal(transaction, event.eventStatus, event.rawPayload);
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }

      // COMPLETED is final only after durable fulfillment. A captured payment
      // whose mutation rolled back has fulfilledAt=null and must be retried by
      // the next webhook/manual replay instead of being marked processed.
      if (
        transaction.status === TransactionStatus.COMPLETED &&
        transaction.fulfilledAt !== null
      ) {
        // Crash recovery only: NEW payments claim fulfilledAt before
        // applyCompleted stamps subscriptionId. A *stale* claim (lease expired)
        // with no subscription means provision never finished — release and
        // fall through. A *fresh* claim means checkout is still provisioning;
        // do NOT clear it or we race double-fulfill with the live path.
        const claimAgeMs =
          transaction.fulfilledAt instanceof Date
            ? Date.now() - transaction.fulfilledAt.getTime()
            : Number.POSITIVE_INFINITY;
        const STALE_CLAIM_MS = 2 * 60 * 1000;
        if (
          transaction.purchaseType === 'NEW' &&
          transaction.subscriptionId === null &&
          claimAgeMs >= STALE_CLAIM_MS
        ) {
          this.logger.warn(
            `Recovering stale incomplete fulfillment claim for transaction ${transaction.id} (ageMs=${claimAgeMs})`,
          );
          // Fence on the observed lease timestamp so we never clear a newer
          // claim that was written after this worker loaded the row.
          await this.prismaService.transaction.updateMany({
            where: { id: transaction.id, fulfilledAt: transaction.fulfilledAt },
            data: { fulfilledAt: null },
          });
        } else if (
          transaction.purchaseType === 'NEW' &&
          transaction.subscriptionId === null &&
          claimAgeMs < STALE_CLAIM_MS
        ) {
          // Live checkout still provisioning — do not ack the webhook or it
          // will never retry after the lease expires.
          throw new Error(
            `Fulfillment claim still in progress for transaction ${transaction.id}; retry later`,
          );
        } else {
          await this.paymentWebhookInboxService.markProcessed(event.id);
          return;
        }
      }
      // CANCELED/FAILED (e.g. auto-expired) is terminal UNLESS a late SUCCESS
      // webhook arrives — then we revive the transaction and fulfil it so a
      // genuinely-paid-but-late payment is never lost.
      if (isTerminalTransaction(transaction) && nextStatus !== TransactionStatus.COMPLETED) {
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }
      if (
        transaction.status !== TransactionStatus.COMPLETED &&
        isTerminalTransaction(transaction) &&
        nextStatus === TransactionStatus.COMPLETED
      ) {
        this.logger.warn(
          `Reviving ${transaction.status} transaction ${transaction.id} on a late SUCCESS webhook`,
        );
      }

      // Backfill the provider payment id when checkout never persisted it (the
      // process can die between the provider's 200 and the follow-up update, and
      // the payment webhook still fulfils the row because it keys on our own
      // `metadata.paymentId`). A later `refund.succeeded` references ONLY the
      // provider id, so without this the refund can't find the transaction and
      // its payouts would never be reversed.
      const gatewayIdBackfill = resolveYookassaGatewayIdBackfill(
        transaction.gatewayType,
        event.rawPayload,
        transaction.gatewayId,
      );
      await this.prismaService.transaction.update({
        where: { id: transaction.id },
        data: {
          status: nextStatus,
          ...(gatewayIdBackfill !== null ? { gatewayId: gatewayIdBackfill } : {}),
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
        const claimedAt = new Date();
        const claim = await this.prismaService.transaction.updateMany({
          where: { id: refreshedTransaction.id, fulfilledAt: null },
          data: { fulfilledAt: claimedAt },
        });
        if (claim.count === 1) {
          let syncJobs;
          try {
            ({ syncJobs } =
              await this.paymentSubscriptionMutationService.applyCompletedTransaction(refreshedTransaction));
          } catch (provisionError: unknown) {
            // Provisioning failed BEFORE commit (the subscription create/renew
            // tx rolled back; post-commit side effects are best-effort and never
            // throw). Release only this lease so a BullMQ retry / late webhook
            // can re-provision without erasing a newer concurrent claim.
            await this.prismaService.transaction
              .updateMany({
                where: { id: refreshedTransaction.id, fulfilledAt: claimedAt },
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
        // Saved method + referral/partner/МойНалог/ads — always best-effort after
        // a SUCCESS status (even if this worker lost the fulfill claim).
        await this.runPostFulfillmentHooks(refreshedTransaction, event.rawPayload);
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

  /**
   * Shared post-completion side effects (saved method, referrals, partner,
   * МойНалог, ad conversion). Safe to call after entitlement has been applied
   * by either webhook reconciliation or the pending-expiry poll path.
   */
  public async runPostFulfillmentHooks(
    transaction: Transaction,
    rawPayload?: unknown,
  ): Promise<void> {
    if (rawPayload !== undefined) {
      await this.persistSavedPaymentMethodBestEffort(transaction, rawPayload);
    }
    await this.runReferralAndPartnerHooks(transaction);
    await this.enqueueMoyNalogIncomeBestEffort(transaction);
    await this.recordAdConversionBestEffort(transaction);
  }

  /**
   * {@link runPostFulfillmentHooks} for the paths that fulfil a payment inline
   * and answer an HTTP request: the money is already captured and the
   * entitlement already granted, so a hook failure must never surface as a
   * failed checkout. Every individual hook already swallows its own errors —
   * this is the belt for anything thrown between them.
   *
   * Safe to call more than once for the same transaction: partner accrual is
   * keyed on (partnerId, sourceTransactionId), the МойНалог job id is derived
   * from the transaction id, and the ad conversion is unique per user.
   */
  public async runPostFulfillmentHooksBestEffort(transaction: Transaction): Promise<void> {
    try {
      await this.runPostFulfillmentHooks(transaction);
    } catch (error: unknown) {
      this.logger.error(
        `Post-fulfilment hooks failed for transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Reverses every side-effect a COMPLETED payment produced, after a refund /
   * chargeback. Symmetric counterpart to {@link runPostFulfillmentHooks}:
   *   - partner accruals debited + ledger rows removed,
   *   - referral qualification + rewards reversed,
   *   - МойНалог income cancellation enqueued,
   *   - ad conversion reverted.
   *
   * Idempotent end-to-end: guarded by a `refundReversedAt` stamp on the
   * transaction's `gatewayData`, and each downstream reversal is itself
   * idempotent, so a replayed refund webhook is a no-op. Each hook is
   * best-effort — one failing reversal is logged and never blocks the others,
   * mirroring the fulfillment path. The transaction is marked CANCELED and
   * stamped so the reversal is visible and never repeats.
   */
  private async handleRefundReversal(
    transaction: Transaction,
    providerStatus: string | null,
    rawPayload?: Prisma.JsonValue,
  ): Promise<void> {
    const gatewayData = asRecord(transaction.gatewayData);
    if (typeof gatewayData?.['refundReversedAt'] === 'string') {
      // Already reversed — idempotent no-op on a replayed refund webhook.
      return;
    }

    // A PARTIAL refund must not run the all-or-nothing reversal: that would
    // wipe the partner's entire commission, un-qualify the referral and cancel
    // the full tax income over what may be a small giveback. We can only tell
    // the difference when the provider reports the refunded amount (YooKassa
    // does); when it doesn't, the historical full-reversal behaviour stands.
    // Refunds ACCUMULATE. Comparing only this event's amount would mean two
    // 500-of-1000 refunds both land in the partial branch: the customer is made
    // whole while the partner commission, referral qualification, tax income and
    // subscription are never reversed. Track the running total in the same key
    // the operator-initiated refund path writes (`refundedAmountTotal`) and
    // reverse once it reaches the captured amount.
    const refundedAmount = resolveRefundedAmount(rawPayload);
    const paidAmount = Number(transaction.amount.toString());
    const previouslyRefunded = readRefundedTotal(gatewayData);
    const cumulativeRefunded =
      refundedAmount === null ? null : previouslyRefunded + refundedAmount;
    if (
      cumulativeRefunded !== null &&
      Number.isFinite(paidAmount) &&
      paidAmount > 0 &&
      cumulativeRefunded < paidAmount - 0.000001
    ) {
      this.logger.warn(
        `Partial refund on transaction ${transaction.id} (${cumulativeRefunded} of ${paidAmount} ` +
          `after this ${refundedAmount}) — side-effects left intact; operator review required`,
      );
      await this.prismaService.transaction.update({
        where: { id: transaction.id },
        data: {
          gatewayData: mergeGatewayData(transaction.gatewayData, {
            providerStatus,
            partialRefundAt: new Date().toISOString(),
            refundedAmountTotal: cumulativeRefunded.toFixed(2),
            refundNeedsManualReview: true,
          }) as Prisma.InputJsonValue,
        },
      });
      this.systemEvents.warn(
        EVENT_TYPES.PAYMENT_REFUND_PARTIAL,
        'PAYMENT',
        // Operator-facing detail lives in the metadata, not the message: an
        // event type can be bound to a customer email template, whose subject
        // is the message itself.
        `Частичный возврат платежа: ${transaction.purchaseType}`,
        {
          userId: transaction.userId,
          paymentId: transaction.paymentId,
          gatewayType: transaction.gatewayType,
          amount: transaction.amount.toString(),
          refundedAmount: String(refundedAmount),
          refundedAmountTotal: cumulativeRefunded.toFixed(2),
          currency: transaction.currency,
          providerStatus,
          refund: true,
          partial: true,
          needsManualReview: true,
        },
      );
      return;
    }

    await this.reverseFulfilledPayment(transaction, providerStatus);
  }

  /**
   * Runs the full reversal for a payment the caller has already established was
   * refunded in full: partner debit, referral un-qualification, tax-income
   * cancellation, advertising-conversion revert, access revocation.
   *
   * Public because a refund issued from the admin panel must reverse the same
   * things a provider webhook does. Previously only the webhook path called it,
   * so a gateway that sends no refund event — or a refund the operator made in
   * the provider's own dashboard — left commission paid, income declared and the
   * advertising revenue standing forever.
   *
   * Idempotent: the `refundReversedAt` stamp written at the end short-circuits a
   * second run, and every downstream reversal is itself idempotent.
   */
  public async reverseFulfilledPayment(
    transaction: Transaction,
    providerStatus: string | null,
  ): Promise<void> {
    const stamped = asRecord(transaction.gatewayData);
    if (typeof stamped?.['refundReversedAt'] === 'string') {
      return;
    }

    this.logger.warn(
      `Refund/chargeback on fulfilled transaction ${transaction.id} (providerStatus=${providerStatus}) — reversing side-effects`,
    );

    // Partner accruals: debit balances + remove ledger rows.
    try {
      await this.partnerEarningsService.reverseEarningsForTransaction(transaction.id);
    } catch (error: unknown) {
      this.logger.error(
        `Partner earnings reversal failed for ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Referral qualification + rewards.
    try {
      await this.referralQualificationService.reverseQualificationForTransaction(transaction.id);
    } catch (error: unknown) {
      this.logger.error(
        `Referral reversal failed for ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // МойНалог income cancellation (async — needs the tax API).
    try {
      await this.moyNalogQueueService.enqueueCancelIncome(transaction.id);
    } catch (error: unknown) {
      this.logger.error(
        `МойНалог cancel enqueue failed for ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Ad conversion.
    try {
      await this.adConversionService.revertConversion(transaction.id);
    } catch (error: unknown) {
      this.logger.error(
        `Ad conversion revert failed for ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Revoke the access this payment paid for. Only a NEW purchase can be
    // reversed mechanically — the subscription exists *because* of this
    // transaction, so expiring it restores the pre-payment state exactly.
    // RENEW/UPGRADE mutate a subscription that predates the payment (added days,
    // switched plan), and un-mixing that from later activity is guesswork, so
    // those are surfaced for manual handling instead of being half-undone.
    const revocation = await this.revokeRefundedSubscriptionBestEffort(transaction);

    // Mark CANCELED + stamp the reversal so it is auditable and never repeats.
    await this.prismaService.transaction.update({
      where: { id: transaction.id },
      data: {
        status: TransactionStatus.CANCELED,
        gatewayData: mergeGatewayData(transaction.gatewayData, {
          providerStatus,
          refundReversedAt: new Date().toISOString(),
          subscriptionRevoked: revocation.revoked,
          ...revocation.audit,
          ...(revocation.needsManualReview ? { refundNeedsManualReview: true } : {}),
        }) as Prisma.InputJsonValue,
      },
    });

    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_REFUNDED,
      'PAYMENT',
      `Платёж возвращён (refund/chargeback): ${transaction.purchaseType}`,
      {
        userId: transaction.userId,
        paymentId: transaction.paymentId,
        gatewayType: transaction.gatewayType,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        providerStatus,
        refund: true,
        subscriptionRevoked: revocation.revoked,
        needsManualReview: revocation.needsManualReview,
      },
    );
  }

  /**
   * Expires the subscription a refunded NEW purchase created and pushes the
   * revocation to Remnawave, so a refunded customer stops consuming paid
   * capacity. Never throws: the money-side reversal above already ran and must
   * stay committed even if the panel sync can't be queued right now.
   *
   * Returns whether access was actually revoked, and whether an operator has to
   * finish the job by hand (RENEW/UPGRADE, or a purchase with no subscription
   * linked).
   */
  private async revokeRefundedSubscriptionBestEffort(transaction: Transaction): Promise<{
    revoked: boolean;
    needsManualReview: boolean;
    audit: Record<string, unknown>;
  }> {
    if (transaction.purchaseType !== 'NEW' || transaction.subscriptionId === null) {
      return { revoked: false, needsManualReview: true, audit: {} };
    }
    let jobId: string | null = null;
    let revoked = false;
    let audit: Record<string, unknown> = {};
    try {
      const now = new Date();
      // A RENEW updates the SAME subscription row and the original NEW
      // transaction keeps pointing at it forever. So a chargeback on a
      // months-old first payment would expire a subscription the customer has
      // since paid to extend. If any other completed payment touched this
      // subscription, the "restore the pre-payment state" assumption no longer
      // holds — hand it to an operator instead of burning paid-for access.
      const otherPaidCount = await this.prismaService.transaction.count({
        where: {
          subscriptionId: transaction.subscriptionId,
          status: TransactionStatus.COMPLETED,
          id: { not: transaction.id },
        },
      });
      if (otherPaidCount > 0) {
        this.logger.warn(
          `Refunded transaction ${transaction.id} targets subscription ${transaction.subscriptionId} ` +
            `with ${otherPaidCount} other completed payment(s) — leaving access intact for manual review`,
        );
        return {
          revoked: false,
          needsManualReview: true,
          audit: { refundRevocationSkippedReason: 'SUBSCRIPTION_HAS_OTHER_PAYMENTS' },
        };
      }

      const subscription = await this.prismaService.subscription.findUnique({
        where: { id: transaction.subscriptionId },
        select: { id: true, remnawaveId: true, status: true, expiresAt: true },
      });
      if (subscription === null || subscription.status === SubscriptionStatus.DELETED) {
        return { revoked: false, needsManualReview: false, audit: {} };
      }
      // An operator-imposed DISABLED (ban) outranks an automated refund
      // revocation: overwriting it with EXPIRED would quietly lift the ban.
      if (subscription.status === SubscriptionStatus.DISABLED) {
        return {
          revoked: false,
          needsManualReview: true,
          audit: { refundRevocationSkippedReason: 'SUBSCRIPTION_DISABLED' },
        };
      }
      // Hand back what we are about to overwrite, so a disputed or erroneous
      // refund can be undone by hand without guessing what the customer had.
      // The caller folds this into its single `gatewayData` write — writing it
      // here would be clobbered by that later merge (it starts from the stale
      // in-memory `transaction.gatewayData`).
      audit = {
        refundRevokedSubscriptionId: subscription.id,
        refundRevokedFromExpiresAt: subscription.expiresAt?.toISOString() ?? null,
        refundRevokedFromStatus: subscription.status,
        refundRevokedAt: now.toISOString(),
      };
      await this.prismaService.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.EXPIRED, expiresAt: now },
      });
      revoked = true;
      if (subscription.remnawaveId !== null) {
        const job = await this.prismaService.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            payload: {
              source: 'PAYMENT_REFUND',
              // No `propagateStatus`: EXPIRED is a DERIVED local state, and the
              // sync processor documents that derived states must never be
              // pushed upstream (a rejected status would retry forever). The
              // `expireAt: now` written above already cuts access.
            } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        jobId = job.id;
      }
    } catch (error: unknown) {
      this.logger.error(
        `Subscription revocation failed for refunded transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { revoked, needsManualReview: true, audit };
    }
    // Enqueue OUTSIDE the try: the row is already EXPIRED and the job row
    // exists, so a queue hiccup is recoverable by the profile-sync sweep — it
    // must not be reported as "not revoked / needs manual review".
    if (jobId !== null) {
      try {
        await this.profileSyncQueueService.enqueue(jobId);
      } catch (error: unknown) {
        this.logger.warn(
          `Refund revocation sync enqueue failed for ${transaction.id} (sweep will recover): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { revoked, needsManualReview: !revoked, audit };
  }

  private async disablePermissionRevokedAutopayBestEffort(
    transaction: Transaction,
    rawPayload: unknown,
    nextStatus: TransactionStatus,
  ): Promise<void> {
    if (transaction.gatewayType !== PaymentGatewayType.YOOKASSA || nextStatus !== TransactionStatus.CANCELED) {
      return;
    }
    const raw = asRecord(rawPayload);
    const payment = asRecord(raw?.['object']) ?? raw;
    const details = asRecord(payment?.['cancellation_details']);
    const reason = typeof details?.['reason'] === 'string' ? details['reason'] : null;
    if (reason === null || !reason.toLowerCase().includes('permission_revoked')) {
      return;
    }
    const gatewayData = asRecord(transaction.gatewayData);
    const paymentMethod = asRecord(payment?.['payment_method']);
    const providerMethodId =
      (typeof gatewayData?.['paymentMethodId'] === 'string' && gatewayData['paymentMethodId'].length > 0
        ? gatewayData['paymentMethodId']
        : null) ??
      (typeof paymentMethod?.['id'] === 'string' && paymentMethod['id'].length > 0
        ? paymentMethod['id']
        : null);
    if (providerMethodId === null) {
      return;
    }
    try {
      await this.savedPaymentMethodService.disableAutopayForProviderMethod({
        userId: transaction.userId,
        gatewayType: PaymentGatewayType.YOOKASSA,
        providerMethodId,
        reason,
      });
    } catch (error: unknown) {
      this.logger.error(
        `Could not disable revoked autopay method for ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
   * Best-effort persistence of a reusable provider payment method after a
   * successful payment. Failures are logged and never rethrown — a missing
   * saved method must not roll back subscription fulfillment.
   */
  private async persistSavedPaymentMethodBestEffort(
    transaction: Transaction,
    rawPayload: unknown,
  ): Promise<void> {
    if (transaction.gatewayType !== PaymentGatewayType.YOOKASSA) {
      return;
    }
    try {
      await this.savedPaymentMethodService.upsertFromYookassaPayment({
        userId: transaction.userId,
        transactionId: transaction.id,
        gatewayId: transaction.gatewayId,
        rawPayload,
      });
    } catch (error: unknown) {
      this.logger.error(
        `Saved payment method persistence failed for transaction ${transaction.id}: ${
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

/**
 * Running total already refunded against a transaction, as recorded by earlier
 * refund events and by operator-initiated refunds. Shared key so both writers
 * agree; unreadable/absent values count as zero.
 */
function readRefundedTotal(gatewayData: Record<string, unknown> | null): number {
  const raw = gatewayData?.['refundedAmountTotal'];
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Amount actually refunded, when the provider reports it on the refund event
 * (YooKassa's refund object carries `amount: { value, currency }`). `null` when
 * the payload doesn't say — callers then treat the refund as full, preserving
 * the pre-existing behaviour for providers that only signal a status.
 */
function resolveRefundedAmount(rawPayload: Prisma.JsonValue | undefined): number | null {
  if (rawPayload === undefined) return null;
  const payload = asRecord(rawPayload);
  if (payload === null) return null;
  const refundObject = asRecord(payload['object']);
  if (refundObject === null) return null;
  const amount = asRecord(refundObject['amount']);
  if (amount === null) return null;
  const value = amount['value'];
  const parsed =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Provider payment id to write back onto a YooKassa transaction whose
 * `gatewayId` was never persisted (null, or still holding the checkout claim
 * marker). Only `payment.*` notifications carry the payment object — a
 * `refund.succeeded` object's `id` is the REFUND id and must never land here.
 * Returns `null` when there is nothing to backfill.
 */
function resolveYookassaGatewayIdBackfill(
  gatewayType: PaymentGatewayType,
  rawPayload: Prisma.JsonValue,
  currentGatewayId: string | null,
): string | null {
  if (gatewayType !== PaymentGatewayType.YOOKASSA) return null;
  if (
    typeof currentGatewayId === 'string' &&
    currentGatewayId.length > 0 &&
    !currentGatewayId.startsWith('__')
  ) {
    return null;
  }
  const payload = asRecord(rawPayload);
  if (payload === null) return null;
  const eventName = payload['event'];
  if (typeof eventName !== 'string' || !eventName.startsWith('payment.')) return null;
  const paymentObject = asRecord(payload['object']);
  if (paymentObject === null) return null;
  const providerId = paymentObject['id'];
  return typeof providerId === 'string' && providerId.length > 0 ? providerId : null;
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
    normalizedStatus === 'REFUNDED' ||
    // Heleket / Cryptomus emit the raw `refund_paid` on a completed refund.
    normalizedStatus === 'REFUND_PAID'
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

/**
 * True when the provider status specifically signals a REFUND / CHARGEBACK
 * (as opposed to an ordinary decline/cancel/expiry). A refund on an
 * already-fulfilled payment must reverse side-effects; a plain cancel/expiry
 * of a never-completed payment must not.
 */
function isRefundProviderStatus(providerStatus: string | null): boolean {
  const normalized = String(providerStatus ?? '').toUpperCase();
  return (
    normalized === 'REFUNDED' ||
    normalized === 'REFUNDED_PAYMENT' ||
    // Heleket / Cryptomus completed-refund status (`refund_paid`). `refund_process`
    // is intentionally NOT here — an in-flight refund must not reverse yet.
    normalized === 'REFUND_PAID' ||
    normalized === 'CHARGEBACK' ||
    normalized === 'REVERSED'
  );
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
