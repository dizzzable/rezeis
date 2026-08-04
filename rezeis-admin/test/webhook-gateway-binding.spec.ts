import 'reflect-metadata';

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

/**
 * A webhook only ever speaks for the gateway that sent it.
 *
 * Platega, MulenPay, Lava and Telegram Stars authenticate their callbacks with
 * a static header that does not cover the request body, and the value repeats
 * on every delivery — so a single captured notification yields a credential
 * that stays valid indefinitely. Reconciliation used to resolve the
 * transaction by `paymentId` alone, which meant the holder of any one of those
 * secrets could post someone else's payment id to their own gateway's route
 * and have us fulfil a transaction belonging to a completely different
 * gateway. The blast radius of the weakest secret in the system was all of
 * them, YooKassa included.
 *
 * The positive case — a matching gateway reconciling normally — is covered in
 * depth by `payment-reconciliation-notifications.service.spec.ts`, whose event
 * and transaction doubles are both YOOKASSA. That suite is the guard against
 * over-tightening; this one is the guard against the hole.
 */

const NOW = new Date('2026-04-19T12:00:00.000Z');

function createHarness(input: {
  readonly eventGateway: PaymentGatewayType;
  readonly transactionGateway: PaymentGatewayType;
}) {
  const state = {
    markFailedCalls: [] as [string, string][],
    alertedEventIds: [] as string[],
    transactionUpdates: [] as unknown[],
  };

  const transactionRow = {
    id: 'transaction-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: 'subscription-1',
    fulfilledAt: null,
    status: TransactionStatus.PENDING,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: input.transactionGateway,
    currency: Currency.RUB,
    amount: new Prisma.Decimal('1000.00'),
    paymentAsset: null,
    planSnapshot: {},
    gatewayId: null,
    gatewayData: null,
    deviceTypes: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  const prismaService = {
    paymentWebhookEvent: {
      findUnique: async () => ({
        id: 'event-1',
        gatewayType: input.eventGateway,
        paymentId: 'payment-1',
        providerEventId: 'provider-event-1',
        eventStatus: 'succeeded',
        status: PaymentWebhookLifecycleStatus.PROCESSING,
        attempts: 1,
        reconciliationAttempts: 1,
        replayCount: 0,
        lastError: null,
        payloadHash: 'hash-1',
        rawPayload: { object: { id: 'payment-1', status: 'succeeded' } },
        normalizedPayload: null,
        receivedAt: NOW,
        processedAt: null,
        lastTransitionAt: NOW,
        lastReplayedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    },
    transaction: {
      findUnique: async () => transactionRow,
      findFirst: async () => transactionRow,
      update: async (args: unknown) => {
        state.transactionUpdates.push(args);
        return transactionRow;
      },
      updateMany: async (args: unknown) => {
        state.transactionUpdates.push(args);
        return { count: 1 };
      },
    },
  };

  const paymentWebhookInboxService = {
    incrementReconciliationAttempts: async () => {},
    markProcessing: async () => {},
    markProcessed: async () => ({}),
    markFailed: async (eventId: string, reason: string) => {
      state.markFailedCalls.push([eventId, reason]);
      return { id: eventId };
    },
  };

  const paymentOpsAlertService = {
    notifyWebhookFailed: async (arg: { event: { id: string } }) => {
      state.alertedEventIds.push(arg.event.id);
    },
  };

  const service = new PaymentReconciliationService(
    prismaService as never,
    paymentWebhookInboxService as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    paymentOpsAlertService as never,
    {} as never,
    {} as never,
    {} as never,
    { warn: () => {}, info: () => {}, error: () => {}, emit: () => {} } as never,
    {} as never,
    {} as never,
    {} as never,
    // The matching-gateway case reaches the YooKassa completion path, which
    // asks the provider before applying anything.
    {
      verifyCompletion: async () => ({ outcome: 'CONFIRMED', providerStatus: 'succeeded' }),
    } as never,
  );

  return { service, state };
}

describe('webhook is bound to its own gateway', () => {
  it('refuses a Platega-authenticated event carrying a YooKassa payment id', async () => {
    // The attack: a leaked Platega X-Secret is replayed against Platega's own
    // webhook route, but the body names a victim's YooKassa transaction.
    const { service, state } = createHarness({
      eventGateway: PaymentGatewayType.PLATEGA,
      transactionGateway: PaymentGatewayType.YOOKASSA,
    });

    await assert.rejects(
      () => service.reconcileWebhookEvent('event-1'),
      /PAYMENT_WEBHOOK_GATEWAY_MISMATCH/,
    );

    // Nothing may be written to the victim's transaction.
    assert.deepEqual(state.transactionUpdates, []);
  });

  it('routes the mismatch through the failed-webhook path so an operator is alerted', async () => {
    // Reconciliation runs in a queue worker — the provider was already
    // answered 200 at ingress — so throwing costs no provider retry storm and
    // buys the existing operator alert for free.
    const { service, state } = createHarness({
      eventGateway: PaymentGatewayType.MULENPAY,
      transactionGateway: PaymentGatewayType.YOOKASSA,
    });

    await assert.rejects(() => service.reconcileWebhookEvent('event-1'));

    assert.deepEqual(state.alertedEventIds, ['event-1']);
    assert.equal(state.markFailedCalls.length, 1);
    // Assert on the recorded reason, not merely that something failed —
    // otherwise this passes on any unrelated error and guards nothing.
    assert.match(state.markFailedCalls[0][1], /PAYMENT_WEBHOOK_GATEWAY_MISMATCH/);
  });

  it('still resolves a transaction whose gateway matches the event', async () => {
    // Guards the guard: the check must not reject the ordinary case. Reaching
    // any failure other than the mismatch means the lookup let it through.
    const { service } = createHarness({
      eventGateway: PaymentGatewayType.YOOKASSA,
      transactionGateway: PaymentGatewayType.YOOKASSA,
    });

    await assert.doesNotReject(async () => {
      try {
        await service.reconcileWebhookEvent('event-1');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, /PAYMENT_WEBHOOK_GATEWAY_MISMATCH/);
      }
    });
  });
});
