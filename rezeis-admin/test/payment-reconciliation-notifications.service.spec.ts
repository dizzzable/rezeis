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
    status: TransactionStatus;
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

  it('recovers a stale constructor ADDITIONAL create-subscription claim', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: null,
      refreshedFulfilledAt: new Date('2020-01-01T00:00:00.000Z'),
      purchaseType: PurchaseType.ADDITIONAL,
      planSnapshotOverride: constructorSnapshotMarker(),
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.equal(state.staleClaimReleased, true);
    assert.deepStrictEqual(state.mutationCalls, ['tx-1']);
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

  it('revokes the standalone subscription created by constructor ADDITIONAL', async () => {
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      purchaseType: PurchaseType.ADDITIONAL,
      planSnapshotOverride: constructorSnapshotMarker(),
    });
    await createService(state).reconcileWebhookEvent('event-1');

    assert.equal(state.subscriptionUpdateCalls.length, 1);
    assert.equal(state.subscriptionUpdateCalls[0].data.status, SubscriptionStatus.EXPIRED);
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.subscriptionRevoked, true);
    assert.equal(gatewayData.refundNeedsManualReview, undefined);
  });

  it('does not mechanically revoke an ordinary ADDITIONAL purchase', async () => {
    const state = createState({
      eventStatus: 'REFUNDED',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
      refreshedFulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      purchaseType: PurchaseType.ADDITIONAL,
      planSnapshotOverride: { snapshotSource: 'ADDON_PURCHASE' },
    });
    await createService(state).reconcileWebhookEvent('event-1');

    assert.deepEqual(state.subscriptionUpdateCalls, []);
    const gatewayData = state.transactionUpdateCalls[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.subscriptionRevoked, false);
    assert.equal(gatewayData.refundNeedsManualReview, true);
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
    assert.equal(state.transactionUpdateCalls[0].data.status, TransactionStatus.CANCELED);
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
  const prismaService: ReconciliationPrismaDouble = {
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
            fulfilledAt: state.staleClaimReleased ? null : state.refreshedFulfilledAt,
            gatewayData: state.gatewayDataOverride,
            purchaseType: state.purchaseType,
            planSnapshot: state.planSnapshotOverride,
          });
        }
        return createTransaction({
          id: 'tx-1',
          status: state.initialTransactionStatus,
          subscriptionId: state.refreshedSubscriptionId,
          fulfilledAt: state.refreshedFulfilledAt,
          gatewayData: state.gatewayDataOverride,
          purchaseType: state.purchaseType,
          planSnapshot: state.planSnapshotOverride,
        });
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
          return { count: state.refreshedFulfilledAt === null || state.staleClaimReleased ? 1 : 0 };
        }
        if (args.data['fulfilledAt'] === null) state.staleClaimReleased = true;
        return { count: 1 };
      },
      update: async (args: TransactionUpdateArgs) => {
        state.transactionUpdateCalls.push(args);
        state.updatedStatus = args.data.status;
        if (args.data['fulfilledAt'] === null) state.staleClaimReleased = true;
        state.callOrder.push('update');
        return createTransaction({
          id: args.where.id,
          status: args.data.status,
          subscriptionId: state.refreshedSubscriptionId,
        });
      },
    },
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
    prismaService as unknown as PrismaService,
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
    readonly status: SubscriptionStatus;
    readonly expiresAt: Date | null;
  } | null;
  /** Completed payments on the same subscription besides the refunded one. */
  readonly otherCompletedPaymentsOnSubscription?: number;
  readonly purchaseType?: PurchaseType;
  readonly planSnapshotOverride?: Record<string, unknown>;
}) {
  const now = new Date('2026-04-19T12:00:00.000Z');
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
    staleClaimReleased: false,
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
    purchaseType: input.purchaseType ?? PurchaseType.NEW,
    planSnapshotOverride: input.planSnapshotOverride ?? {},
    subscriptionRow:
      input.subscriptionRow === undefined
        ? {
            id: 'subscription-1',
            remnawaveId: 'rw-1',
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date('2026-05-19T12:00:00.000Z'),
          }
        : input.subscriptionRow,
    otherCompletedPaymentsOnSubscription: input.otherCompletedPaymentsOnSubscription ?? 0,
    subscriptionUpdateCalls: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    syncJobCreateCalls: [] as Array<Record<string, unknown>>,
  };
}

function createTransaction(input: {
  readonly id: string;
  readonly status: TransactionStatus;
  readonly subscriptionId: string | null;
  readonly fulfilledAt?: Date | null;
  readonly gatewayData?: Record<string, unknown> | null;
  readonly purchaseType?: PurchaseType;
  readonly planSnapshot?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: input.subscriptionId,
    fulfilledAt: input.fulfilledAt ?? null,
    status: input.status,
    isTest: false,
    purchaseType: input.purchaseType ?? PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    currency: Currency.USD,
    amount: new Prisma.Decimal('8.00'),
    paymentAsset: null,
    planSnapshot: input.planSnapshot ?? { id: 'plan-1', selectedDurationDays: 30, pricing: { discountSource: 'PURCHASE', discountPercent: 20 } },
    gatewayId: null,
    gatewayData: input.gatewayData ?? null,
    deviceTypes: [],
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}

function constructorSnapshotMarker(): Record<string, unknown> {
  return {
    snapshotSource: 'TARIFF_CONSTRUCTOR_CHECKOUT', snapshotVersion: 1,
    revisionId: 'revision-1', revision: 1,
    selections: [{ type: 'TRAFFIC', value: 10 }, { type: 'DEVICES', value: 1 }],
    lines: [{ kind: 'BASE', module: null, value: null, steps: null, perStepAmount: null, amount: '8' }, { kind: 'MODULE', module: 'TRAFFIC', value: 10, steps: 0, perStepAmount: '0', amount: '0' }, { kind: 'MODULE', module: 'DEVICES', value: 1, steps: 0, perStepAmount: '0', amount: '0' }],
    amount: '8', currency: 'USD',
    basePlan: { id: 'plan-1', name: 'Custom', description: '', tag: null, type: 'BOTH', icon: null, trafficLimitStrategy: 'NO_RESET', internalSquads: ['squad-1'], externalSquad: null },
    trafficLimit: 10, deviceLimit: 1, durationDays: 30, channel: 'WEB', gatewayType: 'YOOKASSA', purchaseType: 'ADDITIONAL',
  };
}
