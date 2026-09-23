import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PaymentGatewayType,
  PaymentWebhookEvent,
  Prisma,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
  Transaction,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { planNamesFromTransactionSnapshot } from '../../../common/utils/plan-snapshot.util';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { UserNotificationsService } from '../../notifications/services/user-notifications.service';
import { PointsCashbackService } from '../../points/services/points-cashback.service';
import {
  ReferralPurchaseOutcome,
  ReferralQualificationService,
} from '../../referrals/services/referral-qualification.service';
import {
  PAYMENT_WEBHOOK_STATUS_FAILED,
  PaymentWebhookInboxService,
} from './payment-webhook-inbox.service';
import {
  NotifiedMoneyInterface,
  resolveNotifiedMoney,
} from './payment-webhook-normalizer.service';
import { normalizePaymentProviderError } from '../utils/payment-provider-error.util';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import {
  isRefundReversalClaimHeld,
  lockTransactionRefundLedger,
  readRefundLedger,
  readRefundedTotal,
  REFUND_REVERSAL_CLAIMED_AT_KEY,
} from '../utils/payment-refund-ledger.util';
import {
  AUTO_RENEW_IDEMPOTENCY_PREFIX,
  type AutopayRefundOutcome,
  describeAutopayOutcome,
  NO_AUTOPAY,
  readProviderChargeMarker,
  refundEndsAutopay,
  SAVED_CARD_AUTOPAY_OFF_AT_KEY,
  UNKNOWN_AUTOPAY_GATEWAY,
} from '../utils/refund-autopay.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import { isTrialConversionSnapshot, isWithheldConversion } from '../utils/trial-conversion.util';
import { enqueueSyncJobsDeferringFailure } from './payment-fulfillment-claim.util';
import { PaymentOpsAlertService } from './payment-ops-alert.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';
import { MoyNalogQueueService } from './moy-nalog-queue.service';
import { AdConversionService } from '../../advertising/services/ad-conversion.service';
import { SavedPaymentMethodService } from './saved-payment-method.service';
import { YookassaPaymentVerificationService } from './yookassa-payment-verification.service';
import { ProviderSubscriptionService, readProviderSubscriptionDispute } from './provider-subscription.service';
import { releasePaidTrialClaim } from '../../subscriptions/services/trial-claim-ledger.util';
@Injectable()
export class PaymentReconciliationService implements OnModuleDestroy {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  /**
   * The ends of refunds' autopays still under way, each with the card it owes
   * (none for the panel's partial refund); see {@link trackRefundWork}.
   */
  private readonly underWay = new Map<Promise<void>, { readonly paymentId: string; readonly card: PendingRefundCard | null }>();

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
    private readonly yookassaPaymentVerificationService: YookassaPaymentVerificationService,
    private readonly pointsCashbackService: PointsCashbackService,
    /** Composes the "cashback credited" message; see {@link creditCashbackAndTellTheBuyer}. */
    private readonly userNotifications: UserNotificationsService,
    /**
     * Ends the autopay a full refund belongs to (`refundEndsAutopay`). Last and
     * optional because a dozen specs build this service positionally; the
     * module always provides it.
     */
    @Optional()
    private readonly providerSubscriptions?: ProviderSubscriptionService,
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
      // A Platega dispute of a subscription charge (`recordDispute`) names no
      // payment of ours: the subscription's charges tell which one it is. Run
      // here, in the inbox's own run, so a Platega API that does not answer
      // leaves it FAILED — retried, counted on the dashboard, replayable from
      // «Платежи» → «Вебхуки» — and never drops it.
      const dispute = readProviderSubscriptionDispute(event.rawPayload);
      if (dispute !== null) {
        if (this.providerSubscriptions === undefined) {
          throw new ServiceUnavailableException('Provider subscriptions are not available to settle a dispute');
        }
        await this.providerSubscriptions.handleChargeback(
          event.gatewayType,
          dispute.providerSubscriptionId,
          dispute.chargeback,
        );
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }
      const transaction = await this.findTransactionForEvent(event.paymentId, event.gatewayType);
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

      // A payment imported from another bot was settled THERE: the donor took
      // the money, delivered what it bought and paid out what it earned — the
      // inviter's reward, the partner's commission, the cashback. The row is on
      // record so an operator can see who they are dealing with, never to be
      // acted on: the plan it names is not a plan here, and paying its side
      // effects again would pay them twice. So whatever the provider says about
      // it now, the answer is "already settled" — nothing is written, claimed,
      // provisioned or paid, and the event is closed as processed rather than
      // failed, so nothing alerts and the auto-retry has nothing to retry.
      //
      // Decided on the import marker and NOT on `fulfilledAt`. Rows imported
      // before the importers stamped it are still null until the backfill runs,
      // and the backfill can be interrupted; and the stale-claim branch below
      // used to CLEAR an old stamp on a NEW row with no subscription — every
      // imported payment — and then fulfil it again.
      //
      // Below the refund branch on purpose: what a refund of a donor's payment
      // should do is an open decision, and this leaves it exactly as it was.
      const importedFrom = importedPaymentSource(transaction);
      if (importedFrom !== null) {
        this.logger.log(
          `Payment notification ${event.id} (${event.eventStatus ?? 'no status'}) resolves to transaction ` +
            `${transaction.id}, imported from ${importedFrom} and settled there — acknowledged, nothing applied`,
        );
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }

      // The buyer paid, but not what we asked (Cryptomus/Heleket
      // `wrong_amount`, Pally `UNDERPAID`), or the provider is holding the
      // funds (`locked`). The money is ours; the entitlement is not automatic.
      // Handled here, ahead of the status write, because there is no status
      // that says this: the mapper returns PENDING and the row would then be
      // indistinguishable from a checkout nobody ever paid for.
      if (isAmountMismatchProviderStatus(event.eventStatus)) {
        await this.flagAmountMismatchForReview(transaction, event.eventStatus, event.rawPayload);
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
        // Crash recovery only: a payment that CREATES its subscription — NEW,
        // and ADDITIONAL (a second subscription, or an add-on) — claims
        // fulfilledAt before applyCompleted stamps subscriptionId, and its draft
        // records none, so a claim without one never finished. A *stale* claim
        // (lease expired) is released and falls through. A *fresh* claim means
        // checkout is still provisioning; do NOT clear it or we race
        // double-fulfill with the live path. ADDITIONAL joined NEW once its
        // draft stopped recording the buyer's latest subscription: before, the
        // claim carried that id and read as finished, and a crash between claim
        // and commit left the payment acknowledged and undelivered for good.
        const claimAgeMs =
          transaction.fulfilledAt instanceof Date
            ? Date.now() - transaction.fulfilledAt.getTime()
            : Number.POSITIVE_INFINITY;
        const STALE_CLAIM_MS = 2 * 60 * 1000;
        const createsItsSubscription =
          transaction.purchaseType === 'NEW' || transaction.purchaseType === 'ADDITIONAL';
        if (
          createsItsSubscription &&
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
          createsItsSubscription &&
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
        if (
          nextStatus === TransactionStatus.CANCELED ||
          nextStatus === TransactionStatus.FAILED
        ) {
          await releasePaidTrialClaim(
            this.prismaService,
            transaction.id,
            `PROVIDER_TERMINAL_${nextStatus}`,
          );
        }
        await this.paymentWebhookInboxService.markProcessed(event.id);
        return;
      }
      // A payment refunded in full is not revived by a success notification.
      //
      // The revival below exists for a checkout the expiry sweep cancelled that
      // was paid late. A refunded payment is CANCELED too, and a success
      // notification processed after the refund — an operator's replay, or the
      // inbox retrying a run that had failed — revived it to COMPLETED and ran
      // its post-payment hooks again. Checked on PostgreSQL with the real
      // services: the reversal had deleted the partner's accrual, so the hook
      // paid the commission a second time on money that had gone back; the
      // referral reward, keyed on a row the reversal keeps, was not paid again.
      //
      // So the notification is acknowledged and nothing changes: status, stamp
      // and hooks stay as the refund left them. An operator hears about it only
      // when the provider itself says the payment is paid after the refund —
      // see `providerSaysPaidAfterRefund` for what counts.
      const refundedAt = nextStatus === TransactionStatus.COMPLETED ? refundedInFullAt(transaction) : null;
      if (refundedAt !== null) {
        const paidAgain = providerSaysPaidAfterRefund(event, transaction, refundedAt);
        this.logger.log(
          `Success notification ${event.id} for transaction ${transaction.id}, refunded in full, acknowledged — ` +
            `not revived (${paidAgain ? 'the provider reports it paid after the refund' : 'no new claim of payment from the provider'})`,
        );
        if (paidAgain) {
          // A withheld payment's money is the operator's business alone — no
          // sale or refund of it was ever announced — so it is told as one more
          // `payment.withheld` (operator-only), not as a mismatch every rule and
          // integration bound to one would hear.
          const withheld = isWithheldConversion(transaction.gatewayData);
          this.systemEvents.warn(
            withheld ? EVENT_TYPES.PAYMENT_WITHHELD : EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH,
            'PAYMENT',
            // Operator-facing detail lives in the metadata, not the message: an
            // event type can be bound to a customer email template, whose
            // subject is the message itself.
            `Возвращённый платёж снова оплачен у провайдера: ${transaction.purchaseType}`,
            {
              userId: transaction.userId,
              paymentId: transaction.paymentId,
              ...planNamesFromTransactionSnapshot(transaction.planSnapshot),
              gatewayType: transaction.gatewayType,
              amount: transaction.amount.toString(),
              currency: transaction.currency,
              providerStatus: event.eventStatus,
              paidAfterRefund: true,
              needsManualReview: true,
              ...(withheld ? { conversionWithheld: true } : {}),
            },
          );
        }
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

      // The provider payment id the notification claims, resolved once and
      // BEFORE the verification gate because both sides of that gate need it:
      // the status write backfills it onto the row, and the branch that cannot
      // reach the provider records it as evidence for whoever picks the row up.
      //
      // Backfilled at all because checkout can die between the provider's 200
      // and the follow-up update, leaving `gatewayId` null while the payment
      // webhook still fulfils the row (it keys on our own `metadata.paymentId`).
      // A later `refund.succeeded` references ONLY the provider id, so without
      // this the refund can't find the transaction and its payouts would never
      // be reversed.
      const gatewayIdBackfill = resolveYookassaGatewayIdBackfill(
        transaction.gatewayType,
        event.rawPayload,
        transaction.gatewayId,
      );

      // Ask YooKassa whether it agrees, BEFORE anything is written.
      //
      // YooKassa signs nothing; its published source-IP list is the entire
      // authentication of "this payment succeeded". That check leans on
      // Express's `trust proxy` boundary (`uniquelocal` — all of RFC1918), and
      // the API container is exposed on a shared external Docker bridge
      // alongside reiwa and Remnawave. A workload on that bridge reaches this
      // route directly, its socket address is private, so `X-Forwarded-For` is
      // honoured, so it names a YooKassa IP and is believed. The internet-facing
      // path is genuinely safe; the shared-network one had no signature anywhere
      // in it.
      //
      // YooKassa documents TWO verification steps and we only ever did the
      // first. This is the second: re-fetch the payment and let the provider
      // itself say. It sidesteps the trust-proxy question entirely, and unlike
      // reading `request.socket.remoteAddress` it does not break real deliveries
      // the moment a legitimate proxy fronts the webhook.
      //
      // Gated on gateway AND on a COMPLETED verdict: this is the only gateway
      // with no signature at all, and only a completion moves money's worth of
      // entitlement. Every other gateway, and every non-completing YooKassa
      // event (including the refund reversal handled far above, which returns
      // before this point), costs exactly nothing — not even a settings read.
      if (
        nextStatus === TransactionStatus.COMPLETED &&
        transaction.gatewayType === PaymentGatewayType.YOOKASSA
      ) {
        const verdict = await this.yookassaPaymentVerificationService.verifyCompletion({
          transactionId: transaction.id,
          paymentId: transaction.paymentId,
          gatewayId: transaction.gatewayId,
          rawPayload: event.rawPayload,
        });
        if (verdict.outcome === 'CONTRADICTED') {
          // The provider actively disagrees (canceled), does not have the
          // payment at all, or handed back a payment belonging to a different
          // checkout. Asking again returns the same answer, so a throw would
          // only buy three auto-retries, three identical operator alerts and a
          // FAILED row — noise around the one signal that matters. Held for a
          // human instead, on the same mechanism an underpaid invoice uses.
          await this.flagUnconfirmedCompletionForReview(transaction, event.eventStatus, verdict);
          await this.paymentWebhookInboxService.markProcessed(event.id);
          return;
        }
        if (verdict.outcome === 'UNAVAILABLE') {
          // Neither fulfil (that would defeat the check) nor swallow (that would
          // lose a real payment). Throwing is what the surrounding machinery is
          // already built for: reconciliation runs in a BullMQ worker AFTER
          // ingress answered the provider 200, so this costs no provider retry
          // storm; the catch below marks the event FAILED and fires
          // `notifyWebhookFailed`; and `PaymentAutoRetryService` re-enqueues any
          // FAILED event while `reconciliationAttempts < 3`, each attempt
          // re-asking the provider. That is TWO auto-retries after this run, at
          // +5 min and +15 min plus up to the five-minute cron granularity — not
          // three: the counter is incremented at the top of EVERY run, so a
          // FAILED event never carries 0 and the ladder's "immediate" arm is
          // unreachable. A blip self-heals unattended inside that window.
          //
          // What does not self-heal is an outage outliving those two retries,
          // and the second recovery path is not the safety net it reads as:
          // `PaymentPendingExpiryService` can only poll YooKassa for a row that
          // already carries a provider payment id, and the row this branch most
          // needs to protect is precisely the one that does not — the backfill
          // above is what would have given it one. With `gatewayId` null the
          // sweep falls to its local-TTL branch and CANCELS a transaction the
          // buyer paid for. The guard below is what stops that.
          await this.guardUnconfirmedCompletionFromSweep(
            transaction,
            verdict,
            gatewayIdBackfill,
          );
          throw new ServiceUnavailableException(verdict.reason);
        }
      }

      // Defence-in-depth on the sum the provider says was paid. This ALERTS and
      // does not block: it records the disagreement and warns an operator, and
      // everything below then runs exactly as it would have.
      //
      // Not holding is the design, and it is a deliberate trade. This is NOT an
      // anti-forgery control and must never be described as one — what we charge
      // is server-derived from a plan quote and the entitlement comes from
      // `planSnapshot`, so a forger controls every field in the body and simply
      // echoes the correct amount back at no cost. All the check can ever catch
      // is an AUTHENTIC notification that disagrees with our record: a
      // provider-side pricing bug, a partial capture, a misconfigured merchant
      // account. Set that narrow true-positive value against the false
      // positive — `holdPaymentForManualReview` would leave a real paying
      // customer PENDING indefinitely, exempt from the expiry sweep, trial
      // reservation stuck RESERVED, waiting on a human to notice — and warning
      // is the only proportionate answer.
      //
      // Genuine underpayment is ALREADY blocked ahead of this, by
      // `isAmountMismatchProviderStatus` above: there the PROVIDER says
      // `wrong_amount` / `wrong_amount_waiting` / `locked` / `UNDERPAID` and the
      // branch returns before reaching here. This neither duplicates nor
      // disturbs that path.
      //
      // Gated on COMPLETED because that is the only verdict that moves
      // entitlement, and on `isRefundProviderStatus` as a belt: a YooKassa
      // `refund.succeeded` carries the REFUNDED sum in `object.amount` — the
      // object is a Refund — so comparing one would read every partial refund as
      // a shortfall. Today a refund status maps to CANCELED and cannot pass the
      // first gate at all, and a refund on a fulfilled row returned far above;
      // the second gate is what keeps that true if either ever changes.
      const notifiedAmountShortfall =
        nextStatus === TransactionStatus.COMPLETED && !isRefundProviderStatus(event.eventStatus)
          ? resolveNotifiedAmountShortfall(transaction, event.rawPayload)
          : null;

      await this.prismaService.$transaction(async (tx) => {
        // Merged in the statement, not onto the copy read at the top: the
        // provider check above is a network call, and the expiry sweep's poll,
        // another notification for this payment or a manual-review hold can
        // write this row while it runs (`writeTransactionGatewayData`).
        const written = await writeTransactionGatewayData(tx, transaction.id, {
          status: nextStatus,
          ...(gatewayIdBackfill !== null ? { gatewayId: gatewayIdBackfill } : {}),
          merge: {
            providerStatus: event.eventStatus,
            reconciledAt: new Date().toISOString(),
            // Lift the provisional sweep guard, if a previous attempt on this
            // row set one. Folded into the same write as the status it belongs
            // to, so a row can never be COMPLETED and still sitting in the
            // operator's review queue for a question this run just answered.
            ...releaseVerificationSweepGuard(transaction.gatewayData, nextStatus),
            // Folded into the status write rather than given its own UPDATE:
            // the evidence and the completion it belongs to land together, so
            // a crash between them cannot leave a warned-about payment with
            // nothing on the row to show what the provider said.
            // `paymentNeedsManualReview` is deliberately NOT among these keys
            // — that flag is what parks a row, and this must not park one.
            ...(notifiedAmountShortfall === null
              ? {}
              : {
                  notifiedAmountShortfallAt: new Date().toISOString(),
                  notifiedAmount: notifiedAmountShortfall.notifiedAmount,
                }),
          },
        });
        if (written === 0) {
          throw new NotFoundException('Payment transaction not found');
        }
        if (
          nextStatus === TransactionStatus.CANCELED ||
          nextStatus === TransactionStatus.FAILED
        ) {
          await releasePaidTrialClaim(
            tx,
            transaction.id,
            `PROVIDER_TERMINAL_${nextStatus}`,
          );
        }
      });

      // Warn once the evidence is durable, and BEFORE fulfilment — so the alert
      // exists whatever provisioning goes on to do, and an operator reading it
      // finds the discrepancy already on the row. Nothing below branches on it.
      if (notifiedAmountShortfall !== null) {
        this.alertNotifiedAmountShortfall(transaction, event.eventStatus, notifiedAmountShortfall);
      }

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
        let syncEnqueueFailure: { readonly error: unknown } | null = null;
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
          //
          // The failure is DEFERRED past the hooks below, not thrown here: that
          // same early return is why nothing would ever run them again.
          syncEnqueueFailure = await enqueueSyncJobsDeferringFailure(
            this.profileSyncQueueService,
            syncJobs,
          );
        }
        // Saved method + referral/partner/МойНалог/ads — always best-effort after
        // a SUCCESS status (even if this worker lost the fulfill claim).
        await this.runPostFulfillmentHooks(refreshedTransaction, event.rawPayload);
        if (syncEnqueueFailure !== null) throw syncEnqueueFailure.error;
      }

      if (nextStatus === TransactionStatus.FAILED) {
        this.systemEvents.warn(
          EVENT_TYPES.PAYMENT_FAILED,
          'PAYMENT',
          `Платёж не прошёл: ${transaction.purchaseType}`,
          {
            userId: transaction.userId,
            paymentId: transaction.paymentId,
            // WHAT the customer was paying for, on every card in this file.
            // The type and the amount were all an operator got: «Платёж не
            // прошёл: RENEW, 250 ₽» names neither the plan nor anything they
            // could act on. The invoice's own snapshot holds the name, and a
            // combined renewal's marker holds the names its lines were drafted
            // for — see `planNamesFromTransactionSnapshot`.
            ...planNamesFromTransactionSnapshot(transaction.planSnapshot),
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
    // Never for a payment imported from another bot: the donor already paid
    // everything these pay. Checked here as well as at the top of the webhook
    // path because this is the one door every fulfilling path goes through for
    // them — a worker that lost the fulfilment claim, the pending-expiry poll,
    // the add-on recovery sweep.
    const importedFrom = importedPaymentSource(transaction);
    if (importedFrom !== null) {
      this.logger.warn(
        `Post-fulfilment hooks not run for transaction ${transaction.id}: imported from ${importedFrom}, settled by the donor`,
      );
      return;
    }
    // Nor for a trial's conversion that was withheld — received after another
    // payment converted the trial, applied to nothing, waiting for the
    // operator's refund (`PaymentSubscriptionMutationService`, "A TRIAL
    // CONVERTS ONCE"). Nothing was sold: no commission, no referral reward, no
    // cashback, no «Мой налог» income, no ad conversion, no card saved for
    // autopay. Read from the row as it is now: every caller holds a copy from
    // before the fulfilment that withheld it.
    if (await this.isWithheldConversionNow(transaction)) {
      this.logger.warn(
        `Post-fulfilment hooks not run for transaction ${transaction.id}: a trial conversion withheld for refund`,
      );
      return;
    }
    if (rawPayload !== undefined) {
      await this.persistSavedPaymentMethodBestEffort(transaction, rawPayload);
    }
    await this.runReferralAndPartnerHooks(transaction);
    // After the referral and partner hooks on purpose: the partner check
    // inside the cashback reads the same `partner.isActive` those two just
    // consulted, and a payer who earns money must not also earn points.
    await this.creditCashbackAndTellTheBuyer(transaction);
    await this.enqueueMoyNalogIncomeBestEffort(transaction);
    await this.recordAdConversionBestEffort(transaction);
  }

  /**
   * Whether `transaction` is a trial's conversion withheld for refund, read
   * from the row as it is now. Only a conversion's draft can be one, so no
   * other payment costs a read. A read that fails counts as not withheld: the
   * hooks it would skip are never run again, while a withheld payment's are
   * reversed by the refund that settles it.
   */
  private async isWithheldConversionNow(transaction: Transaction): Promise<boolean> {
    // Two payments can be withheld at fulfilment: a trial's conversion, and an
    // autopay charge that lands after a refund ended the autopay.
    const mayBeWithheld =
      (transaction.purchaseType === 'UPGRADE' && isTrialConversionSnapshot(transaction.planSnapshot)) ||
      readProviderChargeMarker(transaction) !== null;
    if (!mayBeWithheld) {
      return false;
    }
    if (isWithheldConversion(transaction.gatewayData)) return true;
    const current = await this.prismaService.transaction
      .findUnique({ where: { id: transaction.id }, select: { gatewayData: true } })
      .catch(() => null);
    return isWithheldConversion(current?.gatewayData);
  }

  /**
   * {@link runPostFulfillmentHooks} for the paths that fulfil a payment inline
   * and answer an HTTP request: the money is already captured and the
   * entitlement already granted, so a hook failure must never surface as a
   * failed checkout. Every individual hook already swallows its own errors —
   * this is the belt for anything thrown between them.
   *
   * Safe to call more than once for the same transaction: partner accrual is
   * keyed on (partnerId, sourceTransactionId), the points cashback on
   * (CASHBACK, transactionId) in the ledger, the МойНалог job id is derived
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
   *   - points cashback taken back (floored at zero),
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
    if (typeof asRecord(transaction.gatewayData)?.['refundReversedAt'] === 'string') {
      // Already reversed — idempotent no-op on a replayed refund webhook.
      // Cheap short-circuit on the snapshot so a routine replay never opens a
      // transaction; the authoritative check is re-run under the lock below.
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
    //
    // Accumulate ONCE per refund. The panel writes the same `refundedAmountTotal`
    // key when an operator issues a refund, and the provider then sends the
    // `refund.succeeded` webhook for that very refund — so adding it here again
    // turned one 500-of-1000 giveback into a 1000 "full refund": the customer's
    // subscription expired and was revoked at Remnawave, the partner's entire
    // commission was debited and the full income cancelled at МойНалог, on
    // revenue we actually kept. Deduplicate on the PROVIDER's refund id, which
    // is the key the panel already ledgers under, so whichever of the two
    // writers gets there first is the only one that counts it.
    const { amount: refundedAmount, refundId } = resolveRefundEvent(rawPayload);
    const paidAmount = Number(transaction.amount.toString());

    // Read-modify-write UNDER the row lock, on `gatewayData` re-read INSIDE it.
    //
    // Both halves of that sentence were bugs. The read used the snapshot
    // `findTransactionForEvent` loaded at the top of `reconcileWebhookEvent` —
    // by the time we get here an operator refund can have written its own
    // ledger entry and total, and merging onto the snapshot erased them. The
    // write was a bare `update` with no fence, so even a fresh read could be
    // overtaken between reading and writing. Either way a genuine interleave (a
    // panel refund for refund-2 concurrent with the `refund.succeeded` webhook
    // for refund-1) lost one of the two entries, and with it that refund's
    // share of the total.
    //
    // The lock spans a read and a write. Everything expensive — the partial
    // WARNING, and the whole reversal (partner debit, referral
    // un-qualification, МойНалог cancellation, Remnawave revoke job,
    // subscription expiry) — runs after this transaction has committed. The
    // fenced write keeps the total right; it does not by itself keep the
    // reversal to one run — the panel's refund and this notice for it both see
    // the total full. The reversal's own claim, under the same lock, does
    // (`reverseFulfilledPayment`).
    const commit = await this.prismaService.$transaction(async (tx) => {
      const liveGatewayData = await lockTransactionRefundLedger(tx, transaction.id);
      if (typeof asRecord(liveGatewayData)?.['refundReversedAt'] === 'string') {
        // The authoritative idempotency check: a concurrent writer may have
        // reversed since the snapshot at the top of reconciliation was loaded.
        return null;
      }
      const previouslyRefunded = readRefundedTotal(liveGatewayData);
      const ledger = readRefundLedger(liveGatewayData);
      const alreadyLedgered =
        refundId !== null && ledger.some((entry) => entry.refundId === refundId);
      const cumulativeRefunded =
        refundedAmount === null
          ? null
          : refundId === null
            ? // No refund id to key on. Summing risks counting one refund twice and
              // revoking a paying customer; ignoring the amount outright would lose
              // a genuine single full refund that nothing else recorded. `max` does
              // neither — it can only ever UNDER-count, and an under-count lands in
              // the partial branch below, which leaves every side-effect intact and
              // flags the transaction for manual review rather than destroying
              // anything. In practice only YooKassa reports an amount at all, and
              // its refund object always carries an id, so this is the malformed-
              // payload path, not a routine one.
              Math.max(previouslyRefunded, refundedAmount)
            : previouslyRefunded + (alreadyLedgered ? 0 : refundedAmount);
      // Record this refund in the id-keyed ledger the panel maintains. Without it
      // the race just moves to the other side: when the operator's HTTP call
      // finishes AFTER the webhook, the panel re-reads `gatewayData`, finds no
      // entry for the refund it just issued, counts it a second time and performs
      // the full reversal itself.
      const newLedgerEntry =
        refundId !== null && !alreadyLedgered && refundedAmount !== null
          ? { refundId, amount: refundedAmount.toFixed(2), at: new Date().toISOString() }
          : null;
      const partial =
        cumulativeRefunded !== null &&
        Number.isFinite(paidAmount) &&
        paidAmount > 0 &&
        cumulativeRefunded < paidAmount - 0.000001;
      if (refundedAmount === null) {
        // The provider did not say how much was given back (every gateway but
        // YooKassa). There is no total and no ledger entry to fence, so skip the
        // write entirely rather than burn an UPDATE on `providerStatus` alone —
        // the reversal below writes it anyway.
        return { partial, refundedTotal: cumulativeRefunded, gatewayData: liveGatewayData };
      }
      // Written in BOTH branches, not just the partial one. The full branch used
      // to hand straight over to the reversal without recording anything, so the
      // crossing refund left no ledger entry — and a panel refund still in flight
      // would then find nothing to deduplicate against and count it twice.
      const ledgerPatch = {
        providerStatus,
        ...(cumulativeRefunded !== null
          ? { refundedAmountTotal: cumulativeRefunded.toFixed(2) }
          : {}),
        ...(newLedgerEntry !== null ? { refunds: [...ledger, newLedgerEntry] } : {}),
        ...(partial
          ? { partialRefundAt: new Date().toISOString(), refundNeedsManualReview: true }
          : {}),
      };
      // The totals are computed from the read above, under the row lock; the
      // write goes through the one writer anyway, so the row holds exactly what
      // PostgreSQL merged and no path writes `gatewayData` any other way.
      await writeTransactionGatewayData(tx, transaction.id, { merge: ledgerPatch });
      return { partial, refundedTotal: cumulativeRefunded, gatewayData: liveGatewayData };
    });
    if (commit === null) {
      return;
    }

    if (commit.partial) {
      // `partial` is only ever true with a resolved total; the fallback keeps
      // the formatting total-safe instead of asserting non-null.
      const cumulativeRefunded = commit.refundedTotal ?? 0;
      this.logger.warn(
        `Partial refund on transaction ${transaction.id} (${cumulativeRefunded} of ${paidAmount} ` +
          `after this ${refundedAmount}) — side-effects left intact; operator review required`,
      );
      // A partial refund keeps the autopay — unless the one policy says
      // otherwise (`refundEndsAutopay`).
      const autopay = refundEndsAutopay({ full: false })
        ? await this.endAutopayForRefund({ ...transaction, gatewayData: commit.gatewayData as Prisma.JsonValue })
        : NO_AUTOPAY;
      const autopayNote = describeAutopayOutcome(autopay);
      // A withheld payment's refund is the operator's alone, in part as in
      // full — see `reverseFulfilledPayment`.
      const withheld = isWithheldConversion(commit.gatewayData);
      this.systemEvents.warn(
        withheld ? EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED : EVENT_TYPES.PAYMENT_REFUND_PARTIAL,
        'PAYMENT',
        // Operator-facing detail lives in the metadata, not the message: an
        // event type can be bound to a customer email template, whose subject
        // is the message itself.
        withheld
          ? `Частичный возврат неприменённого платежа: ${transaction.purchaseType}`
          : `Частичный возврат платежа: ${transaction.purchaseType}`,
        {
          userId: transaction.userId,
          paymentId: transaction.paymentId,
          ...planNamesFromTransactionSnapshot(transaction.planSnapshot),
          gatewayType: transaction.gatewayType,
          amount: transaction.amount.toString(),
          refundedAmount: String(refundedAmount),
          refundedAmountTotal: cumulativeRefunded.toFixed(2),
          currency: transaction.currency,
          providerStatus,
          refund: true,
          partial: true,
          needsManualReview: true,
          ...(withheld ? { conversionWithheld: true } : {}),
          ...(autopayNote === null ? {} : autopayMetadata(autopay, autopayNote)),
        },
      );
      return;
    }

    // Hand over what the row held under the lock: `reverseFulfilledPayment`
    // reads its `refundReversedAt` guard from it, and the outer snapshot from
    // the top of reconciliation could be older than a concurrent reversal. Its
    // own write merges in the statement, so nothing it is handed is written back.
    await this.reverseFulfilledPayment(
      { ...transaction, gatewayData: commit.gatewayData as Prisma.JsonValue },
      providerStatus,
    );
  }

  /**
   * Holds a paid-but-short (or provider-frozen) payment for an operator.
   * Modelled on the partial-refund branch above and does the same three things:
   * refuse the automatic verdict, stamp a `*NeedsManualReview` flag, raise a
   * WARNING.
   *
   * `status` is deliberately left untouched. A PENDING row stays PENDING — it
   * must never become COMPLETED, because a partial payment must not buy a full
   * subscription — and a row the sweep already cancelled stays CANCELED, since
   * reviving it would be a lie about what the provider said. Either way the
   * operator is told the money arrived, which is the part that was missing.
   *
   * The trade-off this buys, stated plainly: `paymentNeedsManualReview` exempts
   * the row from `PaymentPendingExpiryService`, so a PENDING row now stays
   * PENDING indefinitely and its paid-trial reservation stays RESERVED — the
   * exact harm that service's own comment documents, since the quota counter
   * treats RESERVED as spent and nothing else releases it. That is acceptable
   * ONLY because the WARNING below puts a human on the row, who resolves it by
   * hand (top-up, refund, or fulfil) and releases the reservation with it. The
   * alert is the load-bearing half of the pair: the sweep exemption without it
   * would be a regression, trading a wrong cancellation for a silently stuck
   * row nobody ever looks at.
   *
   * Not routed through `PaymentOpsAlertService`: both its methods are keyed on
   * a webhook-event row and only fire when reconciliation throws, and throwing
   * here would mark a legitimately-delivered notification as failed.
   */
  private async flagAmountMismatchForReview(
    transaction: Transaction,
    providerStatus: string | null,
    rawPayload?: Prisma.JsonValue,
  ): Promise<void> {
    const notifiedAmount = readNotifiedAmountEvidence(transaction.gatewayType, rawPayload);
    await this.holdPaymentForManualReview({
      transaction,
      logMessage:
        `Amount mismatch on transaction ${transaction.id} (providerStatus=${providerStatus}, ` +
        `notified=${notifiedAmount ?? 'unknown'} of ${transaction.amount.toString()}) — ` +
        `money received, entitlement withheld; operator review required`,
      gatewayDataPatch: {
        providerStatus,
        amountMismatchAt: new Date().toISOString(),
        // The provider's own figure, so the operator sees what was actually
        // reported rather than what we asked for. `null` means the notification
        // did not say.
        notifiedAmount,
      },
      eventMessage: `Оплачена неверная сумма: ${transaction.purchaseType}`,
      eventMetadata: { notifiedAmount, providerStatus },
    });
  }

  /**
   * Holds a YooKassa completion the provider itself refused to confirm.
   *
   * This is not "we could not reach YooKassa" — that throws and retries. This is
   * YooKassa answering, and answering that the payment is canceled, unknown to
   * the shop, or a different checkout's altogether. Against a notification
   * YooKassa never signed, that is the signature of a forged `payment.succeeded`
   * from something on the shared Docker network, and there is no automated
   * verdict that can be right: fulfilling contradicts the provider, and
   * cancelling on a forgery's say-so lets the attacker kill live checkouts.
   *
   * Deliberately the SAME mechanism as an underpaid invoice rather than a
   * parallel one — `paymentNeedsManualReview` on `gatewayData`, one WARNING,
   * `status` untouched — because the operator queue that flag defines is already
   * "a money situation a human must settle", and a second flag would mean a
   * second place to remember to look. The same trade-off applies verbatim: the
   * row is exempt from `PaymentPendingExpiryService` and its paid-trial
   * reservation stays RESERVED until a human resolves it. That is the intended
   * outcome here — a checkout somebody is actively forging notifications
   * against must not be swept away as a routine abandoned cart.
   *
   * The flag does not block a genuine later payment: it is read only by the
   * expiry sweep, so a real `payment.succeeded` for the same checkout still
   * verifies and still fulfils.
   */
  private async flagUnconfirmedCompletionForReview(
    transaction: Transaction,
    claimedStatus: string | null,
    verdict: { readonly providerStatus: string | null; readonly reason: string },
  ): Promise<void> {
    await this.holdPaymentForManualReview({
      transaction,
      logMessage:
        `Unconfirmed completion on transaction ${transaction.id}: notification claimed ` +
        `${claimedStatus ?? 'unknown'} but YooKassa reports ` +
        `${verdict.providerStatus ?? 'nothing'} (${verdict.reason}) — entitlement withheld; ` +
        `operator review required`,
      gatewayDataPatch: {
        providerVerificationFailedAt: new Date().toISOString(),
        providerVerificationReason: verdict.reason,
        // What the provider actually says, kept apart from `providerStatus` —
        // that key is the notification's claim, and overwriting it would erase
        // the very disagreement this row exists to record.
        providerVerifiedStatus: verdict.providerStatus,
        notificationClaimedStatus: claimedStatus,
      },
      eventMessage: `Платёж не подтверждён провайдером: ${transaction.purchaseType}`,
      eventMetadata: {
        providerStatus: verdict.providerStatus,
        notificationClaimedStatus: claimedStatus,
        verificationReason: verdict.reason,
      },
    });
  }

  /**
   * Keeps a completion we could not confirm from being swept away while the
   * retry ladder is still working on it, and records what the notification
   * claimed while we could not check it.
   *
   * Deliberately NOT a `gatewayId` write, which is the obvious way to make the
   * sweep's YooKassa poll reachable and is not safe. That id comes from a
   * notification YooKassa never signed — the entire reason the gate above
   * exists — and `PaymentPendingExpiryService` polls whatever id it finds and
   * fulfils on a bare `succeeded`, with nothing like
   * `YookassaPaymentVerificationService.isOurPayment` binding the answer back to
   * this transaction. Storing an id an attacker chose would hand a forger the
   * fulfilment this gate just refused, one sweep tick later: name any genuinely
   * succeeded payment in this shop (their own rouble will do) and the poll
   * agrees. It would also mis-route refunds, which find a transaction by
   * `gatewayId` — a `refund.succeeded` for the attacker's own payment would then
   * reverse somebody else's. So the claim is kept under its own key, where
   * nothing polls it and nothing looks a payment up by it.
   *
   * What keeps the row alive instead is `paymentNeedsManualReview`, the one flag
   * the sweep already honours — and only for rows that actually need it. A row
   * holding a real provider id is pollable and recovers on its own; a
   * provider-create placeholder is kept rather than cancelled. `gatewayId ===
   * null` is the single shape that reaches the local-TTL cancel
   * (`payment-pending-expiry.service.ts:192`), so it is the only shape guarded.
   *
   * The exemption's usual cost — a parked row whose trial reservation stays
   * RESERVED — is bounded here in a way the verdict holds below are not: this
   * one is provisional, and {@link releaseVerificationSweepGuard} lifts it as
   * soon as a retry gets an answer and applies the completion. Nor is it silent:
   * the throw that follows marks the event FAILED and fires
   * `notifyWebhookFailed`, so the unreconciled webhook and its reason are in
   * front of an operator either way. A second, permanent operator card is
   * deliberately not raised — this condition usually retracts itself inside the
   * retry window, and an alert that mostly retracts itself is how the ones that
   * matter stop being read.
   *
   * Never throws: a guard that could not be written must not replace the outage
   * error the caller is about to raise.
   */
  private async guardUnconfirmedCompletionFromSweep(
    transaction: Transaction,
    verdict: { readonly reason: string },
    claimedGatewayId: string | null,
  ): Promise<void> {
    const sweepWouldCancelOnLocalTtl = transaction.gatewayId === null;
    if (!sweepWouldCancelOnLocalTtl && claimedGatewayId === null) {
      // Nothing to guard and nothing to record: the row carries a provider id
      // the sweep can poll, so a blip costs no write at all.
      return;
    }
    if (sweepWouldCancelOnLocalTtl) {
      this.logger.warn(
        `Holding transaction ${transaction.id} against the expiry sweep: YooKassa could not ` +
          `confirm the completion (${verdict.reason}) and the row carries no provider payment ` +
          `id, so the sweep would cancel a payment the buyer may well have made`,
      );
    }
    try {
      await writeTransactionGatewayData(this.prismaService, transaction.id, {
        merge: {
          providerVerificationUnavailableAt: new Date().toISOString(),
          providerVerificationReason: verdict.reason,
          // Kept well away from `gatewayId` — this is what the notification
          // said, not something we believe. An operator resolving the row by
          // hand needs it; no automated path may consume it.
          ...(claimedGatewayId === null ? {} : { unverifiedGatewayId: claimedGatewayId }),
          ...(sweepWouldCancelOnLocalTtl ? { paymentNeedsManualReview: true } : {}),
        },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Could not guard unconfirmed completion on transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * The single writer of the manual-review hold, shared by every "money
   * situation a human must settle" branch. One flag key, one event type, one
   * shape — the expiry sweep reads `paymentNeedsManualReview` and nothing else,
   * so a second writer drifting from this one is how a row silently loses its
   * exemption (or gains one nobody alerted on).
   */
  private async holdPaymentForManualReview(input: {
    readonly transaction: Transaction;
    readonly logMessage: string;
    readonly gatewayDataPatch: Record<string, unknown>;
    readonly eventMessage: string;
    readonly eventMetadata: Record<string, unknown>;
  }): Promise<void> {
    const { transaction } = input;
    this.logger.warn(input.logMessage);
    await writeTransactionGatewayData(this.prismaService, transaction.id, {
      merge: { ...input.gatewayDataPatch, paymentNeedsManualReview: true },
    });
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH,
      'PAYMENT',
      // Operator-facing detail lives in the metadata, not the message: an
      // event type can be bound to a customer email template, whose subject
      // is the message itself.
      input.eventMessage,
      {
        userId: transaction.userId,
        paymentId: transaction.paymentId,
        ...planNamesFromTransactionSnapshot(transaction.planSnapshot),
        gatewayType: transaction.gatewayType,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        ...input.eventMetadata,
        needsManualReview: true,
      },
    );
  }

  /**
   * Warns an operator that the sum a provider reported falls SHORT of what we
   * booked — on a payment that is completing anyway.
   *
   * Deliberately NOT routed through {@link holdPaymentForManualReview}, and the
   * difference is the point rather than an oversight. That helper's single job
   * is to stamp `paymentNeedsManualReview`, which is exactly what exempts a row
   * from `PaymentPendingExpiryService` and parks it — trial reservation still
   * RESERVED — until a human clears it. Teaching it to sometimes not hold would
   * put a conditional inside the one writer of that flag, which is the drift its
   * own docblock exists to prevent. So this stands alongside it and writes no
   * flag.
   *
   * It also gets its OWN event type, which the first cut of this did not.
   * Reusing `EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH` looked right — the queue it
   * names is already "the sum does not match" — and produced an ops card
   * indistinguishable from a held payment: `formatTelegramMessage` renders
   * `EVENT_PRESENTATION[type].title`, not the message passed here, so this
   * fulfilled payment arrived titled «⚠️ Оплачена неверная сумма» with a
   * `needsManualReview: false` metadata line as the only thing separating it
   * from money that is actually stuck. The metadata flag stays, because it is
   * what a machine reads; the type is what a human reads.
   */
  private alertNotifiedAmountShortfall(
    transaction: Transaction,
    providerStatus: string | null,
    shortfall: NotifiedAmountShortfallInterface,
  ): void {
    this.logger.warn(
      `Notified amount short of the booked sum on transaction ${transaction.id} ` +
        `(providerStatus=${providerStatus}, notified=${shortfall.notifiedAmount} of ` +
        `${shortfall.bookedAmount} ${shortfall.currency}) — entitlement granted as normal; ` +
        `operator investigation only`,
    );
    this.systemEvents.warn(
      EVENT_TYPES.PAYMENT_NOTIFIED_AMOUNT_SHORT,
      'PAYMENT',
      // Operator-facing detail lives in the metadata, not the message: an
      // event type can be bound to a customer email template, whose subject
      // is the message itself.
      `Сумма в уведомлении меньше суммы заказа: ${transaction.purchaseType}`,
      {
        userId: transaction.userId,
        paymentId: transaction.paymentId,
        ...planNamesFromTransactionSnapshot(transaction.planSnapshot),
        gatewayType: transaction.gatewayType,
        amount: shortfall.bookedAmount,
        currency: transaction.currency,
        notifiedAmount: shortfall.notifiedAmount,
        providerStatus,
        // The one bit that separates this card from the hold above: nothing was
        // withheld, so nothing is waiting on the operator.
        needsManualReview: false,
      },
    );
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
   * Runs ONCE, whichever door comes second. The run is claimed under the row
   * lock the refund writers share (`claimRefundReversal`), and a door that
   * finds it reversed, or claimed by a run still under way, runs nothing — it
   * only records what the provider said. `refundReversedAt`, written at the
   * end, could not do this alone: it is unset for the whole of a run.
   *
   * `providerStatus` is the provider's word, recorded under that lock in the
   * order the doors reach it, and never by the write that ends the reversal —
   * that write comes last whatever the order, and put an older word back over
   * a newer one. «Отметить возврат» has no word from the provider and passes
   * `recordProviderStatus: false`.
   *
   * `deferAutopay` — an operator's request: the panel's «Вернуть», «Отметить
   * возврат». Its answer does not wait on a provider: the provider
   * subscriptions are marked and the saved card switched off before it, the
   * provider is asked after it, and the card, which reports what the provider
   * did, comes after that ({@link trackRefundWork}). A request is cut at 30 s
   * (`request-timeout.middleware.ts`), and one provider may take 45 s a call:
   * the operator was told the refund failed after the money had gone back.
   */
  public async reverseFulfilledPayment(
    transaction: Transaction,
    providerStatus: string | null,
    options: { readonly recordProviderStatus?: boolean; readonly deferAutopay?: boolean } = {},
  ): Promise<void> {
    const stamped = asRecord(transaction.gatewayData);
    if (typeof stamped?.['refundReversedAt'] === 'string') {
      return;
    }
    const claimed = await this.claimRefundReversal(
      transaction.id,
      options.recordProviderStatus === false ? undefined : providerStatus,
    );
    if (!claimed) {
      this.logger.log(
        `Refund reversal of transaction ${transaction.id} is done or under way — not run again (providerStatus=${providerStatus})`,
      );
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

    // Points cashback: what this purchase credited is taken back, floored at
    // zero — the balance stops there and the shortfall goes on the ledger row.
    // Keyed on the transaction, so a replayed refund webhook is a no-op.
    await this.pointsCashbackService.reverseForTransactionBestEffort(transaction.id);

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
    //
    // Merged in the statement, not onto `transaction.gatewayData`: that copy is
    // from before every step above, and a «Мой налог» registration still
    // waiting on the tax service when the refund arrived records its receipt in
    // between — the old copy erased it, and the income stayed declared with no
    // receipt id left to cancel. With the receipt kept, the registration sees
    // the refund and hands the receipt to a cancellation job.
    //
    // No `providerStatus` here: it was recorded under the lock by the claim,
    // and by any door that came while this ran. The claim goes with this write.
    await writeTransactionGatewayData(this.prismaService, transaction.id, {
      status: TransactionStatus.CANCELED,
      merge: {
        refundReversedAt: new Date().toISOString(),
        subscriptionRevoked: revocation.revoked,
        ...revocation.audit,
        ...(revocation.needsManualReview ? { refundNeedsManualReview: true } : {}),
      },
      remove: [REFUND_REVERSAL_CLAIMED_AT_KEY],
    });

    // A trial's conversion withheld for refund (`isWithheldConversion`) was
    // never announced as a sale — `payment.withheld` went to the operator,
    // `payment.completed` to nobody — so its refund is the operator's alone as
    // well: `payment.withheld_refunded`, operator-only. As `payment.refunded` it
    // reached every rule, outbound webhook and refund email bound to one, with a
    // refund of a sale none of them had seen. The same for every door here:
    // «Отметить возврат», the panel's refund, a provider's notification.
    const withheld = isWithheldConversion(transaction.gatewayData);
    const announce = (autopay: AutopayRefundOutcome): void => {
      const autopayNote = describeAutopayOutcome(autopay);
      this.systemEvents.warn(
        withheld ? EVENT_TYPES.PAYMENT_WITHHELD_REFUNDED : EVENT_TYPES.PAYMENT_REFUNDED,
        'PAYMENT',
        withheld
          ? `Возврат неприменённого платежа: ${transaction.purchaseType}`
          : `Платёж возвращён (refund/chargeback): ${transaction.purchaseType}`,
        {
          userId: transaction.userId,
          paymentId: transaction.paymentId,
          ...planNamesFromTransactionSnapshot(transaction.planSnapshot),
          gatewayType: transaction.gatewayType,
          amount: transaction.amount.toString(),
          currency: transaction.currency,
          providerStatus,
          refund: true,
          subscriptionRevoked: revocation.revoked,
          needsManualReview: revocation.needsManualReview,
          ...(withheld ? { conversionWithheld: true } : {}),
          ...(autopayNote === null ? {} : autopayMetadata(autopay, autopayNote)),
        },
      );
    };

    // The owner's rule: a refund ends the autopay (`refundEndsAutopay` — a full
    // one does). Every live provider subscription of what this payment paid
    // for is cancelled, or marked so the sweep keeps trying and a charge taken
    // anyway renews nothing; and the user's ЮKassa autopay is switched off.
    // Never throws: the money is already back.
    if (!refundEndsAutopay({ full: true })) {
      announce(NO_AUTOPAY);
      return;
    }
    // One card, sent once: when the autopay's end is known, or when the panel
    // stops before it is (`onModuleDestroy`). Marked first, whichever door:
    // from here the sweep ends the autopay even if nothing else does, which is
    // what a card sent before the end can promise.
    const card = new PendingRefundCard(transaction.paymentId, announce);
    await this.markAutopayForRefund(transaction);
    if (options.deferAutopay === true) {
      const early = await this.switchOffSavedCardAutopayForRefund(transaction, { waitForCharges: false });
      card.progress.savedCard = early;
      void this.trackRefundWork(`the autopay of refunded transaction ${transaction.id}`, transaction.paymentId, card, () =>
        this.finishAutopayForRefund(transaction, early, card.progress),
      );
      return;
    }
    await this.trackRefundWork(`the autopay of refunded transaction ${transaction.id}`, transaction.paymentId, card, () =>
      this.finishAutopayForRefund(transaction, null, card.progress),
    );
  }

  /**
   * Ends the autopay a refunded payment belongs to, waiting for the provider:
   * the user's ЮKassa autopay goes off ({@link switchOffSavedCardAutopayForRefund})
   * and the provider subscriptions are cancelled
   * ({@link ProviderSubscriptionService.cancelForRefund}). For a provider's
   * partial refund notice, whose card follows it. Never throws.
   */
  public async endAutopayForRefund(transaction: Transaction): Promise<AutopayRefundOutcome> {
    return this.finishAutopayForRefund(transaction, null);
  }

  /**
   * {@link endAutopayForRefund} from an operator's request — the panel's own
   * partial refund — without the answer waiting on a provider: what the
   * database can settle is settled before the answer, the provider is asked
   * after it. No card: the provider's notice of that refund carries one
   * (`handleRefundReversal`), and says what was ended — the rows cancelled
   * moments ago and the stamp on the payment tell it. Never throws.
   */
  public async endAutopayAfterResponse(transaction: Transaction): Promise<void> {
    await this.markAutopayForRefund(transaction);
    const early = await this.switchOffSavedCardAutopayForRefund(transaction, { waitForCharges: false });
    void this.trackRefundWork(
      `the autopay of partially refunded transaction ${transaction.id}`,
      transaction.paymentId,
      null,
      async () => {
        const autopay = await this.finishAutopayForRefund(transaction, early);
        if (autopay.cancelled.length > 0 || autopay.failed.length > 0 || autopay.savedCardAutopayOff === true) {
          this.logger.warn(
            `Partial refund of transaction ${transaction.id} ended its autopay: ` +
              `${autopay.cancelled.length} cancelled, ${autopay.failed.length} left for the sweep, ` +
              `ЮKassa autopay ${autopay.savedCardAutopayOff === true ? 'off' : 'untouched'}`,
          );
        }
        return autopay;
      },
    );
  }

  /**
   * The first part of ending a refund's provider autopay, at every door: the
   * rows are marked (`ProviderSubscriptionService.markForRefund`), so from here
   * the sweep cancels them whatever happens to the rest, and a charge taken on
   * them renews nothing. Never throws: the cancel marks them again before it
   * asks the provider.
   */
  private async markAutopayForRefund(transaction: Transaction): Promise<void> {
    if (this.providerSubscriptions === undefined) return;
    try {
      await this.providerSubscriptions.markForRefund(transaction);
    } catch (error: unknown) {
      this.logger.error(
        `Could not mark the autopay of refunded transaction ${transaction.id} before the answer; ` +
          `the cancel after it marks it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The rest of ending a refund's autopay, given what a request already did to
   * the ЮKassa autopay (`early`; null when nothing was — then this does it, the
   * same way): what a charge held is switched off, waiting for the charge; the
   * ЮKassa charges that renew anyway are named; then the provider
   * subscriptions are cancelled. `progress` is what the card says if the panel
   * stops first. Never throws.
   */
  private async finishAutopayForRefund(
    transaction: Transaction,
    early: SavedCardRefundOutcome | null,
    progress: RefundCardProgress = {},
  ): Promise<AutopayRefundOutcome> {
    const first = early ?? (await this.switchOffSavedCardAutopayForRefund(transaction, { waitForCharges: false }));
    progress.savedCard = first;
    const late = first.busy
      ? await this.switchOffSavedCardAutopayForRefund(transaction, { waitForCharges: true })
      : null;
    const savedCard = late === null ? first : mergeSavedCardOutcomes(first, late);
    progress.savedCard = savedCard;
    const charges = await this.yookassaChargesAroundRefund(transaction, first.lockHeldAt);
    const provider =
      this.providerSubscriptions === undefined ? NO_AUTOPAY : await this.providerSubscriptions.cancelForRefund(transaction);
    return { ...provider, ...savedCardFields(savedCard), ...charges };
  }

  /**
   * The user's ЮKassa autopay charges a refund's switch could not stop, for
   * its card: the switch stops the NEXT renewal, not one already started, and
   * such a charge renews the subscription — nothing withholds it.
   *
   * - PENDING (a 3DS confirmation, an answer still awaited): if it goes
   *   through, it renews, and has to be refunded on its own.
   * - COMPLETED, when a charge held a saved method as the refund came
   *   (`lockHeldAt`, from the switch that found it held): it went through
   *   while the refund waited for it. Created at most
   *   {@link CHARGE_IN_FLIGHT_WINDOW_MS} before: the charge is written before
   *   it takes the lock, and a charge holds it for 30 s at most.
   *
   * Never for a withheld payment's refund, which leaves the autopay on.
   * Never throws: a lookup that fails only leaves the line out.
   */
  private async yookassaChargesAroundRefund(
    transaction: Transaction,
    lockHeldAt: Date | null,
  ): Promise<Pick<AutopayRefundOutcome, 'yookassaChargesDuringRefund' | 'yookassaChargesPending'>> {
    if (isWithheldConversion(transaction.gatewayData)) return {};
    const autopayCharges = {
      userId: transaction.userId,
      gatewayType: PaymentGatewayType.YOOKASSA,
      idempotencyKey: { startsWith: AUTO_RENEW_IDEMPOTENCY_PREFIX },
      id: { not: transaction.id },
    };
    try {
      const pending = await this.prismaService.transaction.findMany({
        where: { ...autopayCharges, status: TransactionStatus.PENDING },
        select: { paymentId: true },
        orderBy: { createdAt: 'asc' },
      });
      const during =
        lockHeldAt === null
          ? []
          : await this.prismaService.transaction.findMany({
              where: {
                ...autopayCharges,
                status: TransactionStatus.COMPLETED,
                createdAt: { gte: new Date(lockHeldAt.getTime() - CHARGE_IN_FLIGHT_WINDOW_MS) },
              },
              select: { paymentId: true },
              orderBy: { createdAt: 'asc' },
            });
      return {
        ...(during.length > 0 ? { yookassaChargesDuringRefund: during.map((row) => row.paymentId) } : {}),
        ...(pending.length > 0 ? { yookassaChargesPending: pending.map((row) => row.paymentId) } : {}),
      };
    } catch (error: unknown) {
      this.logger.warn(
        `Could not look for ЮKassa autopay charges around the refund of transaction ${transaction.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  /**
   * The owner's decision of 23.09.2026, «Да, выключай при возврате»: a refund
   * (`refundEndsAutopay`) also switches off the user's ЮKassa saved-card
   * autopay — the per-user switch the renewal reads
   * (`SavedPaymentMethodService.findPreferredForCharge`), so it stops the
   * autopay of every subscription of theirs. The card itself stays saved.
   *
   * Not for a withheld payment's refund: that payment paid for nothing, and
   * the autopay of what the user did buy stands, as its provider
   * subscriptions do (`cancelForRefund`).
   *
   * `waitForCharges: false` leaves a method a charge is being submitted with
   * (`busy`, and when: `lockHeldAt`) for the call that waits. The switch stamps
   * the payment (`SAVED_CARD_AUTOPAY_OFF_AT_KEY`) in its own database
   * transaction; the stamp is read after it, so a door that finds nothing left
   * to switch — the other door of the same refund switched first — says the
   * autopay is off too. Never throws.
   */
  private async switchOffSavedCardAutopayForRefund(
    transaction: Transaction,
    options: { readonly waitForCharges: boolean },
  ): Promise<SavedCardRefundOutcome> {
    if (isWithheldConversion(transaction.gatewayData)) {
      return { off: false, failed: false, busy: false, lockHeldAt: null };
    }
    const startedAt = new Date();
    let result: { readonly switched: number; readonly busy: number };
    try {
      result = await this.savedPaymentMethodService.disableAutopayForRefund({
        userId: transaction.userId,
        transactionId: transaction.id,
        waitForCharges: options.waitForCharges,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.waitForCharges) {
        // Tried again by the call that waits.
        this.logger.warn(`ЮKassa autopay of refunded transaction ${transaction.id} not switched off yet: ${message}`);
        return { off: false, failed: false, busy: true, lockHeldAt: null };
      }
      this.logger.error(`Could not switch off the ЮKassa autopay of refunded transaction ${transaction.id}: ${message}`);
      return { off: false, failed: true, busy: false, lockHeldAt: null };
    }
    return {
      off: result.switched > 0 || (await this.readSavedCardStamp(transaction)),
      failed: false,
      busy: result.busy > 0,
      lockHeldAt: result.busy > 0 ? startedAt : null,
    };
  }

  /** Whether the payment carries the stamp of a switch its refund made, as the database holds it now. */
  private async readSavedCardStamp(transaction: Transaction): Promise<boolean> {
    try {
      const fresh = await this.prismaService.transaction.findUnique({
        where: { id: transaction.id },
        select: { gatewayData: true },
      });
      return typeof asRecord(fresh?.gatewayData)?.[SAVED_CARD_AUTOPAY_OFF_AT_KEY] === 'string';
    } catch {
      return typeof asRecord(transaction.gatewayData)?.[SAVED_CARD_AUTOPAY_OFF_AT_KEY] === 'string';
    }
  }

  /**
   * Runs the end of a refund's autopay and sends its card (`card`; null for
   * the panel's partial refund, whose card the provider's notice brings).
   * Returned, for a door that waits for it (the worker's); left running by
   * one that does not (an operator's request). Never rejects: a failure is
   * logged, and the card still goes out, saying what is known. Kept until done,
   * so a stop ({@link onModuleDestroy}) and a spec ({@link settleAfterResponse})
   * can find it.
   */
  private trackRefundWork(
    label: string,
    paymentId: string,
    card: PendingRefundCard | null,
    work: () => Promise<AutopayRefundOutcome>,
  ): Promise<void> {
    const task: Promise<void> = work()
      .then((outcome) => {
        card?.send(outcome);
      })
      .catch((error: unknown) => {
        this.logger.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        card?.send({ cancelled: [], failed: [{ gatewayType: UNKNOWN_AUTOPAY_GATEWAY, providerSubscriptionId: '' }] });
      })
      .finally(() => {
        this.underWay.delete(task);
      });
    this.underWay.set(task, { paymentId, card });
    return task;
  }

  /** Waits for the ends of refunds' autopays under way ({@link trackRefundWork}). */
  public async settleAfterResponse(): Promise<void> {
    while (this.underWay.size > 0) {
      await Promise.all([...this.underWay.keys()]);
    }
  }

  /**
   * A stop never loses a refund's card. What is under way gets
   * {@link AFTER_RESPONSE_SHUTDOWN_WAIT_MS} to finish — well inside the 10 s
   * Docker gives a container before it kills it; the compose files set no
   * `stop_grace_period`. Then every card still owed goes out at once, saying
   * the provider's cancel had not finished and that the panel retries it every
   * 10 minutes — true, because every door marks the rows before anything
   * else. Each is logged with its payment. Here and not in a later hook: Nest
   * destroys this module before the global one that disconnects the
   * database, and the work still writes to it.
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.underWay.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.settleAfterResponse(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, AFTER_RESPONSE_SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const { paymentId, card } of this.underWay.values()) {
      if (card === null) {
        this.logger.warn(`The autopay's end for refunded payment ${paymentId} was cut by the stop; the sweep finishes it`);
        continue;
      }
      if (card.isSent) continue;
      this.logger.warn(
        `Refund card of payment ${paymentId} sent before its autopay's provider cancel finished: the panel is stopping`,
      );
      try {
        card.sendInterrupted();
      } catch (error: unknown) {
        this.logger.error(
          `Refund card of payment ${paymentId} could not be sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Takes the one run of {@link reverseFulfilledPayment} for `transactionId`,
   * under the row lock the refund writers share (`lockTransactionRefundLedger`).
   * False when the payment is reversed already, or another run holds a claim
   * younger than `REFUND_REVERSAL_CLAIM_MS`; a claim older than that belongs to
   * a run that died before its end, and this one takes it over.
   *
   * `providerStatus`, unless `undefined`, is recorded in the same statement
   * either way: the lock admits the doors one at a time, so the row ends with
   * the provider's latest word, and a run under way never writes it at all.
   */
  private async claimRefundReversal(transactionId: string, providerStatus: string | null | undefined): Promise<boolean> {
    return this.prismaService.$transaction(async (tx) => {
      const live = await lockTransactionRefundLedger(tx, transactionId);
      if (typeof asRecord(live)?.['refundReversedAt'] === 'string') {
        return false;
      }
      const held = isRefundReversalClaimHeld(live);
      const merge: Record<string, unknown> = {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(held ? {} : { [REFUND_REVERSAL_CLAIMED_AT_KEY]: new Date().toISOString() }),
      };
      if (Object.keys(merge).length > 0) {
        await writeTransactionGatewayData(tx, transactionId, { merge });
      }
      return !held;
    });
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
    // A trial's conversion withheld for refund was applied to nothing: the
    // subscription it names is the one ANOTHER payment converted, and the
    // refund that settles this one has nothing of it to take back.
    if (isWithheldConversion(transaction.gatewayData)) {
      return {
        revoked: false,
        needsManualReview: false,
        audit: { refundRevocationSkippedReason: 'CONVERSION_NOT_APPLIED' },
      };
    }
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
        // The panel username is selected only so the warning below can name
        // the profile an operator has to go and cut off by hand.
        select: {
          id: true,
          remnawaveId: true,
          remnawavePanelUsername: true,
          status: true,
          expiresAt: true,
        },
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
      } else {
        // THE LOCAL HALF OF THE REVOCATION LANDED AND THE PANEL HALF DID NOT,
        // and until now that was reported as a complete revocation.
        //
        // The row above is already EXPIRED with `expiresAt = now`, so rezeis
        // believes the refunded customer has no access. The panel was never
        // told, because there is no identity to tell it with — so the profile
        // keeps serving traffic on whatever `expireAt` it was last given, for a
        // purchase that has been refunded. Nothing retries: the revocation is a
        // one-shot best-effort, and no sweep revisits it.
        //
        // Recorded in the audit blob rather than only logged, because the audit
        // travels with the transaction: an operator looking at the refund later
        // sees why the customer still had service, without correlating logs.
        // `needsManualReview` is deliberately NOT flipped — the money-side
        // reversal succeeded and re-routing it into the manual queue would
        // change how refunds are settled, which is a decision for the payments
        // owner, not a side effect of adding a warning.
        audit = {
          ...audit,
          refundRevocationPanelPushSkipped: true,
          refundRevocationPanelPushSkippedReason: 'SUBSCRIPTION_HAS_NO_PANEL_LINK',
          refundRevocationStrandedPanelUsername: subscription.remnawavePanelUsername,
        };
        const message =
          `Refunded transaction ${transaction.id}: subscription ${subscription.id} was expired ` +
          'locally but carries no Remnawave id, so the panel was never told. The profile ' +
          `(panel username '${subscription.remnawavePanelUsername ?? 'unknown'}') is still live ` +
          'for a refunded purchase — cut it off by hand.';
        this.logger.warn(message);
        this.systemEvents.warn(EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC, 'SYSTEM', message, {
          transactionId: transaction.id,
          subscriptionId: subscription.id,
          panelUsername: subscription.remnawavePanelUsername,
          // The operator card prints no message; the instruction is its note.
          note: 'Подписка по возвращённой оплате отозвана только в rezeis: привязки к панели нет, и профиль в Remnawave продолжает работать — отключите его вручную.',
        });
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
  private async findTransactionForEvent(
    paymentReference: string,
    gatewayType: PaymentGatewayType,
  ): Promise<Transaction> {
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
    // A notification only ever speaks for its own gateway. Platega, MulenPay,
    // Lava and Telegram Stars authenticate callbacks with a static header that
    // does not cover the body, so one captured delivery yields a credential
    // reusable forever. Without this check its holder could post someone else's
    // paymentId to their own gateway's route and have us fulfil a transaction
    // belonging to any other gateway — the blast radius of the weakest secret
    // in the system would be all of them, YooKassa included.
    //
    // Deliberately checked after the lookup rather than folded into the query:
    // a mismatch must surface as a mismatch, not as "not found". `gatewayType`
    // is written once at creation and never rewritten, so there is no
    // legitimate migration case this would break.
    if (transaction.gatewayType !== gatewayType) {
      throw new ForbiddenException('PAYMENT_WEBHOOK_GATEWAY_MISMATCH');
    }
    return transaction;
  }

  /**
   * Runs the referral qualification + partner earnings hooks after a
   * transaction is marked COMPLETED. Errors here are logged but do not
   * propagate — a failed accrual must not roll back a successful payment
   * application. Both downstream services are idempotent — partner earnings
   * on `(partnerId, sourceTransactionId)`, referral rewards on their
   * per-payment `source_key` — so a retried webhook event is safe.
   */
  private async runReferralAndPartnerHooks(transaction: Transaction): Promise<void> {
    let referralOutcome: ReferralPurchaseOutcome | null = null;
    try {
      referralOutcome = await this.referralQualificationService.qualifyReferralAfterPurchase(
        transaction.id,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Referral qualification hook failed for transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.tellReferralEarners(referralOutcome);

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
   * Tells each inviter what a friend's payment has just earned them — the
   * `referral_reward` notification, which had a template, an operator switch
   * and no sender at all while rewards waited for a manual «Выдать».
   *
   * Composed here for the reason {@link creditCashbackAndTellTheBuyer} gives:
   * the payment pipeline already holds the notification stack, the referral
   * module does not. And split the same way: the reward is durable before the
   * message is attempted, so an undelivered message never reads as a missing
   * reward. Only ISSUED rewards are announced — a pending one has not arrived.
   *
   * No `currency` in the payload on purpose: the unit is the recipient's
   * language («баллов» / «points», «дн.» / «days»), which is only known when
   * the message is rendered, from `rewardType`.
   */
  private async tellReferralEarners(
    outcome: ReferralPurchaseOutcome | null | undefined,
  ): Promise<void> {
    // `undefined` as well as `null`: this runs outside any try, and a caller
    // double that answers the old `Promise<void>` must not turn "nothing to
    // announce" into a thrown hook.
    if (outcome === null || outcome === undefined) return;
    for (const reward of outcome.issued) {
      try {
        await this.userNotifications.create({
          userId: reward.userId,
          type: 'referral_reward',
          payload: {
            amount: reward.amount,
            rewardType: reward.type,
            rewardId: reward.id,
            referralId: reward.referralId,
            transactionId: outcome.transactionId,
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          `Referral reward ${reward.id} issued for transaction ${outcome.transactionId} but the notification failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Credits the points a purchase earned and tells the buyer.
   *
   * The message is composed HERE and not inside `PointsCashbackService` for a
   * module-shaped reason: emitting it there would make `PointsModule` import
   * the whole notification stack — auth, web push, custom emoji and two Bull
   * queues — into the seven modules that import it merely to move a balance.
   * Telling a buyer what their payment earned belongs to the payment
   * pipeline, which already holds that stack.
   *
   * Both halves are best-effort and independent: the credit is durable on the
   * ledger before the message is attempted, so an undelivered message is an
   * undelivered message and never reads as a failed credit.
   */
  private async creditCashbackAndTellTheBuyer(transaction: Transaction): Promise<void> {
    const outcome = await this.pointsCashbackService.creditForTransactionBestEffort(transaction);
    // `?.` and not `=== null`: everything except a credit that actually
    // happened means there is nothing to announce, and this hook must not be
    // the thing that throws on the way out of a settled payment.
    if (outcome?.credited !== true) return;
    try {
      await this.userNotifications.create({
        userId: transaction.userId,
        type: 'points_cashback_credited',
        payload: {
          points: outcome.points,
          balance: outcome.balanceAfter,
          transactionId: transaction.id,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Cashback credited for transaction ${transaction.id} but the notification failed: ${
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
 * The refund a webhook describes: how much was given back, and the provider's
 * own id for it. YooKassa's refund object carries both (`id`, and
 * `amount: { value, currency }`).
 *
 * `amount` is `null` when the payload doesn't say — callers then treat the
 * refund as full, preserving the pre-existing behaviour for the providers that
 * only signal a status (Heleket/Cryptomus `refund_paid`, Wata `kind: REFUND`,
 * Platega `CHARGEBACKED`, Telegram `refunded_payment`); none of them nest an
 * `object`, so they are untouched by the deduplication above.
 *
 * `refundId` exists purely to tell "this refund again" from "another refund",
 * so it is read even when the amount is missing; it is never used as a payment
 * id (see {@link resolveYookassaGatewayIdBackfill}, which must NOT see it).
 */
function resolveRefundEvent(rawPayload: Prisma.JsonValue | undefined): {
  readonly amount: number | null;
  readonly refundId: string | null;
} {
  const unknownRefund = { amount: null, refundId: null };
  if (rawPayload === undefined) return unknownRefund;
  const payload = asRecord(rawPayload);
  if (payload === null) return unknownRefund;
  const refundObject = asRecord(payload['object']);
  if (refundObject === null) return unknownRefund;
  const rawRefundId = refundObject['id'];
  const refundId =
    typeof rawRefundId === 'string' && rawRefundId.length > 0 ? rawRefundId : null;
  const amount = asRecord(refundObject['amount']);
  if (amount === null) return { amount: null, refundId };
  const value = amount['value'];
  const parsed =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return { amount: Number.isFinite(parsed) ? parsed : null, refundId };
}

/** A provider's reported sum that came in UNDER the sum we booked. */
interface NotifiedAmountShortfallInterface {
  readonly notifiedAmount: string;
  readonly bookedAmount: string;
  readonly currency: string;
}

/**
 * The webhook normalizer's own money extraction, run against a persisted
 * `PaymentWebhookEvent` row (which stores `rawPayload` and `gatewayType`, and no
 * notified sum).
 *
 * Replaces a flat sweep of root keys that predated the envelope work and was
 * wrong four ways. It could not see a nested shape, so YooKassa's
 * `object.amount.value`, CryptoPay's `payload.amount`, SeverPay's `data.amount`
 * and Overpay's `transaction.amount` every one came back null. It read
 * Antilopay's `amount`, which is NET OF `fee` and would report every honest
 * payment short by the commission. It left Overpay's kopecks unscaled, 100x out.
 * And it read `payer_amount`, the same money in the payer's own coin. Sharing
 * one extraction with ingress means the reconciler can no longer read a payload
 * differently from the envelope that same payload produced.
 *
 * Never throws. The Telegram branch of the extraction rejects an update that
 * carries no payment at all — the right answer at ingress, where the envelope is
 * built and the delivery is being accepted or refused, and no answer at all
 * here: this row was accepted long ago, and letting the rejection escape would
 * mark a legitimately-delivered webhook FAILED and page an operator over a
 * missing number.
 */
function readNotifiedMoney(
  gatewayType: PaymentGatewayType,
  rawPayload: Prisma.JsonValue | undefined,
): NotifiedMoneyInterface {
  const payload = asRecord(rawPayload);
  if (payload === null) return {};
  try {
    return resolveNotifiedMoney(gatewayType, payload);
  } catch {
    return {};
  }
}

/**
 * The provider's own figure for what arrived, as a STRING, for an operator to
 * read; `null` when the notification did not say.
 *
 * A string and never a number, because this is evidence for a human and a
 * provider reporting a crypto sum would lose digits through a float on the way
 * to the card. `Prisma.Decimal.toString()` normalizes the provider's spelling —
 * a `6.40` prints as `6.4` — while keeping the value exact, and it is also what
 * shows an Overpay `100000` as the `1000` the buyer actually paid.
 */
function readNotifiedAmountEvidence(
  gatewayType: PaymentGatewayType,
  rawPayload: Prisma.JsonValue | undefined,
): string | null {
  return readNotifiedMoney(gatewayType, rawPayload).notifiedAmount?.value.toString() ?? null;
}

/**
 * Gateways whose reported sum is known to be GROSS — the money the buyer sent,
 * before the provider takes its cut — because somebody has actually read the
 * field's definition. The comparison below is restricted to these.
 *
 * The restriction exists because the alternative was already caught happening.
 * Antilopay's `amount` is NET OF `fee`, and reading it made every honest payment
 * look short by the commission; the normalizer switched to `original_amount`
 * («Сумма платежа, указанная при создании») for exactly that reason. Net
 * reporting is therefore not hypothetical on these rails — it is a live pattern
 * in this market that one of our own gateways follows.
 *
 * VERIFIED, and where the evidence lives:
 *  - CRYPTOMUS / HELEKET — `payment_amount` is documented in
 *    `payment-webhook-normalizer.service.ts` as what the buyer actually SENT,
 *    with `amount` (what we invoiced) as the fallback. Neither is net of a fee.
 *  - ANTILOPAY — `original_amount`, the sum recorded at creation. The one
 *    gateway here whose net-vs-gross question has been settled against the docs.
 *  - OVERPAY — the notification echoes back the minor-unit figure our own
 *    checkout posted, which is why the normalizer descales it by 100.
 *
 * NOT VERIFIED, and therefore not compared: AURAPAY, ROLLYPAY, RIOPAY, VALUTIX,
 * WATA, SEVERPAY (a plain `amount` whose definition nobody has checked) and
 * CRYPTOPAY (`payload.amount` on the invoice). Add one here only after reading
 * that provider's field definition, and say so in this list.
 *
 * PAYPALYCH never reaches this set: its currency is unsigned, so the
 * `notifiedCurrency.signatureCovered` gate below drops it first.
 *
 * The trade this makes is deliberate. A gateway that reports net would alert on
 * EVERY payment through it, and an operator who learns this card is usually
 * wrong stops reading the one time it is right — which costs the check its
 * entire value, on all gateways at once. An unverified gateway silently not
 * being compared costs only the discrepancies that gateway would have caught,
 * and the fix is one documentation lookup away.
 */
const GROSS_REPORTING_GATEWAYS: ReadonlySet<PaymentGatewayType> = new Set([
  PaymentGatewayType.CRYPTOMUS,
  PaymentGatewayType.HELEKET,
  PaymentGatewayType.ANTILOPAY,
  PaymentGatewayType.OVERPAY,
]);

/**
 * Rounding slack on the shortfall comparison, matching the tolerance every other
 * money comparison in this module and `payment-refund.service.ts` already
 * carries.
 *
 * Not optional: `Transaction.amount` is `Decimal(20, 8)` and the crypto rails in
 * the compared set settle in eight decimal places, so an exact `lessThan` fires
 * on a 0.00000001 dust difference — on a settlement the provider itself calls
 * `paid`. That is an alert on a payment nothing is wrong with, which is the
 * failure mode the whole gate list above exists to avoid.
 */
const NOTIFIED_AMOUNT_TOLERANCE = new Prisma.Decimal('0.000001');

/**
 * The provider's reported sum, but only when comparing it is meaningful AND it
 * came in short. `null` means "nothing to say", which is the answer in every
 * case below.
 *
 * Each gate is a false positive this check would otherwise manufacture, and all
 * of them are real shapes in this codebase:
 *
 *  - THE AMOUNT IS NOT SIGNATURE-COVERED. Outside `SIGNED_AMOUNT_GATEWAYS` the
 *    number is attacker-controlled (static-header auth: Platega, MulenPay,
 *    lava.top, Telegram Stars) or unauthenticated (YooKassa, source IP only).
 *    Neither a match nor a mismatch there means anything, so comparing only
 *    manufactures noise on five gateways.
 *  - COVERAGE IS PER-FIELD, so the currency has to be covered on its own. Pally
 *    signs `md5(OutSum + ":" + InvId + ":" + apiToken)`: the sum is bound,
 *    `CurrencyIn` travels in the same form body bound to nothing. A genuinely
 *    signed 100.00 beside a ticker anyone could rewrite is not comparable to a
 *    booked sum, so Pally is skipped despite having a trustworthy amount.
 *  - A DIFFERENT CURRENCY IS NOT A SHORTFALL. Nothing here converts, and several
 *    of these providers can settle in a coin other than the one invoiced; 10 of
 *    one currency against 900 of another is a unit error, not an underpayment.
 *  - ABSENT IS NOT ZERO. Antilopay deliberately reports no amount when
 *    `original_amount` is missing, because its `amount` is net of `fee`; a
 *    fabricated zero would read as "the buyer paid nothing" and alert on every
 *    payment through that gateway.
 *  - A SUM THAT MAY BE NET OF COMMISSION IS NOT COMPARABLE. See
 *    {@link GROSS_REPORTING_GATEWAYS}: Antilopay proved this shape is real, and
 *    six other gateways report a plain `amount` nobody has checked.
 *  - EXACT EQUALITY IS THE WRONG TEST ON EIGHT DECIMAL PLACES. See
 *    {@link NOTIFIED_AMOUNT_TOLERANCE}.
 *  - NOTIFIED ABOVE BOOKED IS NOT A DISCREPANCY, which is why this asks for a
 *    shortfall rather than for inequality. Cryptomus `paid_over` maps to
 *    COMPLETED on purpose and its `payment_amount` legitimately EXCEEDS what we
 *    booked; the crypto rails settle a little over routinely, because the buyer
 *    sends a round number or covers the network fee, and Pally's `OVERPAID` is
 *    the same thing on cards. A plain inequality would alert on every generous
 *    customer — most of the traffic on those gateways — for an outcome the
 *    status map already names and honours on purpose. The cost is real and
 *    accepted: a provider that OVER-charged is not caught here, because on rails
 *    where an excess is the expected shape there is no threshold separating the
 *    two that would not be invented.
 */
function resolveNotifiedAmountShortfall(
  transaction: Transaction,
  rawPayload: Prisma.JsonValue | undefined,
): NotifiedAmountShortfallInterface | null {
  if (!GROSS_REPORTING_GATEWAYS.has(transaction.gatewayType)) return null;
  const { notifiedAmount, notifiedCurrency } = readNotifiedMoney(
    transaction.gatewayType,
    rawPayload,
  );
  if (notifiedAmount === undefined || !notifiedAmount.signatureCovered) return null;
  if (notifiedCurrency === undefined || !notifiedCurrency.signatureCovered) return null;
  if (notifiedCurrency.value !== transaction.currency) return null;
  if (!notifiedAmount.value.lessThan(transaction.amount.minus(NOTIFIED_AMOUNT_TOLERANCE))) {
    return null;
  }
  return {
    notifiedAmount: notifiedAmount.value.toString(),
    bookedAmount: transaction.amount.toString(),
    currency: notifiedCurrency.value,
  };
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

/**
 * Lifts the provisional hold `guardUnconfirmedCompletionFromSweep` stamped,
 * once the provider has finally answered and the completion is being applied.
 * Returns the keys to fold into the status write, or nothing when there is no
 * guard of ours to lift.
 *
 * Only on a COMPLETED write. The guard exists to stop the expiry sweep
 * cancelling an unconfirmed completion, and only a confirmed completion settles
 * that question; a row that goes terminal some other way keeps the flag, which
 * costs nothing (the sweep reads PENDING rows only) and leaves a human to look
 * at a payment somebody once reported as succeeded.
 *
 * A hold written by an actual VERDICT is never touched: an underpaid invoice
 * (`amountMismatchAt`) or a completion the provider refused
 * (`providerVerificationFailedAt`) is somebody's decision to make, and clearing
 * it here would empty the operator's queue behind their back — the same harm
 * the sweep exemption exists to prevent.
 */
function releaseVerificationSweepGuard(
  gatewayData: Transaction['gatewayData'],
  nextStatus: TransactionStatus,
): Record<string, unknown> {
  if (nextStatus !== TransactionStatus.COMPLETED) return {};
  const current = asRecord(gatewayData);
  if (current === null) return {};
  if (current['paymentNeedsManualReview'] !== true) return {};
  if (typeof current['providerVerificationUnavailableAt'] !== 'string') return {};
  if (typeof current['amountMismatchAt'] === 'string') return {};
  if (typeof current['providerVerificationFailedAt'] === 'string') return {};
  return {
    paymentNeedsManualReview: false,
    providerVerificationRecoveredAt: new Date().toISOString(),
  };
}

export function mapProviderStatusToTransactionStatus(providerStatus: string | null): TransactionStatus {
  const normalizedStatus = String(providerStatus ?? '').toUpperCase();
  if (
    normalizedStatus === 'SUCCESSFUL_PAYMENT' ||
    normalizedStatus === 'SUCCEEDED' ||
    normalizedStatus === 'SUCCESS' ||
    normalizedStatus === 'CONFIRMED' ||
    normalizedStatus === 'PAID' ||
    normalizedStatus === 'COMPLETED' ||
    // Overpay's success status is `successful` — spelled out, not `success`.
    normalizedStatus === 'SUCCESSFUL' ||
    // Cryptomus / Heleket: the buyer paid MORE than asked. The payment
    // succeeded; treating it as unpaid left it to be cancelled by the sweep
    // with the money already received.
    normalizedStatus === 'PAID_OVER' ||
    // Pally's equivalent. `UNDERPAID` is deliberately NOT here — money did
    // arrive, but short, and granting a subscription for a partial payment is
    // the wrong default. It stays PENDING for an operator to resolve — which is
    // true only because `isAmountMismatchProviderStatus` now routes it (and
    // Cryptomus/Heleket `wrong_amount`) to the manual-review branch in
    // `reconcileWebhookEvent`. Falling through to the PENDING default alone
    // told nobody anything and ended in a silent sweep cancellation.
    normalizedStatus === 'OVERPAID'
  ) {
    return TransactionStatus.COMPLETED;
  }
  if (
    normalizedStatus === 'REFUNDED_PAYMENT' ||
    normalizedStatus === 'REFUNDED' ||
    // Heleket / Cryptomus emit the raw `refund_paid` on a completed refund.
    normalizedStatus === 'REFUND_PAID' ||
    // Money clawed back after the fact. Kept in step with
    // `isRefundProviderStatus` so the status change and the side-effect
    // reversal always agree on what a chargeback is.
    normalizedStatus === 'CHARGEBACK' ||
    normalizedStatus === 'CHARGEBACKED'
  ) {
    return TransactionStatus.CANCELED;
  }
  if (
    normalizedStatus === 'CANCELED' ||
    normalizedStatus === 'CANCELLED' ||
    normalizedStatus === 'FAILED' ||
    normalizedStatus === 'FAIL' ||
    normalizedStatus === 'EXPIRED' ||
    normalizedStatus === 'DECLINED' ||
    // Singular / provider-specific spellings that previously fell through to
    // PENDING and only became terminal when the sweep caught them 30 minutes
    // later — with the trial reservation released as a local timeout rather
    // than a provider verdict, which distorts the quota audit trail.
    normalizedStatus === 'DECLINE' || // SeverPay
    normalizedStatus === 'CANCEL' || // Cryptomus / Heleket / MulenPay
    normalizedStatus === 'BLOCKED' || // RioPay / Valutix
    normalizedStatus === 'SYSTEM_FAIL' // Cryptomus / Heleket
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
export function isRefundProviderStatus(providerStatus: string | null): boolean {
  const normalized = String(providerStatus ?? '').toUpperCase();
  return (
    normalized === 'REFUNDED' ||
    normalized === 'REFUNDED_PAYMENT' ||
    // Heleket / Cryptomus completed-refund status (`refund_paid`). `refund_process`
    // is intentionally NOT here — an in-flight refund must not reverse yet.
    normalized === 'REFUND_PAID' ||
    normalized === 'CHARGEBACK' ||
    // Platega spells its chargeback status `CHARGEBACKED`. Without it the
    // reversal branch never ran: the subscription and any partner accruals
    // stayed granted on money that had been clawed back.
    normalized === 'CHARGEBACKED' ||
    normalized === 'REVERSED'
  );
}

/**
 * True when the provider is telling us money ARRIVED but not the amount we
 * invoiced — or that it is frozen on their side. Cryptomus/Heleket
 * `wrong_amount` means the buyer underpaid: the crypto is already on-chain and
 * credited to us. `wrong_amount_waiting` is the same shortfall while the
 * invoice is still open for a top-up, and `locked` is their AML hold on funds
 * we have received. Pally's `UNDERPAID` is the identical situation on the card
 * rail.
 *
 * Cryptomus documents `wrong_amount` as FINAL — its resend-webhook page lists
 * it beside `paid` and `paid_over` among the finalized statuses, so the invoice
 * can never move on to `paid`. Nothing further is coming for such a row.
 *
 * Deliberately kept OUT of the COMPLETED set in
 * {@link mapProviderStatusToTransactionStatus}: granting a full subscription
 * for a partial payment is the wrong default. The gap was the other half —
 * these statuses matched no branch at all, fell through to the PENDING
 * default, and `PaymentPendingExpiryService` then cancelled the row on our own
 * TTL emitting only the routine abandoned-cart INFO event. A paid-but-short
 * invoice and an abandoned cart produced byte-identical operator output, with
 * the money on our balance and the customer holding nothing.
 */
export function isAmountMismatchProviderStatus(providerStatus: string | null): boolean {
  const normalized = String(providerStatus ?? '').toUpperCase();
  return (
    // Cryptomus / Heleket: paid less than invoiced (final).
    normalized === 'WRONG_AMOUNT' ||
    // Same shortfall, invoice still open for a top-up.
    normalized === 'WRONG_AMOUNT_WAITING' ||
    // Cryptomus / Heleket AML freeze — funds received, withheld pending review.
    normalized === 'LOCKED' ||
    // Pally's card-rail equivalent of `wrong_amount`.
    normalized === 'UNDERPAID'
  );
}

function isTerminalTransaction(transaction: Transaction): boolean {
  return (
    transaction.status === TransactionStatus.COMPLETED ||
    transaction.status === TransactionStatus.CANCELED ||
    transaction.status === TransactionStatus.FAILED
  );
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

/**
 * The bot a payment was imported from, or null for a payment taken here.
 *
 * `planSnapshot.importedFrom` is written on every transaction the four file
 * importers create — 'bedolaga', 'remnashop', 'altshop', 'stealthnet' — and by
 * nothing else: the native writers (the checkout draft, the combined renewal,
 * the add-on purchase) build their snapshots field by field, and no path
 * rewrites a transaction's snapshot afterwards. Any non-empty string counts, so
 * a fifth importer is covered the day it writes the key.
 *
 * Exported so the expiry sweep decides on the same rule rather than a copy.
 */
export function importedPaymentSource(transaction: Pick<Transaction, 'planSnapshot'>): string | null {
  const source = asRecord(transaction.planSnapshot)?.['importedFrom'];
  return typeof source === 'string' && source.length > 0 ? source : null;
}

/**
 * When the payment was refunded in full, or null when it was not.
 *
 * `refundReversedAt` is the reversal's own stamp. A CANCELED row whose refund
 * ledger reaches the paid amount is refunded in full too, stamp or not: before
 * the «Мой налог» cancellation merged in the statement it erased that stamp on
 * most full refunds, and the ledger — written before it — survived. The time is
 * the stamp's, else the newest ledger entry's, else the row's last write, which
 * is never earlier than the refund.
 */
function refundedInFullAt(
  transaction: Pick<Transaction, 'status' | 'amount' | 'gatewayData' | 'updatedAt'>,
): Date | null {
  const gatewayData = asRecord(transaction.gatewayData) ?? {};
  const stamped = parseInstant(gatewayData['refundReversedAt']);
  if (stamped !== null) return stamped;
  if (transaction.status !== TransactionStatus.CANCELED) return null;
  const paid = Number(transaction.amount.toString());
  if (!Number.isFinite(paid) || paid <= 0 || readRefundedTotal(gatewayData) < paid - 0.000001) return null;
  const newestEntry = readRefundLedger(gatewayData)
    .map((entry) => parseInstant(entry.at))
    .filter((at): at is Date => at !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return newestEntry ?? transaction.updatedAt;
}

/**
 * Whether this notification is the provider saying, after the refund, that the
 * payment is paid — the one case an operator is told about.
 *
 * Not a replay or a retry: those run a notification stored before, and are not
 * the provider saying anything now. Not one received before the refund: that
 * is the old claim the refund already answered. And not one whose own payment
 * object shows the refund: YooKassa keeps `status: succeeded` on a refunded
 * payment and reports the refund in `refunded_amount` (its API's Payment
 * object; the SDKs model it as `refunded_amount`), so `succeeded` alone says
 * nothing new. What is left is a provider reporting the payment paid and not
 * refunded after we recorded it refunded — a chargeback reversed at the
 * provider, say — and that is money an operator has to decide about.
 */
function providerSaysPaidAfterRefund(
  event: Pick<PaymentWebhookEvent, 'receivedAt' | 'replayCount' | 'reconciliationAttempts' | 'gatewayType' | 'rawPayload'>,
  transaction: Pick<Transaction, 'amount'>,
  refundedAt: Date,
): boolean {
  if (event.replayCount > 0 || event.reconciliationAttempts > 0) return false;
  if (event.receivedAt.getTime() <= refundedAt.getTime()) return false;
  if (event.gatewayType === PaymentGatewayType.YOOKASSA) {
    const payment = asRecord(asRecord(event.rawPayload)?.['object']);
    const refunded = Number(asRecord(payment?.['refunded_amount'])?.['value']);
    const paid = Number(transaction.amount.toString());
    if (Number.isFinite(refunded) && Number.isFinite(paid) && refunded >= paid - 0.000001) return false;
  }
  return true;
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * What the refund card carries about the autopay: how many were cancelled and
 * how many could not be (for machines), and the line the operator reads as
 * «📝 Заметка».
 */
function autopayMetadata(outcome: AutopayRefundOutcome, note: string): Record<string, unknown> {
  return {
    autopayCancelled: outcome.cancelled.length,
    autopayCancelFailed: outcome.failed.length,
    ...(outcome.savedCardAutopayFailed === true
      ? { savedCardAutopayFailed: true }
      : outcome.savedCardAutopayOff === true
        ? { savedCardAutopayOff: true }
        : {}),
    ...(outcome.yookassaChargesDuringRefund === undefined
      ? {}
      : { yookassaChargesDuringRefund: outcome.yookassaChargesDuringRefund }),
    ...(outcome.yookassaChargesPending === undefined ? {} : { yookassaChargesPending: outcome.yookassaChargesPending }),
    ...(outcome.providerCancelInterrupted === true ? { providerCancelInterrupted: true } : {}),
    note,
  };
}

/** What a refund did to the user's ЮKassa autopay; see `switchOffSavedCardAutopayForRefund`. */
interface SavedCardRefundOutcome {
  /** Off because of this refund: switched now, or by another door of it (the stamp). */
  readonly off: boolean;
  /** Switching it off failed. */
  readonly failed: boolean;
  /** A charge held a saved method, and it is left for the call that waits. */
  readonly busy: boolean;
  /** When a charge was found holding one; null when none was. */
  readonly lockHeldAt: Date | null;
}

/** One outcome of a switch that did not wait and the one that then waited. */
function mergeSavedCardOutcomes(first: SavedCardRefundOutcome, late: SavedCardRefundOutcome): SavedCardRefundOutcome {
  return { off: first.off || late.off, failed: first.failed || late.failed, busy: false, lockHeldAt: first.lockHeldAt };
}

/**
 * The outcome's fields for the ЮKassa autopay, as facts: something was switched
 * off, something failed — both can be true. Which one the card says is the
 * card's to decide: a failure wins (`autopayMetadata`, `describeAutopayOutcome`).
 */
function savedCardFields(
  outcome: SavedCardRefundOutcome,
): Pick<AutopayRefundOutcome, 'savedCardAutopayOff' | 'savedCardAutopayFailed'> {
  return {
    ...(outcome.off ? { savedCardAutopayOff: true } : {}),
    ...(outcome.failed ? { savedCardAutopayFailed: true } : {}),
  };
}

/** What a refund's card can say if the panel stops before the autopay's end is known. */
interface RefundCardProgress {
  savedCard?: SavedCardRefundOutcome;
}

/**
 * A refund's card while its autopay's end is under way: sent once, when the
 * end is known or when the panel stops, whichever comes first.
 */
class PendingRefundCard {
  public readonly progress: RefundCardProgress = {};
  private sent = false;

  public constructor(
    public readonly paymentId: string,
    private readonly announce: (autopay: AutopayRefundOutcome) => void,
  ) {}

  public get isSent(): boolean {
    return this.sent;
  }

  public send(autopay: AutopayRefundOutcome): void {
    if (this.sent) return;
    this.sent = true;
    this.announce(autopay);
  }

  /**
   * The card, before the provider's cancel finished. A ЮKassa method the
   * refund was still waiting on is said not to be switched off: that is what
   * asks for something to be done.
   */
  public sendInterrupted(): void {
    const savedCard = this.progress.savedCard;
    this.send({
      cancelled: [],
      failed: [],
      providerCancelInterrupted: true,
      ...(savedCard === undefined
        ? {}
        : savedCard.busy
          ? { savedCardAutopayFailed: true }
          : savedCardFields(savedCard)),
    });
  }
}

/**
 * How long a stop waits for the ends of refunds' autopays under way before it
 * sends their cards as they are; see `onModuleDestroy`. Well inside Docker's
 * 10 s before it kills the container.
 */
export const AFTER_RESPONSE_SHUTDOWN_WAIT_MS = 5_000;

/**
 * How long before a refund found a saved method held by a charge that charge
 * can have been written: before it takes the lock, which it holds 30 s at most
 * (`CHARGE_LOCK_TIMEOUT_MS`). See `yookassaChargesAroundRefund`.
 */
const CHARGE_IN_FLIGHT_WINDOW_MS = 2 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
