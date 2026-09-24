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

import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * Crash recovery for a payment that creates its subscription.
 *
 * Fulfilment claims `fulfilledAt` before it writes the new subscription onto
 * the payment, in one transaction. A process that dies in between leaves the
 * claim and no subscription; the next notification for the payment, finding
 * the claim stale, releases it and fulfils. That covered NEW only. An
 * ADDITIONAL — a second subscription, or an add-on — was acknowledged as done
 * and never delivered, because its draft used to record the buyer's latest
 * subscription and a claim could not be told from a finished one. Its draft
 * records none now, so it is recovered the same way.
 */

const MINUTE = 60 * 1000;

function reconciliation(options: {
  readonly purchaseType: PurchaseType;
  readonly subscriptionId: string | null;
  readonly claimedMsAgo: number;
}) {
  const claimedAt = new Date(Date.now() - options.claimedMsAgo);
  const payment: Record<string, unknown> = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: options.subscriptionId,
    fulfilledAt: claimedAt,
    status: TransactionStatus.COMPLETED,
    isTest: false,
    purchaseType: options.purchaseType,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.PLATEGA,
    currency: Currency.RUB,
    amount: new Prisma.Decimal('299'),
    paymentAsset: null,
    planSnapshot: { id: 'plan-a', selectedDurationDays: 30 },
    gatewayId: 'platega-1',
    gatewayData: null,
    deviceTypes: [],
    createdAt: new Date(Date.now() - 10 * MINUTE),
    updatedAt: new Date(Date.now() - 10 * MINUTE),
  };
  const fulfilments: string[] = [];
  const processed: string[] = [];
  const failed: string[] = [];
  const prisma: Record<string, unknown> = {
    paymentWebhookEvent: {
      findUnique: async () => ({
        id: 'event-1',
        gatewayType: PaymentGatewayType.PLATEGA,
        paymentId: 'payment-1',
        providerEventId: 'platega-event-1',
        eventStatus: 'CONFIRMED',
        status: PaymentWebhookLifecycleStatus.ENQUEUED,
        rawPayload: { status: 'CONFIRMED' },
      }),
    },
    transaction: {
      findUnique: async () => ({ ...payment }),
      findFirst: async () => null,
      // The recovery's release is fenced on the stamp it saw; the claim takes
      // only an empty one.
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const stamp = payment.fulfilledAt as Date | null;
        const fence = where.fulfilledAt as Date | null | undefined;
        const holds = fence === null ? stamp === null : fence instanceof Date ? stamp?.getTime() === fence.getTime() : true;
        if (!holds) return { count: 0 };
        Object.assign(payment, data);
        return { count: 1 };
      },
    },
    trialClaim: { updateMany: async () => ({ count: 0 }) },
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: () => payment.gatewayData,
      update: async ({ data }) => Object.assign(payment, data),
    }),
  };
  prisma.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma);
  const service = new PaymentReconciliationService(
    prisma as never,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async (id: string) => {
        processed.push(id);
      },
      markFailed: async (id: string) => {
        failed.push(id);
        return { id };
      },
    } as never,
    {
      applyCompletedTransaction: async (transaction: { id: string }) => {
        fulfilments.push(transaction.id);
        payment.subscriptionId = 'created-sub';
        return { syncJobs: [] };
      },
    } as never,
    { notifyWebhookFailed: async () => undefined } as never,
    { processPartnerEarning: async () => undefined } as never,
    { qualifyReferralAfterPurchase: async () => null } as never,
    { enqueue: async () => undefined } as never,
    { warn: () => undefined, info: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { enqueueRegisterIncome: async () => undefined } as never,
    { recordFirstPurchase: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    { verifyCompletion: async () => ({ outcome: 'CONFIRMED' }) } as never,
    { creditForTransactionBestEffort: async () => null } as never,
    { create: async () => 'notification-1' } as never,
  );
  return { service, payment, fulfilments, processed, failed };
}

describe('a notification for a payment whose fulfilment died after its claim', () => {
  for (const purchaseType of [PurchaseType.NEW, PurchaseType.ADDITIONAL]) {
    it(`releases a stale claim on a ${purchaseType} and fulfils it`, async () => {
      const r = reconciliation({ purchaseType, subscriptionId: null, claimedMsAgo: 5 * MINUTE });

      await r.service.reconcileWebhookEvent('event-1');

      assert.deepEqual(r.fulfilments, ['tx-1']);
      assert.equal(r.payment.subscriptionId, 'created-sub');
      assert.deepEqual(r.processed, ['event-1']);
    });
  }

  it('leaves a fresh claim on an ADDITIONAL to the fulfilment still running, and asks to be retried', async () => {
    const r = reconciliation({ purchaseType: PurchaseType.ADDITIONAL, subscriptionId: null, claimedMsAgo: 30 * 1000 });

    await assert.rejects(r.service.reconcileWebhookEvent('event-1'), /still in progress/);

    assert.deepEqual(r.fulfilments, []);
    assert.deepEqual(r.processed, []);
  });

  it('acknowledges an ADDITIONAL that names its subscription, as delivered', async () => {
    // Fulfilled — or an older draft that recorded the buyer's latest
    // subscription, which cannot be told from one and stays as it was.
    const r = reconciliation({ purchaseType: PurchaseType.ADDITIONAL, subscriptionId: 'sub-1', claimedMsAgo: 5 * MINUTE });

    await r.service.reconcileWebhookEvent('event-1');

    assert.deepEqual(r.fulfilments, []);
    assert.deepEqual(r.processed, ['event-1']);
  });

  it('leaves a renewal out of this recovery, as it was', async () => {
    const r = reconciliation({ purchaseType: PurchaseType.RENEW, subscriptionId: null, claimedMsAgo: 5 * MINUTE });

    await r.service.reconcileWebhookEvent('event-1');

    assert.deepEqual(r.fulfilments, []);
    assert.deepEqual(r.processed, ['event-1']);
  });
});
