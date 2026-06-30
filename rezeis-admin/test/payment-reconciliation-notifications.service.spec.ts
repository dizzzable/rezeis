import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  Prisma,
  PurchaseChannel,
  PurchaseType,
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
    update: (args: TransactionUpdateArgs) => Promise<ReconciliationTransactionRecord>;
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
};
type ReconciliationReferralQualificationDouble = {
  qualifyReferralAfterPurchase: (transactionId: string) => Promise<void>;
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

  it('does not re-run side effects for already terminal transactions', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
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
          });
        }
        return createTransaction({
          id: 'tx-1',
          status: state.initialTransactionStatus,
          subscriptionId: 'subscription-original',
        });
      },
      findFirst: async (_args: TransactionFindFirstArgs) => null,
      update: async (args: TransactionUpdateArgs) => {
        state.transactionUpdateCalls.push(args);
        state.updatedStatus = args.data.status;
        state.callOrder.push('update');
        return createTransaction({
          id: args.where.id,
          status: args.data.status,
          subscriptionId: state.refreshedSubscriptionId,
        });
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
  };
  const referralQualificationService: ReconciliationReferralQualificationDouble = {
    qualifyReferralAfterPurchase: async (transactionId: string) => {
      state.referralQualificationCalls.push(transactionId);
      state.callOrder.push('referral-qualification');
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
    { enqueueRegisterIncome: async () => {} } as unknown as MoyNalogQueueService,
  );
}

function createState(input: {
  readonly eventStatus: string;
  readonly initialTransactionStatus: TransactionStatus;
  readonly refreshedSubscriptionId: string | null;
  readonly mutationShouldThrow?: boolean;
  readonly mutationError?: Error;
  readonly enqueueError?: Error;
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
      rawPayload: { object: { id: 'payment-1', status: input.eventStatus } },
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
  };
}

function createTransaction(input: {
  readonly id: string;
  readonly status: TransactionStatus;
  readonly subscriptionId: string | null;
}) {
  return {
    id: input.id,
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: input.subscriptionId,
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
    gatewayData: null,
    deviceTypes: [],
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}
