import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { YookassaPaymentVerificationService } from '../src/modules/payments/services/yookassa-payment-verification.service';

/**
 * YooKassa completions are confirmed with YooKassa
 * ───────────────────────────────────────────────
 * YooKassa signs nothing. Its published source-IP list was the entire
 * authentication of "this payment succeeded", and that check rests on Express's
 * `trust proxy` boundary — `uniquelocal`, i.e. all of RFC1918. The API container
 * is exposed on a shared external Docker bridge alongside reiwa and Remnawave,
 * so anything on that bridge reaches the webhook route directly: its socket
 * address is private, `X-Forwarded-For` is therefore honoured, and it can name a
 * YooKassa source IP. A forged `payment.succeeded` was then accepted with no
 * signature anywhere in the path.
 *
 * The fix is the second verification step YooKassa documents and we never did:
 * re-fetch the payment and let the provider itself say. These specs pin what
 * that must mean — including the half that is easy to leave out, which is that
 * the fetched payment has to be bound back to THIS transaction. Confirming on
 * the returned status alone is theatre: an attacker who has ever paid this shop
 * one rouble owns a genuinely `succeeded` payment to point us at.
 *
 * The whole path is exercised for real — the actual verification service, over
 * a fake transport — because the value here is in the HTTP-shaped details
 * (which id is fetched, which body is trusted), and a stubbed verdict would pin
 * none of them.
 */

interface EmittedEvent {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

/** What the fake YooKassa API does when asked for a payment. */
type ProviderBehaviour =
  | { readonly kind: 'respond'; readonly status: number; readonly data: unknown }
  | { readonly kind: 'network-error'; readonly message: string };

const CONFIRMED_PAYMENT = {
  kind: 'respond' as const,
  status: 200,
  data: {
    id: 'yoo-payment-1',
    status: 'succeeded',
    paid: true,
    amount: { value: '1000.00', currency: 'RUB' },
    metadata: { paymentId: 'payment-1', transactionId: 'tx-1' },
  },
};

describe('a YooKassa completion is applied only when YooKassa confirms it', () => {
  it('applies the completion the provider confirms', async () => {
    const h = createHarness({ provider: CONFIRMED_PAYMENT });

    await h.service.reconcileWebhookEvent('event-1');

    // Asked the provider, once, for the payment behind this transaction — with
    // the shop credentials, exactly as every other YooKassa call here is made.
    assert.equal(h.providerCalls.length, 1);
    assert.equal(
      h.providerCalls[0].url,
      'https://api.yookassa.ru/v3/payments/yoo-payment-1',
    );
    assert.deepStrictEqual(h.providerCalls[0].auth, {
      username: 'shop-1',
      password: 'secret-1',
    });

    // And only then applied it.
    assert.equal(h.statusWrites[h.statusWrites.length - 1], TransactionStatus.COMPLETED);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
    assert.deepStrictEqual(h.processed, ['event-1']);
    assert.deepStrictEqual(h.failed, []);
    assert.deepStrictEqual(h.opsAlerts, []);
    assert.equal(h.reviewFlag(), undefined);
  });

  it('refuses a forged completion the provider says was canceled', async () => {
    // The provider answers, and answers no. Nothing about the money is in
    // doubt — there is none — so this must never fulfil.
    const h = createHarness({
      provider: {
        kind: 'respond',
        status: 200,
        data: {
          id: 'yoo-payment-1',
          status: 'canceled',
          metadata: { paymentId: 'payment-1' },
        },
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.fulfillments, []);
    // Not merely "not fulfilled": COMPLETED was never written at all, so the
    // row cannot be picked up as paid by anything downstream either.
    assert.deepStrictEqual(h.statusWrites, []);

    // Held for a human on the established mechanism, not a parallel one.
    assert.equal(h.reviewFlag(), true);
    assert.equal(h.gatewayData().providerVerifiedStatus, 'canceled');
    assert.equal(
      h.gatewayData().providerVerificationReason,
      'PAYMENT_VERIFICATION_PROVIDER_CANCELED',
    );
    // The notification's own claim is preserved beside the provider's answer —
    // the disagreement is the evidence.
    assert.equal(h.gatewayData().notificationClaimedStatus, 'succeeded');

    const warnings = h.events.filter((e) => e.type === EVENT_TYPES.PAYMENT_AMOUNT_MISMATCH);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'WARNING');
    assert.equal(warnings[0].metadata.needsManualReview, true);
    assert.equal(
      warnings[0].metadata.verificationReason,
      'PAYMENT_VERIFICATION_PROVIDER_CANCELED',
    );

    // Acked rather than failed: re-asking returns the same answer, so retrying
    // would buy three more identical alerts and bury the one that matters.
    assert.deepStrictEqual(h.processed, ['event-1']);
    assert.deepStrictEqual(h.failed, []);
  });

  it("refuses a forged completion that names somebody else's succeeded payment", async () => {
    // The attack the status check alone does not stop: the forged notification
    // points at a real, genuinely succeeded payment in this shop that the
    // attacker made themselves. Only the binding back to our own transaction
    // catches it.
    const h = createHarness({
      rawPayload: {
        event: 'payment.succeeded',
        object: {
          id: 'yoo-attacker-payment',
          status: 'succeeded',
          metadata: { paymentId: 'payment-1' },
        },
      },
      provider: {
        kind: 'respond',
        status: 200,
        data: {
          id: 'yoo-attacker-payment',
          status: 'succeeded',
          paid: true,
          // The provider's own copy names the attacker's checkout, not ours.
          // Only our create call can write this key, so it cannot be forged.
          metadata: { paymentId: 'payment-attacker' },
        },
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.fulfillments, []);
    assert.deepStrictEqual(h.statusWrites, []);
    assert.equal(h.reviewFlag(), true);
    assert.equal(
      h.gatewayData().providerVerificationReason,
      'PAYMENT_VERIFICATION_PAYMENT_NOT_OURS',
    );
  });

  it('refuses a completion for a payment the shop does not have', async () => {
    // A payment we created cannot vanish from our own shop, so a 404 is proof
    // the notification was invented rather than a reason to retry.
    const h = createHarness({
      provider: { kind: 'respond', status: 404, data: { type: 'error', code: 'not_found' } },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.fulfillments, []);
    assert.deepStrictEqual(h.statusWrites, []);
    assert.equal(h.reviewFlag(), true);
    assert.equal(
      h.gatewayData().providerVerificationReason,
      'PAYMENT_VERIFICATION_PAYMENT_NOT_FOUND',
    );
    assert.deepStrictEqual(h.processed, ['event-1']);
  });

  it('still verifies when checkout never persisted the provider payment id', async () => {
    // The genuine backfill case: the process died between YooKassa's 200 and
    // our follow-up update, so `gatewayId` still holds a provider-create
    // placeholder. The payment is real and must still be fulfilled — the id is
    // taken from the notification and bound by the provider's own metadata.
    const h = createHarness({
      gatewayId: '__CHECKOUT_PROVIDER_CREATE__:abc',
      provider: CONFIRMED_PAYMENT,
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.equal(h.providerCalls[0].url, 'https://api.yookassa.ru/v3/payments/yoo-payment-1');
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
    assert.equal(h.reviewFlag(), undefined);
  });
});

describe('a provider that cannot answer is retried, not resolved', () => {
  it('does not fulfil on an outage and routes the event to the operator alert', async () => {
    const h = createHarness({
      provider: { kind: 'network-error', message: 'connect ETIMEDOUT 185.71.76.1:443' },
    });

    await assert.rejects(() => h.service.reconcileWebhookEvent('event-1'));

    // Neither fulfilled nor silently dropped.
    assert.deepStrictEqual(h.fulfillments, []);
    assert.deepStrictEqual(h.statusWrites, []);
    assert.deepStrictEqual(h.processed, []);

    // Marked FAILED with the reason and escalated — which is also what makes
    // `PaymentAutoRetryService` re-enqueue it (immediately, +5 min, +15 min),
    // so a blip resolves itself without anyone touching it.
    assert.equal(h.failed.length, 1);
    assert.equal(h.failed[0].eventId, 'event-1');
    assert.equal(h.failed[0].reason, 'PAYMENT_VERIFICATION_PROVIDER_UNREACHABLE');
    assert.deepStrictEqual(h.opsAlerts, ['event-1']);

    // Explicitly NOT held for manual review: an outage is not evidence about
    // the payment, and flagging the row would exempt it from the pending-expiry
    // sweep — the very path that would otherwise fulfil it later by polling.
    assert.equal(h.reviewFlag(), undefined);
  });

  it('treats a not-yet-final provider status as retryable rather than forged', async () => {
    // `waiting_for_capture` may still become `succeeded`. Holding it for a
    // human would strand a live checkout on a state the provider is still
    // moving through.
    const h = createHarness({
      provider: {
        kind: 'respond',
        status: 200,
        data: {
          id: 'yoo-payment-1',
          status: 'waiting_for_capture',
          metadata: { paymentId: 'payment-1' },
        },
      },
    });

    await assert.rejects(() => h.service.reconcileWebhookEvent('event-1'));

    assert.deepStrictEqual(h.fulfillments, []);
    assert.equal(h.failed[0].reason, 'PAYMENT_VERIFICATION_PROVIDER_STATUS_NOT_FINAL');
    assert.equal(h.reviewFlag(), undefined);
  });

  it('treats a provider 5xx as retryable, not as a refusal', async () => {
    const h = createHarness({
      provider: { kind: 'respond', status: 502, data: 'bad gateway' },
    });

    await assert.rejects(() => h.service.reconcileWebhookEvent('event-1'));

    assert.deepStrictEqual(h.fulfillments, []);
    assert.equal(h.failed[0].reason, 'PAYMENT_VERIFICATION_PROVIDER_HTTP_ERROR');
    assert.equal(h.reviewFlag(), undefined);
  });
});

describe('the round-trip is charged to YooKassa alone', () => {
  it('makes no provider call for another gateway', async () => {
    // Sixteen other gateways authenticate their callbacks with a signature or a
    // shared secret. None of them may pay for YooKassa's lack of one.
    const h = createHarness({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      eventStatus: 'paid',
      rawPayload: { uuid: 'invoice-1', status: 'paid' },
      provider: {
        kind: 'network-error',
        message: 'the provider must not be called for a non-YooKassa gateway',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.providerCalls, []);
    // And the ordinary completion still goes through untouched.
    assert.equal(h.statusWrites[h.statusWrites.length - 1], TransactionStatus.COMPLETED);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
    assert.deepStrictEqual(h.processed, ['event-1']);
  });

  it('makes no provider call for a YooKassa refund reversal', async () => {
    // Refund reversal is handled ahead of the completion branch and returns
    // before it. A round-trip here would be both pointless and a new way for
    // the reversal to fail.
    const h = createHarness({
      eventStatus: 'REFUNDED',
      transactionStatus: TransactionStatus.COMPLETED,
      fulfilledAt: new Date('2026-04-19T11:00:00.000Z'),
      rawPayload: {
        event: 'refund.succeeded',
        object: { id: 'yoo-refund-1', payment_id: 'yoo-payment-1' },
      },
      provider: {
        kind: 'network-error',
        message: 'the provider must not be called on the refund path',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.providerCalls, []);
    assert.deepStrictEqual(h.reversals, ['tx-1']);
    assert.deepStrictEqual(h.processed, ['event-1']);
  });
});

interface Harness {
  readonly service: PaymentReconciliationService;
  readonly providerCalls: Array<{ url: string; auth: unknown }>;
  readonly statusWrites: TransactionStatus[];
  readonly events: EmittedEvent[];
  readonly processed: string[];
  readonly failed: Array<{ eventId: string; reason: string }>;
  readonly opsAlerts: string[];
  readonly fulfillments: string[];
  readonly reversals: string[];
  readonly gatewayData: () => Record<string, unknown>;
  readonly reviewFlag: () => unknown;
}

function createHarness(input: {
  readonly gatewayType?: PaymentGatewayType;
  readonly eventStatus?: string;
  readonly rawPayload?: Record<string, unknown>;
  readonly gatewayId?: string | null;
  readonly transactionStatus?: TransactionStatus;
  readonly fulfilledAt?: Date | null;
  readonly provider: ProviderBehaviour;
}): Harness {
  const gatewayType = input.gatewayType ?? PaymentGatewayType.YOOKASSA;
  const providerCalls: Array<{ url: string; auth: unknown }> = [];
  const statusWrites: TransactionStatus[] = [];
  const events: EmittedEvent[] = [];
  const processed: string[] = [];
  const failed: Array<{ eventId: string; reason: string }> = [];
  const opsAlerts: string[] = [];
  const fulfillments: string[] = [];
  const reversals: string[] = [];

  const transaction = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: null as string | null,
    fulfilledAt: input.fulfilledAt ?? null,
    status: input.transactionStatus ?? TransactionStatus.PENDING,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    gatewayType,
    currency: Currency.RUB,
    amount: new Prisma.Decimal('1000.00'),
    gatewayId: input.gatewayId === undefined ? 'yoo-payment-1' : input.gatewayId,
    gatewayData: null as Record<string, unknown> | null,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  };

  const client = {
    paymentWebhookEvent: {
      findUnique: async () => ({
        id: 'event-1',
        gatewayType,
        paymentId: 'payment-1',
        eventStatus: input.eventStatus ?? 'succeeded',
        rawPayload:
          input.rawPayload ??
          ({
            event: 'payment.succeeded',
            object: {
              id: 'yoo-payment-1',
              status: 'succeeded',
              metadata: { paymentId: 'payment-1' },
            },
          } as Record<string, unknown>),
      }),
    },
    paymentGateway: {
      findUnique: async () => ({
        type: PaymentGatewayType.YOOKASSA,
        isActive: true,
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
    },
    transaction: {
      findUnique: async () => ({ ...transaction }),
      findFirst: async () => ({ ...transaction }),
      count: async () => 0,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const status = args.data.status;
        if (typeof status === 'string') {
          statusWrites.push(status as TransactionStatus);
          transaction.status = status as TransactionStatus;
        }
        if (args.data.gatewayData !== undefined) {
          transaction.gatewayData = args.data.gatewayData as Record<string, unknown>;
        }
        return { ...transaction };
      },
      // Fulfilment claim — matches while the row is unfulfilled.
      updateMany: async () => ({ count: 1 }),
    },
    subscription: { findUnique: async () => null, update: async () => ({}) },
    profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
    trialClaim: { updateMany: async () => ({ count: 0 }) },
    $queryRaw: async () => [{ gatewayData: transaction.gatewayData }],
  };

  const httpService = {
    get: (url: string, config: { auth?: unknown }) => {
      providerCalls.push({ url, auth: config.auth });
      if (input.provider.kind === 'network-error') {
        throw new Error(input.provider.message);
      }
      return of({ status: input.provider.status, data: input.provider.data });
    },
  };

  const prismaService = {
    ...client,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  const service = new PaymentReconciliationService(
    prismaService as never,
    {
      incrementReconciliationAttempts: async () => undefined,
      markProcessing: async () => undefined,
      markProcessed: async (eventId: string) => {
        processed.push(eventId);
      },
      markFailed: async (eventId: string, reason: string) => {
        failed.push({ eventId, reason });
        return { id: eventId };
      },
    } as never,
    {
      applyCompletedTransaction: async (tx: { id: string }) => {
        fulfillments.push(tx.id);
        return { syncJobs: [] };
      },
    } as never,
    {
      notifyWebhookFailed: async (alert: { event: { id: string } }) => {
        opsAlerts.push(alert.event.id);
      },
    } as never,
    {
      processPartnerEarning: async () => undefined,
      reverseEarningsForTransaction: async (transactionId: string) => {
        reversals.push(transactionId);
      },
    } as never,
    {
      qualifyReferralAfterPurchase: async () => undefined,
      reverseQualificationForTransaction: async () => undefined,
    } as never,
    { enqueue: async () => undefined } as never,
    {
      info: (type: string, _c: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'INFO', type, message, metadata: metadata ?? {} });
      },
      warn: (type: string, _c: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'WARNING', type, message, metadata: metadata ?? {} });
      },
      error: (type: string, _c: string, message: string, metadata?: Record<string, unknown>) => {
        events.push({ severity: 'ERROR', type, message, metadata: metadata ?? {} });
      },
    } as never,
    {
      enqueueRegisterIncome: async () => undefined,
      enqueueCancelIncome: async () => undefined,
    } as never,
    { recordFirstPurchase: async () => undefined, revertConversion: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    // The real verifier over a fake transport — the point of these specs is the
    // HTTP-shaped detail, which a stubbed verdict would hide.
    new YookassaPaymentVerificationService(prismaService as never, httpService as never),
    { creditForTransactionBestEffort: async () => undefined, reverseForTransactionBestEffort: async () => undefined } as never,
  );

  return {
    service,
    providerCalls,
    statusWrites,
    events,
    processed,
    failed,
    opsAlerts,
    fulfillments,
    reversals,
    gatewayData: () => transaction.gatewayData ?? {},
    reviewFlag: () => (transaction.gatewayData ?? {})['paymentNeedsManualReview'],
  };
}
