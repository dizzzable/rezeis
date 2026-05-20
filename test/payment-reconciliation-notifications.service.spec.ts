import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType, SyncJobStatus, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { PaymentOpsAlertService } from '../src/modules/payments/services/payment-ops-alert.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { PaymentWebhookInboxService } from '../src/modules/payments/services/payment-webhook-inbox.service';
import { UserNotificationEventsService } from '../src/modules/user-activity/services/user-notification-events.service';

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
  paymentId: string;
  eventStatus: string;
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
  amount: { toString: () => string };
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
  user: {
    findUnique: () => Promise<{ readonly id: string; readonly purchaseDiscount: number } | null>;
    update: (args: { readonly data: { readonly purchaseDiscount: number } }) => Promise<{ readonly id: string }>;
  };
  profileSyncJob: {
    update: (args: { readonly where: { readonly id: string }; readonly data: { readonly status: SyncJobStatus; readonly lastError: string; readonly nextRetryAt: null; readonly processedAt: Date } }) => Promise<{ readonly id: string }>;
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
type WritePaymentNotificationArg = { id: string };
type ReconciliationNotificationsDouble = {
  writePaymentCompleted: (transaction: WritePaymentNotificationArg) => Promise<void>;
  writePaymentFailed: (transaction: WritePaymentNotificationArg) => Promise<void>;
};

describe('PaymentReconciliationService notification emission', () => {
  it('writes a completed notification after applying the subscription mutation for successful reconciliations', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.notificationCalls, [['completed', 'tx-1']]);
    assert.deepStrictEqual(state.mutationCalls, ['tx-1']);
    assert.deepStrictEqual(state.callOrder, ['update', 'mutation', 'enqueue:sync-1', 'referral-qualification', 'profile-sync-batch', 'notify-completed']);
    assert.deepStrictEqual(state.referralQualificationCalls, [{ referredUserId: 'user-1', purchaseChannel: 'WEB', transactionId: 'tx-1' }]);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('consumes purchase discount after completed payment side effects', async () => {
    const state = createState({ eventStatus: 'succeeded', initialTransactionStatus: TransactionStatus.PENDING, refreshedSubscriptionId: null, purchaseDiscount: 35 });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.equal(state.userUpdateCalls[0]?.data.purchaseDiscount, 15);
    assert.deepStrictEqual(state.callOrder, ['update', 'mutation', 'enqueue:sync-1', 'consume-purchase-discount', 'referral-qualification', 'profile-sync-batch', 'notify-completed']);
  });

  it('does not emit a completed notification if the completion mutation throws', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
      mutationShouldThrow: true,
    });
    const service = createService(state);

    await assert.rejects(() => service.reconcileWebhookEvent('event-1'), /forced mutation failure/);

    assert.deepStrictEqual(state.notificationCalls, []);
    assert.deepStrictEqual(state.callOrder, ['update', 'mutation']);
    assert.deepStrictEqual(state.markProcessedCalls, []);
    assert.deepStrictEqual(state.markFailedCalls.length, 1);
  });

  it('still applies the completion mutation when refreshed transaction already has a subscription id', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: 'subscription-existing',
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.mutationCalls, ['tx-1']);
    assert.deepStrictEqual(state.notificationCalls, [['completed', 'tx-1']]);
    assert.deepStrictEqual(state.callOrder, ['update', 'mutation', 'enqueue:sync-1', 'referral-qualification', 'profile-sync-batch', 'notify-completed']);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('writes a failed notification for canceled payment outcomes', async () => {
    const state = createState({
      eventStatus: 'failed',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: 'subscription-1',
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.notificationCalls, [['failed', 'tx-1']]);
    assert.deepStrictEqual(state.mutationCalls, []);
    assert.deepStrictEqual(state.callOrder, ['update', 'notify-failed']);
    assert.deepStrictEqual(state.markProcessedCalls, ['event-1']);
  });

  it('does not emit duplicate notifications for already terminal transactions', async () => {
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.COMPLETED,
      refreshedSubscriptionId: 'subscription-1',
    });
    const service = createService(state);

    await service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(state.notificationCalls, []);
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
    assert.deepStrictEqual(state.markFailedCalls[0], ['event-1', 'PAYMENT_PROVIDER_ERROR']);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /provider\.example/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /provider-secret-fragment/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /0194f4b6-7cc7-7ecb-9f62-123456789abc/);
    assert.doesNotMatch(JSON.stringify(state.markFailedCalls), /provider-raw-id/);
  });

  it('marks profile sync jobs failed when queue enqueue fails after completion mutation', async () => {
    const rawQueueFailure = 'redis://admin:secret-password@queue.internal/0 payload subscription_id=sub_secret token=provider-token';
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
      enqueueError: new Error(rawQueueFailure),
    });
    const service = createService(state);

    await assert.rejects(() => service.reconcileWebhookEvent('event-1'), /redis:\/\//);

    assert.deepStrictEqual(state.callOrder, ['update', 'mutation', 'enqueue:sync-1', 'mark-profile-sync-enqueue-failed']);
    assert.equal(state.profileSyncJobUpdateCalls.length, 1);
    assert.equal(state.profileSyncJobUpdateCalls[0]?.where.id, 'sync-1');
    assert.equal(state.profileSyncJobUpdateCalls[0]?.data.status, SyncJobStatus.FAILED);
    assert.equal(state.profileSyncJobUpdateCalls[0]?.data.lastError, 'PROFILE_SYNC_ENQUEUE_FAILED');
    assert.equal(state.profileSyncJobUpdateCalls[0]?.data.nextRetryAt, null);
    assert.equal(state.profileSyncJobUpdateCalls[0]?.data.processedAt instanceof Date, true);
    assert.equal(state.markFailedCalls.length, 1);
    assert.deepStrictEqual(state.markFailedCalls[0], ['event-1', 'PAYMENT_PROVIDER_ERROR']);
    assert.deepStrictEqual(state.markProcessedCalls, []);
    assert.deepStrictEqual(state.notificationCalls, []);
    const serializedUpdates = JSON.stringify(state.profileSyncJobUpdateCalls);
    assert.doesNotMatch(serializedUpdates, /secret-password/);
    assert.doesNotMatch(serializedUpdates, /redis:\/\//);
    assert.doesNotMatch(serializedUpdates, /sub_secret/);
    assert.doesNotMatch(serializedUpdates, /provider-token/);
  });

  it('preserves original enqueue failure when profile sync failure marker update fails', async () => {
    const originalError = new Error('redis://admin:secret-password@queue.internal/0 payload subscription_id=sub_secret');
    const state = createState({
      eventStatus: 'succeeded',
      initialTransactionStatus: TransactionStatus.PENDING,
      refreshedSubscriptionId: null,
      enqueueError: originalError,
      profileSyncJobUpdateError: new Error('profile sync marker failed'),
    });
    const service = createService(state);

    await assert.rejects(
      () => service.reconcileWebhookEvent('event-1'),
      (error: unknown) => error === originalError,
    );

    assert.equal(state.profileSyncJobUpdateCalls.length, 1);
    assert.deepStrictEqual(state.callOrder, ['update', 'mutation', 'enqueue:sync-1', 'mark-profile-sync-enqueue-failed']);
    assert.equal(state.markFailedCalls.length, 1);
    assert.deepStrictEqual(state.markFailedCalls[0], ['event-1', 'PAYMENT_PROVIDER_ERROR']);
    assert.deepStrictEqual(state.markProcessedCalls, []);
    assert.deepStrictEqual(state.notificationCalls, []);
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
    user: {
      findUnique: async () => ({ id: 'user-1', purchaseDiscount: state.purchaseDiscount }),
      update: async (args: { readonly data: { readonly purchaseDiscount: number } }) => {
        state.userUpdateCalls.push(args);
        state.callOrder.push('consume-purchase-discount');
        return { id: 'user-1' };
      },
    },
    profileSyncJob: {
      update: async (args) => {
        state.profileSyncJobUpdateCalls.push(args);
        state.callOrder.push('mark-profile-sync-enqueue-failed');
        if (state.profileSyncJobUpdateError) {
          throw state.profileSyncJobUpdateError;
        }
        return { id: args.where.id };
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
      return { subscription: { id: 'subscription-1' }, syncJob: { id: 'sync-1' } };
    },
  };
  const paymentOpsAlertService: ReconciliationAlertDouble = {
    notifyWebhookFailed: async (input: NotifyWebhookFailedArgs) => {
      state.alertCalls.push(input);
    },
  };
  const userNotificationEventsService: ReconciliationNotificationsDouble = {
    writePaymentCompleted: async (transaction: WritePaymentNotificationArg) => {
      state.notificationCalls.push(['completed', transaction.id]);
      state.callOrder.push('notify-completed');
    },
    writePaymentFailed: async (transaction: WritePaymentNotificationArg) => {
      state.notificationCalls.push(['failed', transaction.id]);
      state.callOrder.push('notify-failed');
    },
  };
  return new PaymentReconciliationService(
    prismaService as unknown as PrismaService,
    paymentWebhookInboxService as unknown as PaymentWebhookInboxService,
    paymentSubscriptionMutationService as unknown as PaymentSubscriptionMutationService,
    paymentOpsAlertService as unknown as PaymentOpsAlertService,
    userNotificationEventsService as unknown as UserNotificationEventsService,
    { processPendingBatch: async () => { state.callOrder.push('profile-sync-batch'); } } as never,
    { enqueueJob: async (jobId: string) => { state.callOrder.push(`enqueue:${jobId}`); if (state.enqueueError) { throw state.enqueueError; } return { jobId, queueJobId: `profile-sync:${jobId}`, enqueued: true, alreadyQueued: false }; } } as never,
    { qualifyFromCompletedPurchase: async (input: { readonly referredUserId: string; readonly purchaseChannel: string; readonly transactionId?: string }) => { state.referralQualificationCalls.push(input); state.callOrder.push('referral-qualification'); return { referredUserId: 'user-1', qualifiedReferralIds: [], rewardsIssuedCount: 0, totalRewardAmount: 0 }; } } as never,
  );
}

function createState(input: {
  readonly eventStatus: string;
  readonly initialTransactionStatus: TransactionStatus;
  readonly refreshedSubscriptionId: string | null;
  readonly mutationShouldThrow?: boolean;
  readonly mutationError?: Error;
  readonly enqueueError?: Error;
  readonly profileSyncJobUpdateError?: Error;
  readonly purchaseDiscount?: number;
}) {
  return {
    event: {
      id: 'event-1',
      paymentId: 'payment-1',
      eventStatus: input.eventStatus,
    },
    initialTransactionStatus: input.initialTransactionStatus,
    refreshedSubscriptionId: input.refreshedSubscriptionId,
    updatedStatus: undefined as TransactionStatus | undefined,
    incrementCalls: [] as string[],
    markProcessingCalls: [] as string[],
    markProcessedCalls: [] as string[],
    markFailedCalls: [] as [string, string][],
    transactionUpdateCalls: [] as TransactionUpdateArgs[],
    notificationCalls: [] as Array<['completed' | 'failed', string]>,
    mutationCalls: [] as string[],
    mutationShouldThrow: input.mutationShouldThrow ?? input.mutationError !== undefined,
    mutationError: input.mutationError ?? null,
    enqueueError: input.enqueueError ?? null,
    profileSyncJobUpdateError: input.profileSyncJobUpdateError ?? null,
    callOrder: [] as string[],
    alertCalls: [] as NotifyWebhookFailedArgs[],
    referralQualificationCalls: [] as Array<{ readonly referredUserId: string; readonly purchaseChannel: string; readonly transactionId?: string }>,
    purchaseDiscount: input.purchaseDiscount ?? 0,
    userUpdateCalls: [] as Array<{ readonly data: { readonly purchaseDiscount: number } }>,
    profileSyncJobUpdateCalls: [] as Array<{ readonly where: { readonly id: string }; readonly data: { readonly status: SyncJobStatus; readonly lastError: string; readonly nextRetryAt: null; readonly processedAt: Date } }>,
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
    amount: { toString: (): string => '8.00' },
    paymentAsset: null,
    planSnapshot: { id: 'plan-1', selectedDurationDays: 30, pricing: { discountSource: 'PURCHASE', discountPercent: 20 } },
    gatewayId: null,
    gatewayData: null,
    deviceTypes: [],
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}
