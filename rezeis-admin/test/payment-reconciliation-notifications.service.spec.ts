import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentOpsAlertService } from '../src/modules/payments/services/payment-ops-alert.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { MoyNalogQueueService } from '../src/modules/payments/services/moy-nalog-queue.service';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import { ReferralQualificationService } from '../src/modules/referrals/services/referral-qualification.service';

type PaymentWebhookFindUniqueArgs = { where: { id: string } };
type TransactionFindUniqueArgs = { where: { id: string } | { paymentId: string } };
type TransactionFindFirstArgs = { where: { gatewayId: string } };
type TransactionUpdateArgs = {
  where: { id: string };
  data: {
    // Optional: the fenced refund-ledger write touches `gatewayData` only, and
    // leaves the status alone until the reversal decides the payment is fully
    // given back.
    status?: TransactionStatus;
    gatewayData: Record<string, unknown>;
  };
};
type ReconciliationWebhookEventRecord = {
  id: string;
  gatewayType: PaymentGatewayType;
  paymentId: string;
  providerEventId: string;
  eventStatus: string;
  status: PaymentWebhookLifecycleStatus;
  attempts: number;
  reconciliationAttempts: number;
  replayCount: number;
  lastError: string | null;
  payloadHash: string | null;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown> | null;
  receivedAt: Date;
  processedAt: Date | null;
  lastTransitionAt: Date;
  lastReplayedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type ReconciliationTransactionRecord = {
  id: string;
  paymentId: string;
  userId: string;
  subscriptionId: string | null;
  fulfilledAt: Date | null;
  status: TransactionStatus;
  isTest: boolean;
  purchaseType: PurchaseType;
  channel: PurchaseChannel;
  gatewayType: PaymentGatewayType;
  currency: Currency;
  amount: Prisma.Decimal;
  paymentAsset: string | null;
  planSnapshot: Record<string, unknown>;
  gatewayId: string | null;
  gatewayData: Record<string, unknown> | null;
  deviceTypes: readonly string[];
  createdAt: Date;
  updatedAt: Date;
};
type ReconciliationPrismaDouble = {
  $transaction: <T>(callback: (tx: ReconciliationPrismaDouble) => Promise<T>) => Promise<T>;
  /** `SELECT … FOR UPDATE` on the transaction row — the refund-ledger fence. */
  $queryRaw: (...args: readonly unknown[]) => Promise<readonly { readonly id: string }[]>;
  paymentWebhookEvent: {
    findUnique: (args: PaymentWebhookFindUniqueArgs) => Promise<ReconciliationWebhookEventRecord | null>;
  };
  transaction: {
    findUnique: (args: TransactionFindUniqueArgs) => Promise<ReconciliationTransactionRecord | null>;
    findFirst: (args: TransactionFindFirstArgs) => Promise<ReconciliationTransactionRecord | null>;
    count: (args: unknown) => Promise<number>;
    update: (args: TransactionUpdateArgs) => Promise<ReconciliationTransactionRecord>;
    updateMany: (args: {
      where: { id: string; fulfilledAt?: unknown };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  trialClaim: {
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  subscription: {
    findUnique: (args: unknown) => Promise<{
      id: string;
      remnawaveId: string | null;
      status: SubscriptionStatus;
      expiresAt: Date | null;
    } | null>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<null>;
  };
  profileSyncJob: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
};
type ReconciliationInboxDouble = {
  incrementReconciliationAttempts: (eventId: string) => Promise<void>;
  markProcessing: (eventId: string) => Promise<void>;
  markProcessed: (eventId: string) => Promise<ReconciliationWebhookEventRecord>;
  markFailed: (eventId: string, reason: string) => Promise<ReconciliationWebhookEventRecord>;
};
type ApplyCompletedTransactionArg = { id: string };
type ReconciliationMutationDouble = {
  applyCompletedTransaction: (transaction: ApplyCompletedTransactionArg) => Promise<unknown>;
};
type NotifyWebhookFailedArgs = { event: ReconciliationWebhookEventRecord };
type ReconciliationAlertDouble = {
  notifyWebhookFailed: (input: NotifyWebhookFailedArgs) => Promise<void>;
};
type ProcessPartnerEarningArg = {
  payerUserId: string;
  paymentAmountMinorUnits: number;
  gatewayType: string | null;
  sourceTransactionId: string | null;
};
type ReconciliationPartnerEarningsDouble = {
  processPartnerEarning: (input: ProcessPartnerEarningArg) => Promise<void>;
  reverseEarningsForTransaction: (transactionId: string) => Promise<number>;
};
type ReconciliationReferralQualificationDouble = {
  qualifyReferralAfterPurchase: (transactionId: string) => Promise<void>;
  reverseQualificationForTransaction: (transactionId: string) => Promise<void>;
};
type ReconciliationProfileSyncQueueDouble = {
  enqueue: (syncJobId: string) => Promise<void>;
};

describe('PaymentReconciliationService reconciliation side effects', () => {
  it('applies the subscription mutation, enqueues profile sync, and runs post-payment hooks', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.mutationCalls, ['tx-1']);
    assert.deepStrictEqual(state.profileSyncEnqueueCalls, ['sync-1']);
    assert.deepStrictEqual(state.referralQualificationCalls, ['tx-1']);
    assert.deepStrictEqual(state.partnerEarningCalls, [
      {
        payerUserId: 'user-1',
        paymentAmountMinorUnits: 800,
        gatewayType: PaymentGatewayType.YOOKASSA,
        sourceTransactionId: 'tx-1',
      },
    ]);
    assert.deepStrictEqual(state.callOrder, ['update', 'mutation', 'enqueue:sync-1', 'referral-qualification', 'partner-earnings']);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('skips duplicate subscription mutation when the refreshed transaction is already fulfilled', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: 'subscription-existing',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.mutationCalls, []);
    assert.deepStrictEqual(state.profileSyncEnqueueCalls, []);
    assert.deepStrictEqual(state.referralQualificationCalls, ['tx-1']);
    assert.deepStrictEqual(state.partnerEarningCalls, [
      {
        payerUserId: 'user-1',
        paymentAmountMinorUnits: 800,
        gatewayType: PaymentGatewayType.YOOKASSA,
        sourceTransactionId: 'tx-1',
      },
    ]);
    assert.deepStrictEqual(state.callOrder, ['update', 'referral-qualification', 'partner-earnings']);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('does not mark the webhook processed if the completion mutation throws', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
      mutationShouldThrow: true,
    });
    const service = createService(state);

    await assert.rejects(() => service.reconcileWebhookEvent('event-1'), /forced mutation failure/);

    assert.deepStrictEqual(state.callOrder, ['update', 'mutation']);
    assert.deepStrictEqual(state.markProcessedCalls, []);
    assert.deepStrictEqual(state.markFailedCalls.length, 1);
    assert.deepStrictEqual(state.alertCalls.length, 1);
  });

  it('marks canceled payment outcomes processed without completion side effects', async () => {
    const state = createState({
      eventStatus: 'failed',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: 'subscription-1',
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.mutationCalls, []);
    assert.deepStrictEqual(state.profileSyncEnqueueCalls, []);
    assert.deepStrictEqual(state.referralQualificationCalls, []);
    assert.deepStrictEqual(state.partnerEarningCalls, []);
    assert.deepStrictEqual(state.callOrder, ['update']);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('does not re-run side effects for an already fulfilled terminal transaction', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.mutationCalls, []);
    assert.deepStrictEqual(state.profileSyncEnqueueCalls, []);
    assert.deepStrictEqual(state.referralQualificationCalls, []);
    assert.deepStrictEqual(state.partnerEarningCalls, []);
    assert.deepStrictEqual(state.transactionUpdateCalls, []);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('retries fulfillment when a completed transaction has no fulfillment stamp', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: null,
      refreshedFulfilledAt: null,
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.mutationCalls, ['tx-1']);
    assert.deepStrictEqual(state.profileSyncEnqueueCalls, ['sync-1']);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('stores only bounded webhook failure diagnostics when reconciliation side effects fail', async () => {
    const rawProviderDiagnostic = 'provider reconciliation failed at https://provider.example/webhooks/0194f4b6-7cc7-7ecb-9f62-123456789abc with token=provider-secret-fragment payment_provider_id=provider-raw-id';
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
      mutationError: new Error(rawProviderDiagnostic),
    });
    const service = createService(state);

    await assert.rejects(() => service.reconcileWebhookEvent('event-1'), /provider reconciliation failed/);

    assert.equal(state.markFailedCalls.length, 1);
    assert.deepStrictEqual(state.markFailedCalls[0], ['event-1', 'FAILED']);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /provider\.example/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /provider-secret-fragment/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /0194f4b6-7cc7-7ecb-9f62-123456789abc/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /provider-raw-id/);
  });

  it('marks the webhook failed when immediate profile sync enqueue fails', async () => {
    const rawQueueFailure = 'redis://admin:secret-password@queue.internal/0 payload subscription_id=sub_secret token=provider-token';
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
      enqueueError: new Error(rawQueueFailure),
    });
    const service = createService(state);

    await assert.rejects(() => service.reconcileWebhookEvent('event-1'), /redis:\/\//);

    assert.deepStrictEqual(state.callOrder, ['update', 'mutation', 'enqueue:sync-1']);
    assert.equal(state.markFailedCalls.length, 1);
    assert.deepStrictEqual(state.markFailedCalls[0], ['event-1', 'FAILED']);
    assert.equal(state.alertCalls.length, 1);
    assert.deepStrictEqual(state.markProcessedCalls, []);
    assert.deepStrictEqual(state.referralQualificationCalls, []);
    assert.deepStrictEqual(state.partnerEarningCalls, []);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /secret-password/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /redis:\/\//);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /sub_secret/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /provider-token/);
  });

  it('reverses all side-effects on a refund of an already-fulfilled payment (HIGH #6)', async () => {
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    // All four reversals ran; no forward hooks re-ran.
    assert.deepStrictEqual(state.partnerReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.referralReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.moyNalogCancelCalls, ['tx-1']);
    assert.deepStrictEqual(state.adRevertCalls, ['tx-1']);
    assert.deepStrictEqual(state.partnerEarningCalls, []);
    assert.deepStrictEqual(state.referralQualificationCalls, []);
    // Transaction marked CANCELED + stamped, webhook processed.
    assert.equal(state.transactionUpdateCalls.length, 1);
    assert.equal(state.transactionUpdateCalls[0].data.status, TransactionStatus.CANCELED);
    assert.equal(
      typeof (state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>).refundReversedAt,
      'string',
    );
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('revokes access on a refunded NEW purchase and pushes it to the panel', async () => {
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.equal(state.subscriptionUpdateCalls.length, 1);
    assert.equal(state.subscriptionUpdateCalls[0].data.status, 'EXPIRED');
    assert.ok(state.subscriptionUpdateCalls[0].data.expiresAt instanceof Date);
    // Remnawave must actually be told, otherwise a refunded customer keeps
    // consuming paid capacity.
    assert.equal(state.syncJobCreateCalls.length, 1);
    assert.equal(state.syncJobCreateCalls[0].action, 'UPDATE');
    // No `propagateStatus`: EXPIRED is a derived local state and the sync
    // processor refuses to push derived states upstream — access is cut by the
    // `expireAt` written on the subscription instead.
    assert.deepStrictEqual(state.syncJobCreateCalls[0].payload, { source: 'PAYMENT_REFUND' });
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.subscriptionRevoked, true);
    assert.equal(gatewayData.refundRevokedFromStatus, 'ACTIVE');
  });

  it('records that a refund could not reach the panel when the link is missing', async () => {
    // HALF A REVOCATION, PREVIOUSLY REPORTED AS A WHOLE ONE.
    //
    // The row below is expired locally with `expiresAt = now`, so rezeis
    // believes the refunded customer has no access. The panel is never told,
    // because there is no id to tell it with — the create/update decoder used
    // to cast an undecoded 3.x body, leaving `uuid` and `id` undefined while
    // the panel username landed — so the profile keeps serving traffic on
    // whatever expiry it last received. Nothing retries: the revocation is
    // one-shot best-effort and no sweep revisits it.
    //
    // The old code just did not enter the `remnawaveId !== null` branch, and
    // the transaction's audit blob came out identical to a refund whose panel
    // push succeeded.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      subscriptionRow: {
        id: 'subscription-1',
        remnawaveId: null,
        remnawavePanelUsername: 'rz_frank_1',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date('2026-05-19T12:00:00.000Z'),
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    // Local access is still cut — that half is unchanged and must stay.
    assert.equal(state.subscriptionUpdateCalls.length, 1);
    assert.equal(state.subscriptionUpdateCalls[0].data.status, 'EXPIRED');
    // And still no job, because there is nothing to address.
    assert.deepStrictEqual(state.syncJobCreateCalls, []);

    // The audit now says so, and names the profile still running.
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.subscriptionRevoked, true);
    assert.equal(gatewayData.refundRevocationPanelPushSkipped, true);
    assert.equal(
      gatewayData.refundRevocationPanelPushSkippedReason,
      'SUBSCRIPTION_HAS_NO_PANEL_LINK',
    );
    assert.equal(gatewayData.refundRevocationStrandedPanelUsername, 'rz_frank_1');
    // The pre-refund state is still captured, so the earlier audit keys are not
    // clobbered by the new ones.
    assert.equal(gatewayData.refundRevokedFromStatus, 'ACTIVE');
  });

  it('does NOT revoke a subscription that later payments extended', async () => {
    // RENEW updates the same subscription row, and the original NEW transaction
    // keeps pointing at it. A chargeback months later must not burn access the
    // customer has since paid to extend.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      otherCompletedPaymentsOnSubscription: 2,
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.subscriptionUpdateCalls, []);
    assert.deepStrictEqual(state.syncJobCreateCalls, []);
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.subscriptionRevoked, false);
    assert.equal(gatewayData.refundNeedsManualReview, true);
    assert.equal(gatewayData.refundRevocationSkippedReason, 'SUBSCRIPTION_HAS_OTHER_PAYMENTS');
    // The money-side reversal still ran — only access was left alone.
    assert.deepStrictEqual(state.partnerReversalCalls, ['tx-1']);
  });

  it('does NOT lift an operator ban when revoking on refund', async () => {
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      subscriptionRow: {
        id: 'subscription-1',
        remnawaveId: 'rw-1',
        status: SubscriptionStatus.DISABLED,
        expiresAt: null,
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.subscriptionUpdateCalls, []);
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundRevocationSkippedReason, 'SUBSCRIPTION_DISABLED');
  });

  it('leaves everything intact on a PARTIAL refund and flags it for review', async () => {
    // Reversal is all-or-nothing: applying it to a partial giveback would wipe
    // the partner's whole commission and cancel the full tax income.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-1', status: 'succeeded', amount: { value: '1.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, []);
    assert.deepStrictEqual(state.referralReversalCalls, []);
    assert.deepStrictEqual(state.moyNalogCancelCalls, []);
    assert.deepStrictEqual(state.adRevertCalls, []);
    assert.deepStrictEqual(state.subscriptionUpdateCalls, []);
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundNeedsManualReview, true);
    // Running total, shared with the operator-initiated refund path.
    assert.equal(gatewayData.refundedAmountTotal, '1.00');
    // Status stays COMPLETED — the payment was not fully given back.
    assert.equal(state.transactionUpdateCalls[0].data.status, undefined);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('reverses in full once accumulated partial refunds reach the captured amount', async () => {
    // The money leak this guards: two 4-of-8 refunds are each "partial", so
    // comparing only the current event would leave the customer fully refunded
    // while partner commission, referral qualification, tax income and the
    // subscription were never reversed.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      // 4 already refunded earlier; the transaction is worth 8.
      gatewayDataOverride: { refundedAmountTotal: '4.00' },
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-2', status: 'succeeded', amount: { value: '4.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.referralReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.moyNalogCancelCalls, ['tx-1']);
    assert.deepStrictEqual(state.adRevertCalls, ['tx-1']);
    assert.equal(reversalWrites(state).length, 1);
    // The refund that crossed is ledgered too, so a panel refund still in
    // flight has something to deduplicate against.
    const ledgerWrite = state.transactionUpdateCalls[0].data.gatewayData;
    assert.equal(ledgerWrite.refundedAmountTotal, '8.00');
    assert.equal((ledgerWrite.refunds as unknown[]).length, 1);
  });

  it('does NOT double-count a panel refund when its own webhook arrives', async () => {
    // The normal flow, and the money-losing defect this pins. An operator
    // refunds 4 of 8 in the panel; the panel ledgers it and writes the total;
    // YooKassa then sends `refund.succeeded` for that SAME refund. Blindly
    // adding the amount again read as 8-of-8: the customer's subscription was
    // expired and revoked at Remnawave, the partner's whole commission debited
    // and the full income cancelled at МойНалог — on revenue we kept.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      gatewayDataOverride: {
        refundedAmountTotal: '4.00',
        refunds: [{ refundId: 'refund-1', amount: '4.00', at: '2026-04-19T12:00:00.000Z' }],
      },
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-1', status: 'succeeded', amount: { value: '4.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, []);
    assert.deepStrictEqual(state.referralReversalCalls, []);
    assert.deepStrictEqual(state.moyNalogCancelCalls, []);
    assert.deepStrictEqual(state.adRevertCalls, []);
    // The subscription the customer is still paying for stays exactly as it was.
    assert.deepStrictEqual(state.subscriptionUpdateCalls, []);
    assert.deepStrictEqual(state.syncJobCreateCalls, []);
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundedAmountTotal, '4.00');
    // Recorded once, not twice.
    assert.equal((gatewayData.refunds as unknown[]).length, 1);
    assert.equal(state.transactionUpdateCalls[0].data.status, undefined);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('reverses exactly once when a genuinely second refund completes the total', async () => {
    // Same starting point as above — 4 already refunded through the panel — but
    // this webhook is a DIFFERENT refund. Deduplication must not swallow it:
    // the customer is now whole, so everything has to be reversed.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      gatewayDataOverride: {
        refundedAmountTotal: '4.00',
        refunds: [{ refundId: 'refund-1', amount: '4.00', at: '2026-04-19T12:00:00.000Z' }],
      },
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-2', status: 'succeeded', amount: { value: '4.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.referralReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.moyNalogCancelCalls, ['tx-1']);
    assert.deepStrictEqual(state.adRevertCalls, ['tx-1']);
    // Exactly once: one reversal, one status write.
    assert.equal(reversalWrites(state).length, 1);
    assert.deepStrictEqual(state.subscriptionUpdateCalls.length, 1);
    // Both refunds are in the ledger and the total is the captured amount.
    const ledgerWrite = state.transactionUpdateCalls[0].data.gatewayData;
    assert.deepStrictEqual(
      (ledgerWrite.refunds as ReadonlyArray<{ refundId: string }>).map((entry) => entry.refundId),
      ['refund-1', 'refund-2'],
    );
    assert.equal(ledgerWrite.refundedAmountTotal, '8.00');
  });

  // The genuine interleave, both writers on ONE row with a real lock. Two
  // DIFFERENT refunds of 4 against a captured 8, so neither may deduplicate the
  // other away and the pair is exactly a full refund. Under-counting is safe by
  // construction — a lost entry falls into the partial branch, which flags for
  // manual review rather than revoking anything — so this is hardening, not an
  // active money leak. The accounting was still wrong and the reversal that
  // should have fired did not.
  it('panel-then-webhook: re-reads inside the lock instead of the snapshot it arrived with', async () => {
    // The operator's refund commits the instant reconciliation has loaded the
    // row. `handleRefundReversal` used to merge onto that snapshot, so the panel
    // entry and its share of the total were erased by a write that never saw
    // them, and the pair never added up to the captured amount.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      panelRefund: { refundId: 'refund-2', amount: '4.00', at: 'snapshot' },
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-1', status: 'succeeded', amount: { value: '4.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');
    await state.drain();

    assert.deepStrictEqual(state.commitOrder, ['panel:refund-2', 'webhook', 'webhook']);
    assert.deepStrictEqual(ledgerIds(state), ['refund-2', 'refund-1']);
    assert.equal(state.gatewayDataOverride?.refundedAmountTotal, '8.00');
    // Exactly one writer reverses, and it is the one whose entry crossed.
    assert.deepStrictEqual(
      [...state.partnerReversalCalls, ...state.panelReversalCalls],
      ['tx-1'],
    );
    assert.equal(reversalWrites(state).length, 1);
    assert.deepStrictEqual(state.subscriptionUpdateCalls.length, 1);
  });

  it('webhook-then-panel: holds the row so a panel refund cannot land inside the write', async () => {
    // Mirror image: the operator's refund commits at the instant this path goes
    // to persist. Without the fence it slipped between the read and the write
    // and was overwritten wholesale; holding the row makes it queue and merge
    // onto what this write committed, so its entry survives and IT is the one
    // that crosses the captured amount.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      panelRefund: { refundId: 'refund-2', amount: '4.00', at: 'write' },
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-1', status: 'succeeded', amount: { value: '4.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');
    await state.drain();

    assert.deepStrictEqual(state.commitOrder, ['webhook', 'panel:refund-2']);
    assert.deepStrictEqual(ledgerIds(state), ['refund-1', 'refund-2']);
    assert.equal(state.gatewayDataOverride?.refundedAmountTotal, '8.00');
    // 4 of 8 is all this webhook knew about, so it correctly stayed in the
    // partial branch — and the panel refund that completed the total is the one
    // that reverses. Exactly one, either way.
    assert.deepStrictEqual(
      [...state.partnerReversalCalls, ...state.panelReversalCalls],
      ['panel:refund-2'],
    );
    assert.deepStrictEqual(reversalWrites(state), []);
  });

  it('ledgers the refund id so a panel refund still in flight can dedupe on it', async () => {
    // The other half of the race: when the webhook wins, the panel re-reads
    // `gatewayData` before writing. It dedupes on `refunds[].refundId`, so the
    // webhook has to record the entry — otherwise the panel finds nothing,
    // counts the refund it just issued a second time and runs the full reversal
    // itself. `payment-refund.service.spec.ts` consumes exactly this shape.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'refund-1', status: 'succeeded', amount: { value: '4.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    const ledger = gatewayData.refunds as ReadonlyArray<Record<string, unknown>>;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].refundId, 'refund-1');
    assert.equal(ledger[0].amount, '4.00');
    assert.equal(typeof ledger[0].at, 'string');
    assert.equal(gatewayData.refundedAmountTotal, '4.00');
  });

  it('never sums a refund the provider reports without an id', async () => {
    // No id means no way to prove this is not the refund already recorded.
    // Summing would risk revoking a paying customer, so the amount is taken as
    // a floor (max) instead: it can only under-count, and an under-count lands
    // in the partial branch, which leaves everything intact and asks for a human.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      gatewayDataOverride: { refundedAmountTotal: '4.00' },
      rawPayload: {
        event: 'refund.succeeded',
        object: { status: 'succeeded', amount: { value: '4.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, []);
    assert.deepStrictEqual(state.subscriptionUpdateCalls, []);
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundedAmountTotal, '4.00');
    assert.equal(gatewayData.refundNeedsManualReview, true);
  });

  it('still reverses an id-less refund that covers the whole payment on its own', async () => {
    // The flip side of the rule above: taking the amount as a floor must not
    // lose a single full refund that nothing else has recorded yet.
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      rawPayload: {
        event: 'refund.succeeded',
        object: { status: 'succeeded', amount: { value: '8.00', currency: 'RUB' } },
      },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, ['tx-1']);
    assert.equal(reversalWrites(state).length, 1);
  });

  it('reverses side-effects on a Heleket/Cryptomus refund_paid status', async () => {
    // Heleket & Cryptomus emit the raw `refund_paid` (not `REFUNDED`). The
    // reconciler must recognise it as a completed refund and reverse, exactly
    // like the canonical REFUNDED status above.
    const state = createState({
      eventStatus: 'refund_paid',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.referralReversalCalls, ['tx-1']);
    assert.deepStrictEqual(state.moyNalogCancelCalls, ['tx-1']);
    assert.deepStrictEqual(state.adRevertCalls, ['tx-1']);
    assert.equal(state.transactionUpdateCalls[0].data.status, TransactionStatus.CANCELED);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('does NOT reverse on an in-flight refund_process (only a completed refund)', async () => {
    // `refund_process` means the refund is still being processed — reversing now
    // would be premature. It must fall through to the already-fulfilled ack.
    const state = createState({
      eventStatus: 'refund_process',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, []);
    assert.deepStrictEqual(state.referralReversalCalls, []);
    assert.deepStrictEqual(state.moyNalogCancelCalls, []);
    assert.deepStrictEqual(state.adRevertCalls, []);
    assert.deepStrictEqual(state.transactionUpdateCalls, []);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('is idempotent: a replayed refund webhook (already reversed) does nothing', async () => {
    const state = createState({
      eventStatus: 'REFUNDED_PAYMENT',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      gatewayDataOverride: { refundReversedAt: '2026-04-19T12:00:00.000Z' },
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, []);
    assert.deepStrictEqual(state.referralReversalCalls, []);
    assert.deepStrictEqual(state.moyNalogCancelCalls, []);
    assert.deepStrictEqual(state.adRevertCalls, []);
    assert.deepStrictEqual(state.transactionUpdateCalls, []);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('does NOT trigger reversal for a plain cancel/expiry of a fulfilled payment', async () => {
    // An ordinary CANCELED provider status on a fulfilled tx must NOT reverse
    // (only a refund/chargeback does) — it early-returns as already-fulfilled.
    const state = createState({
      eventStatus: 'canceled',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.partnerReversalCalls, []);
    assert.deepStrictEqual(state.referralReversalCalls, []);
    assert.deepStrictEqual(state.moyNalogCancelCalls, []);
    assert.deepStrictEqual(state.adRevertCalls, []);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });
});

function createService(state: ReturnType<typeof createState>): PaymentReconciliationService {
  // The transaction row, and the lock over it. `$transaction` models
  // `SELECT ... FOR UPDATE`: whoever is inside the callback holds the row, and
  // every other writer queues behind them. That is the whole difference the
  // refund fence makes — before it this path merged onto the snapshot
  // `findTransactionForEvent` loaded at the top of reconciliation and wrote
  // with a bare `update`, so a concurrent panel refund landing anywhere in
  // between was silently overwritten.
  let rowTail: Promise<void> = Promise.resolve();
  const withRowLock = async <T>(run: () => Promise<T> | T): Promise<T> => {
    const previous = rowTail;
    let release: () => void = () => undefined;
    rowTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  };

  /**
   * An operator refund committing at the armed instant, written exactly as
   * `PaymentRefundService.refundTransaction` writes it: id-keyed ledger, a
   * total that only grows, and the all-or-nothing reversal iff this entry took
   * it to the captured amount. `payment-refund.service.spec.ts` pins that
   * producing shape and drives the mirror-image race against the real service.
   */
  const commitPanelRefund = (refund: { refundId: string; amount: string }): Promise<void> =>
    withRowLock(() => {
      const live = state.gatewayDataOverride ?? {};
      const ledger = Array.isArray(live.refunds)
        ? [...(live.refunds as ReadonlyArray<{ refundId: string; amount: string; at: string }>)]
        : [];
      const alreadyLedgered = ledger.some((entry) => entry.refundId === refund.refundId);
      if (!alreadyLedgered) {
        ledger.push({ ...refund, at: '2026-04-19T12:30:00.000Z' });
      }
      const total = Math.max(
        Number(live.refundedAmountTotal ?? '0') + (alreadyLedgered ? 0 : Number(refund.amount)),
        ledger.reduce((sum, entry) => sum + Number(entry.amount), 0),
      );
      state.gatewayDataOverride = {
        ...live,
        refunds: ledger,
        refundedAmountTotal: total.toFixed(2),
      };
      state.commitOrder.push(`panel:${refund.refundId}`);
      if (total >= CAPTURED_AMOUNT - 0.000001) {
        state.panelReversalCalls.push(`panel:${refund.refundId}`);
      }
    });
  const firePanelRefund = (moment: 'snapshot' | 'write'): void => {
    const armed = state.panelRefund;
    if (armed === null || armed.at !== moment) return;
    state.panelRefund = null;
    state.pendingWriters.push(commitPanelRefund(armed));
  };

  const prismaService = {
    $queryRaw: async (..._args: readonly unknown[]) => [{ id: 'tx-1' }],
    paymentWebhookEvent: {
      findUnique: async (_args: PaymentWebhookFindUniqueArgs) => state.event,
    },
    transaction: {
      findUnique: async (args: TransactionFindUniqueArgs) => {
        if ('id' in args.where && args.where.id === 'tx-1') {
          return createTransaction({
            id: 'tx-1',
            status: state.updatedStatus ?? state.initialTransactionStatus,
            subscriptionId: state.refreshedSubscriptionId,
            fulfilledAt: state.refreshedFulfilledAt,
            gatewayData: state.gatewayDataOverride,
          });
        }
        // `findTransactionForEvent`'s lookup. Snapshot the row BEFORE letting a
        // writer armed for this instant through, so the reconciler is holding
        // exactly what a stale read would have handed it.
        const snapshot = createTransaction({
          id: 'tx-1',
          status: state.initialTransactionStatus,
          subscriptionId: 'subscription-original',
          fulfilledAt: state.refreshedFulfilledAt,
          gatewayData: state.gatewayDataOverride,
        });
        firePanelRefund('snapshot');
        return snapshot;
      },
      findFirst: async (_args: TransactionFindFirstArgs) => null,
      // Other completed payments against the same subscription. A refund must
      // NOT expire a subscription that later payments extended.
      count: async (_args: unknown) => state.otherCompletedPaymentsOnSubscription,
      // Atomic fulfilment claim (where fulfilledAt: null) / release
      // (where fulfilledAt: { not: null }). The claim matches only when the
      // refreshed transaction is not yet fulfilled.
      updateMany: async (args: {
        where: { id: string; fulfilledAt?: unknown };
        data: Record<string, unknown>;
      }) => {
        const isClaim = args.where.fulfilledAt === null;
        if (isClaim) {
          return { count: state.refreshedFulfilledAt === null ? 1 : 0 };
        }
        return { count: 1 };
      },
      update: async (args: TransactionUpdateArgs) => {
        state.transactionUpdateCalls.push(args);
        // Let a writer armed for this instant commit first. A real database
        // only lets it through when the row is not locked — under the fence it
        // queues and lands after this write instead of being erased by it.
        firePanelRefund('write');
        await Promise.resolve();
        state.gatewayDataOverride = args.data.gatewayData;
        state.updatedStatus = args.data.status;
        state.commitOrder.push('webhook');
        state.callOrder.push('update');
        return createTransaction({
          id: args.where.id,
          status: args.data.status ?? state.initialTransactionStatus,
          subscriptionId: state.refreshedSubscriptionId,
        });
      },
    },
    trialClaim: { updateMany: async () => ({ count: 0 }) },
    // Refund revocation surface (D3). Without these the revocation branch threw
    // inside its own try/catch and every refund test passed while never
    // exercising it.
    subscription: {
      findUnique: async (_args: unknown) => state.subscriptionRow,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        state.subscriptionUpdateCalls.push(args);
        return null;
      },
    },
    profileSyncJob: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.syncJobCreateCalls.push(args.data);
        return { id: 'sync-job-1' };
      },
    },
  } as Omit<ReconciliationPrismaDouble, '$transaction'>;
  const transactionalPrisma: ReconciliationPrismaDouble = {
    ...prismaService,
    $transaction: async <T>(callback: (tx: ReconciliationPrismaDouble) => Promise<T>): Promise<T> =>
      withRowLock(() => callback(transactionalPrisma)),
  };
  const paymentWebhookInboxService: ReconciliationInboxDouble = {
    incrementReconciliationAttempts: async (eventId: string) => {
      state.incrementCalls.push(eventId);
    },
    markProcessing: async (eventId: string) => {
      state.markProcessingCalls.push(eventId);
    },
    markProcessed: async (eventId: string) => {
      state.markProcessedCalls.push(eventId);
      return state.event;
    },
    markFailed: async (eventId: string, reason: string) => {
      state.markFailedCalls.push([eventId, reason]);
      return state.event;
    },
  };
  const paymentSubscriptionMutationService: ReconciliationMutationDouble = {
    applyCompletedTransaction: async (transaction: ApplyCompletedTransactionArg) => {
      state.mutationCalls.push(transaction.id);
      state.callOrder.push('mutation');
      if (state.mutationShouldThrow) {
        throw state.mutationError ?? new Error('forced mutation failure');
      }
      return { syncJobs: [{ id: 'sync-1' }] };
    },
  };
  const paymentOpsAlertService: ReconciliationAlertDouble = {
    notifyWebhookFailed: async (input: NotifyWebhookFailedArgs) => {
      state.alertCalls.push(input);
    },
  };
  const partnerEarningsService: ReconciliationPartnerEarningsDouble = {
    processPartnerEarning: async (input: ProcessPartnerEarningArg) => {
      state.partnerEarningCalls.push(input);
      state.callOrder.push('partner-earnings');
    },
    reverseEarningsForTransaction: async (transactionId: string) => {
      state.partnerReversalCalls.push(transactionId);
      state.callOrder.push('partner-reversal');
      return 0;
    },
  };
  const referralQualificationService: ReconciliationReferralQualificationDouble = {
    qualifyReferralAfterPurchase: async (transactionId: string) => {
      state.referralQualificationCalls.push(transactionId);
      state.callOrder.push('referral-qualification');
    },
    reverseQualificationForTransaction: async (transactionId: string) => {
      state.referralReversalCalls.push(transactionId);
      state.callOrder.push('referral-reversal');
    },
  };
  const profileSyncQueueService: ReconciliationProfileSyncQueueDouble = {
    enqueue: async (syncJobId: string) => {
      state.profileSyncEnqueueCalls.push(syncJobId);
      state.callOrder.push(`enqueue:${syncJobId}`);
      if (state.enqueueError) {
        throw state.enqueueError;
      }
    },
  };
  return new PaymentReconciliationService(
    transactionalPrisma as unknown as PrismaService,
    paymentWebhookInboxService as unknown as PaymentWebhookInboxService,
    paymentSubscriptionMutationService as unknown as PaymentSubscriptionMutationService,
    paymentOpsAlertService as unknown as PaymentOpsAlertService,
    partnerEarningsService as unknown as PartnerEarningsService,
    referralQualificationService as unknown as ReferralQualificationService,
    profileSyncQueueService as unknown as ProfileSyncQueueService,
    { warn: () => {}, info: () => {}, error: () => {}, emit: () => {} } as never,
    {
      enqueueRegisterIncome: async () => {},
      enqueueCancelIncome: async (transactionId: string) => {
        state.moyNalogCancelCalls.push(transactionId);
        state.callOrder.push('moynalog-cancel');
      },
    } as unknown as MoyNalogQueueService,
    {
      recordFirstPurchase: async () => {},
      revertConversion: async (transactionId: string) => {
        state.adRevertCalls.push(transactionId);
        state.callOrder.push('ad-revert');
      },
    } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    // YooKassa completions are verified against the provider before they are
    // applied; this suite is about what happens once they are confirmed.
    {
      verifyCompletion: async () => ({ outcome: 'CONFIRMED', providerStatus: 'succeeded' }),
    } as never,
  );
}

function createState(input: {
  readonly eventStatus: string;
  readonly initialTransactionStatus: TransactionStatus;
  readonly refreshedSubscriptionId: string | null;
  readonly refreshedFulfilledAt?: Date | null;
  readonly mutationShouldThrow?: boolean;
  readonly mutationError?: Error;
  readonly enqueueError?: Error;
  readonly gatewayDataOverride?: Record<string, unknown> | null;
  /** Raw webhook payload override — used to model partial refunds. */
  readonly rawPayload?: Record<string, unknown>;
  /** Subscription row the refund revocation reads, `null` = missing. */
  readonly subscriptionRow?: {
    readonly id: string;
    readonly remnawaveId: string | null;
    readonly remnawavePanelUsername?: string | null;
    readonly status: SubscriptionStatus;
    readonly expiresAt: Date | null;
  } | null;
  /** Completed payments on the same subscription besides the refunded one. */
  readonly otherCompletedPaymentsOnSubscription?: number;
  /**
   * An operator refund racing this webhook, committed at `at`: `'snapshot'` is
   * the instant reconciliation has loaded the row (so the reconciler is holding
   * a stale copy), `'write'` is the instant it goes to persist (so it is inside
   * its own critical section, if it has one).
   */
  readonly panelRefund?: { refundId: string; amount: string; at: 'snapshot' | 'write' } | null;
}) {
  const now = new Date('2026-04-19T12:00:00.000Z');
  const pendingWriters: Array<Promise<void>> = [];
  return {
    event: {
      id: 'event-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      paymentId: 'payment-1',
      providerEventId: 'provider-event-1',
      eventStatus: input.eventStatus,
      status: PaymentWebhookLifecycleStatus.PROCESSING,
      attempts: 1,
      reconciliationAttempts: 1,
      replayCount: 0,
      lastError: null,
      payloadHash: 'hash-1',
      rawPayload: input.rawPayload ?? { object: { id: 'payment-1', status: input.eventStatus } },
      normalizedPayload: null,
      receivedAt: now,
      processedAt: null,
      lastTransitionAt: now,
      lastReplayedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    initialTransactionStatus: input.initialTransactionStatus,
    refreshedSubscriptionId: input.refreshedSubscriptionId,
    refreshedFulfilledAt: input.refreshedFulfilledAt ?? null,
    updatedStatus: undefined as TransactionStatus | undefined,
    incrementCalls: [] as string[],
    markProcessingCalls: [] as string[],
    markProcessedCalls: [] as string[],
    markFailedCalls: [] as [string, string][],
    transactionUpdateCalls: [] as TransactionUpdateArgs[],
    mutationCalls: [] as string[],
    profileSyncEnqueueCalls: [] as string[],
    mutationShouldThrow: input.mutationShouldThrow ?? input.mutationError !== undefined,
    mutationError: input.mutationError ?? null,
    enqueueError: input.enqueueError ?? null,
    callOrder: [] as string[],
    alertCalls: [] as NotifyWebhookFailedArgs[],
    referralQualificationCalls: [] as string[],
    partnerEarningCalls: [] as ProcessPartnerEarningArg[],
    partnerReversalCalls: [] as string[],
    referralReversalCalls: [] as string[],
    moyNalogCancelCalls: [] as string[],
    adRevertCalls: [] as string[],
    gatewayDataOverride: input.gatewayDataOverride ?? null,
    subscriptionRow:
      input.subscriptionRow === undefined
        ? {
            id: 'subscription-1',
            remnawaveId: 'rw-1',
            remnawavePanelUsername: 'rz_default_1',
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date('2026-05-19T12:00:00.000Z'),
          }
        : input.subscriptionRow,
    otherCompletedPaymentsOnSubscription: input.otherCompletedPaymentsOnSubscription ?? 0,
    subscriptionUpdateCalls: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    syncJobCreateCalls: [] as Array<Record<string, unknown>>,
    panelRefund: input.panelRefund ?? null,
    /** Reversals the racing panel refund ran, if its entry crossed the total. */
    panelReversalCalls: [] as string[],
    /** Who committed to the row, in order. */
    commitOrder: [] as string[],
    pendingWriters,
    /** Waits for the racing writer to drain off the row lock. */
    drain: async (): Promise<void> => {
      await Promise.all(pendingWriters);
    },
  };
}

/** What `createTransaction` below charges — the full-refund threshold. */
const CAPTURED_AMOUNT = 8;

/**
 * The writes that mark the payment reversed. Selected by predicate rather than
 * by index: a refund that completes the total now writes TWICE — the ledger
 * entry and running total go in first, under the row lock, and only then does
 * the reversal commit CANCELED. The ledger write has to be inside the fence or
 * the crossing refund leaves no entry for the other writer to deduplicate
 * against, which is the race this pins.
 */
function reversalWrites(
  state: ReturnType<typeof createState>,
): readonly TransactionUpdateArgs[] {
  return state.transactionUpdateCalls.filter(
    (call) => call.data.status === TransactionStatus.CANCELED,
  );
}

/** Provider refund ids on the row as it now stands, in ledger order. */
function ledgerIds(state: ReturnType<typeof createState>): readonly string[] {
  const refunds = state.gatewayDataOverride?.refunds;
  return Array.isArray(refunds)
    ? (refunds as ReadonlyArray<{ refundId: string }>).map((entry) => entry.refundId)
    : [];
}

function createTransaction(input: {
  readonly id: string;
  readonly status: TransactionStatus;
  readonly subscriptionId: string | null;
  readonly fulfilledAt?: Date | null;
  readonly gatewayData?: Record<string, unknown> | null;
}) {
  return {
    id: input.id,
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: input.subscriptionId,
    fulfilledAt: input.fulfilledAt ?? null,
    status: input.status,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    currency: Currency.USD,
    amount: new Prisma.Decimal('8.00'),
    paymentAsset: null,
    planSnapshot: { id: 'plan-1', selectedDurationDays: 30, pricing: { discountSource: 'PURCHASE', discountPercent: 20 } },
    gatewayId: null,
    gatewayData: input.gatewayData ?? null,
    deviceTypes: [],
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}
