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

import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { YookassaPaymentVerificationService } from '../src/modules/payments/services/yookassa-payment-verification.service';

/**
 * A completion YooKassa could not confirm must survive the expiry sweep
 * ────────────────────────────────────────────────────────────────────
 * The verification gate refuses to apply a YooKassa completion the provider has
 * not confirmed, and on `UNAVAILABLE` it throws so the retry ladder can ask
 * again. The ladder is short — `reconciliationAttempts < 3` with the counter
 * incremented at the top of every run gives TWO auto-retries, at +5 min and
 * +15 min — and an outage can outlive it.
 *
 * What happens then is the whole point of this file. The design leans on a
 * second recovery path, `PaymentPendingExpiryService` polling YooKassa for stale
 * PENDING rows, and that path is unreachable for exactly the row it is most
 * needed for: it only polls a row that already carries a provider payment id,
 * and the row here is the one whose id was never persisted (checkout died
 * between YooKassa's 200 and our follow-up update). With `gatewayId` null the
 * sweep takes its local-TTL branch and CANCELS a transaction a real buyer paid
 * for.
 *
 * The obvious repair — backfill `gatewayId` from the notification before the
 * gate — is refused here on purpose, and the specs pin that too. That id comes
 * from a notification YooKassa never signed; the sweep polls whatever id it
 * finds and fulfils on a bare `succeeded` with nothing binding the answer back
 * to this transaction, so storing an attacker's id would hand back the
 * fulfilment the gate had just refused, one sweep tick later.
 */

/** What the fake YooKassa API does when asked for a payment. */
type ProviderBehaviour =
  | { readonly kind: 'respond'; readonly status: number; readonly data: unknown }
  | { readonly kind: 'network-error'; readonly message: string };

const OUTAGE: ProviderBehaviour = {
  kind: 'network-error',
  message: 'connect ETIMEDOUT 185.71.76.1:443',
};

const CONFIRMED: ProviderBehaviour = {
  kind: 'respond',
  status: 200,
  data: {
    id: 'yoo-payment-1',
    status: 'succeeded',
    paid: true,
    amount: { value: '1000.00', currency: 'RUB' },
    metadata: { paymentId: 'payment-1' },
  },
};

describe('a YooKassa completion the provider could not confirm', () => {
  it('leaves the row recoverable instead of letting the sweep cancel a paid payment', async () => {
    // The row checkout never finished writing: `gatewayId` is null, so the
    // sweep's YooKassa poll cannot run for it at all.
    const h = createReconciliation({ gatewayId: null, provider: OUTAGE });

    await assert.rejects(() => h.service.reconcileWebhookEvent('event-1'));

    // Unchanged from before: nothing fulfilled, no status written, the event
    // marked FAILED so the retry ladder picks it up.
    assert.deepStrictEqual(h.fulfillments, []);
    assert.deepStrictEqual(h.statusWrites, []);
    assert.deepStrictEqual(h.failed, ['PAYMENT_VERIFICATION_PROVIDER_UNREACHABLE']);

    // The row now carries the guard, and the reason it carries it.
    assert.equal(h.gatewayData().paymentNeedsManualReview, true);
    assert.equal(
      h.gatewayData().providerVerificationReason,
      'PAYMENT_VERIFICATION_PROVIDER_UNREACHABLE',
    );
    assert.equal(typeof h.gatewayData().providerVerificationUnavailableAt, 'string');

    // And now the part that matters: hand the row to the real sweep and it
    // declines to cancel it.
    const sweep = createExpiry([{ id: 'tx-1', gatewayId: null, gatewayData: h.gatewayData() }]);
    await sweep.service.expireStalePending();

    assert.deepStrictEqual(sweep.cancelled, []);
    // The trial reservation goes with it — released only alongside a cancel.
    assert.deepStrictEqual(sweep.releases, []);
  });

  it('is the guard doing that, not the shape of the row', async () => {
    // The control, and the pre-fix behaviour: the identical row without the
    // guard is cancelled by the same sweep on the same tick — a paid
    // transaction filed as an abandoned cart.
    const sweep = createExpiry([
      { id: 'tx-1', gatewayId: null, gatewayData: { providerStatus: 'succeeded' } },
    ]);

    await sweep.service.expireStalePending();

    assert.deepStrictEqual(sweep.cancelled, ['tx-1']);
    assert.deepStrictEqual(sweep.releases, ['tx-1']);
  });

  it('never writes the id the notification claimed into gatewayId', async () => {
    // The repair that must not be made. `gatewayId` is what
    // `PaymentPendingExpiryService` polls and fulfils on, with no equivalent of
    // `isOurPayment` binding the provider's answer back to this transaction —
    // so an id taken from an unsigned notification would be a forger's route to
    // the fulfilment the gate had just refused. It is kept as evidence under its
    // own key, where nothing polls it.
    const h = createReconciliation({ gatewayId: null, provider: OUTAGE });

    await assert.rejects(() => h.service.reconcileWebhookEvent('event-1'));

    assert.equal(h.transactionRow().gatewayId, null);
    for (const update of h.updates) {
      assert.equal(update.data.gatewayId, undefined);
    }
    assert.equal(h.gatewayData().unverifiedGatewayId, 'yoo-payment-1');
  });

  it('costs nothing at all for a row the sweep can already poll', async () => {
    // A row holding a real provider id has the second recovery path available
    // and needs no guard — flagging it would park a payment the sweep would
    // have resolved by itself. No write, no flag.
    const h = createReconciliation({ gatewayId: 'yoo-payment-1', provider: OUTAGE });

    await assert.rejects(() => h.service.reconcileWebhookEvent('event-1'));

    assert.deepStrictEqual(h.updates, []);
    assert.equal(h.gatewayData().paymentNeedsManualReview, undefined);
  });

  it('lifts the guard when a retry finally gets an answer', async () => {
    // The guard is provisional, so the completion that resolves it must also
    // clear it — otherwise a fulfilled payment sits in the operator's review
    // queue over a question that has been answered.
    const h = createReconciliation({ gatewayId: null, provider: OUTAGE });
    await assert.rejects(() => h.service.reconcileWebhookEvent('event-1'));
    assert.equal(h.gatewayData().paymentNeedsManualReview, true);

    h.setProvider(CONFIRMED);
    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.statusWrites, [TransactionStatus.COMPLETED]);
    assert.deepStrictEqual(h.fulfillments, ['tx-1']);
    assert.equal(h.gatewayData().paymentNeedsManualReview, false);
    assert.equal(typeof h.gatewayData().providerVerificationRecoveredAt, 'string');
    // And only NOW is the provider id written to the column the sweep and the
    // refund lookup trust — after the provider's own copy confirmed it is ours.
    assert.equal(h.transactionRow().gatewayId, 'yoo-payment-1');
  });

  it('does not lift a hold somebody has to make a decision about', async () => {
    // `paymentNeedsManualReview` is one key with several writers. A row held
    // because the buyer underpaid is an operator's call, and a later completion
    // must not empty that queue behind their back — which is the same harm the
    // sweep exemption exists to prevent.
    const h = createReconciliation({
      gatewayId: null,
      provider: CONFIRMED,
      gatewayData: {
        paymentNeedsManualReview: true,
        providerVerificationUnavailableAt: '2026-04-19T12:00:00.000Z',
        amountMismatchAt: '2026-04-19T12:01:00.000Z',
      },
    });

    await h.service.reconcileWebhookEvent('event-1');

    assert.deepStrictEqual(h.statusWrites, [TransactionStatus.COMPLETED]);
    assert.equal(h.gatewayData().paymentNeedsManualReview, true);
    assert.equal(h.gatewayData().providerVerificationRecoveredAt, undefined);
  });
});

interface ReconcileHarness {
  readonly service: PaymentReconciliationService;
  readonly updates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  readonly statusWrites: TransactionStatus[];
  readonly failed: string[];
  readonly fulfillments: string[];
  readonly setProvider: (behaviour: ProviderBehaviour) => void;
  readonly transactionRow: () => { gatewayId: string | null };
  readonly gatewayData: () => Record<string, unknown>;
}

function createReconciliation(input: {
  readonly gatewayId: string | null;
  readonly provider: ProviderBehaviour;
  readonly gatewayData?: Record<string, unknown> | null;
}): ReconcileHarness {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const statusWrites: TransactionStatus[] = [];
  const failed: string[] = [];
  const fulfillments: string[] = [];
  let provider = input.provider;

  const transaction = {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: null as string | null,
    fulfilledAt: null as Date | null,
    status: TransactionStatus.PENDING as TransactionStatus,
    isTest: false,
    purchaseType: PurchaseType.NEW,
    gatewayType: PaymentGatewayType.YOOKASSA,
    currency: Currency.RUB,
    amount: new Prisma.Decimal('1000.00'),
    gatewayId: input.gatewayId,
    gatewayData: (input.gatewayData ?? null) as Record<string, unknown> | null,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  };

  const client = {
    paymentWebhookEvent: {
      findUnique: async () => ({
        id: 'event-1',
        gatewayType: PaymentGatewayType.YOOKASSA,
        paymentId: 'payment-1',
        eventStatus: 'succeeded',
        rawPayload: {
          event: 'payment.succeeded',
          object: {
            id: 'yoo-payment-1',
            status: 'succeeded',
            metadata: { paymentId: 'payment-1' },
          },
        } as Record<string, unknown>,
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
        updates.push(args);
        if (typeof args.data.status === 'string') {
          statusWrites.push(args.data.status as TransactionStatus);
          transaction.status = args.data.status as TransactionStatus;
        }
        if (typeof args.data.gatewayId === 'string') {
          transaction.gatewayId = args.data.gatewayId;
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
    get: (_url: string, _config: unknown) => {
      if (provider.kind === 'network-error') {
        throw new Error(provider.message);
      }
      return of({ status: provider.status, data: provider.data });
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
      markProcessed: async () => undefined,
      markFailed: async (_eventId: string, reason: string) => {
        failed.push(reason);
        return { id: 'event-1' };
      },
    } as never,
    {
      applyCompletedTransaction: async (tx: { id: string }) => {
        fulfillments.push(tx.id);
        return { syncJobs: [] };
      },
    } as never,
    { notifyWebhookFailed: async () => undefined } as never,
    {
      processPartnerEarning: async () => undefined,
      reverseEarningsForTransaction: async () => undefined,
    } as never,
    {
      qualifyReferralAfterPurchase: async () => undefined,
      reverseQualificationForTransaction: async () => undefined,
    } as never,
    { enqueue: async () => undefined } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    {
      enqueueRegisterIncome: async () => undefined,
      enqueueCancelIncome: async () => undefined,
    } as never,
    { recordFirstPurchase: async () => undefined, revertConversion: async () => undefined } as never,
    { upsertFromYookassaPayment: async () => undefined } as never,
    // The real verifier over a fake transport: the verdicts these specs turn on
    // are HTTP-shaped, and a stubbed one would pin none of them.
    new YookassaPaymentVerificationService(prismaService as never, httpService as never),
  );

  return {
    service,
    updates,
    statusWrites,
    failed,
    fulfillments,
    setProvider: (behaviour: ProviderBehaviour) => {
      provider = behaviour;
    },
    transactionRow: () => transaction,
    gatewayData: () => transaction.gatewayData ?? {},
  };
}

interface ExpiryHarness {
  readonly service: PaymentPendingExpiryService;
  readonly cancelled: string[];
  readonly releases: string[];
}

function createExpiry(
  rows: ReadonlyArray<{
    readonly id: string;
    readonly gatewayId: string | null;
    readonly gatewayData: Record<string, unknown> | null;
  }>,
): ExpiryHarness {
  const cancelled: string[] = [];
  const releases: string[] = [];

  const stale = rows.map((row) => ({
    id: row.id,
    paymentId: `pay-${row.id}`,
    userId: 'user-1',
    purchaseType: PurchaseType.NEW,
    gatewayType: PaymentGatewayType.YOOKASSA,
    gatewayId: row.gatewayId,
    gatewayData: row.gatewayData,
    amount: new Prisma.Decimal('1000.00'),
    currency: Currency.RUB,
  }));

  const client = {
    transaction: {
      findMany: async () => stale,
      updateMany: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        assert.equal(args.data['status'], TransactionStatus.CANCELED);
        cancelled.push(args.where.id);
        return { count: 1 };
      },
    },
    trialClaim: {
      updateMany: async (args: { where: Record<string, unknown> }) => {
        releases.push(String(args.where['transactionId']));
        return { count: 1 };
      },
    },
  };

  const service = new PaymentPendingExpiryService(
    { ...client, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client) } as never,
    { info: () => undefined, warn: () => undefined } as never,
    {
      // `gatewayId` is null on every row here, so the sweep decides on its own
      // TTL without a provider round-trip. A call would mean it found an id to
      // poll, which is precisely what must not happen.
      get: () => {
        throw new Error('the sweep must not poll a row with no provider payment id');
      },
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { runPostFulfillmentHooks: async () => undefined } as never,
  );

  return { service, cancelled, releases };
}
