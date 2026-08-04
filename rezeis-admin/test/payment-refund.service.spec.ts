import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, TransactionStatus } from '@prisma/client';
import { of } from 'rxjs';

import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';

/**
 * Operator-issued refunds — the one surface in the panel that moves real money
 * out. Every guard here exists because getting it wrong either refunds twice or
 * refuses a legitimate refund, so each branch is pinned.
 */

const ADMIN = { id: 'admin-1' } as never;
const REQUEST_META = { requestId: 'req-1', remoteAddress: '203.0.113.5', userAgent: 'jest' };

interface TransactionOverrides {
  readonly status?: TransactionStatus;
  readonly gatewayType?: PaymentGatewayType;
  readonly fulfilledAt?: Date | null;
  readonly gatewayId?: string | null;
  readonly gatewayData?: Record<string, unknown> | null;
  readonly amount?: string;
}

function createTransaction(overrides: TransactionOverrides = {}) {
  return {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    status: overrides.status ?? TransactionStatus.COMPLETED,
    gatewayType: overrides.gatewayType ?? PaymentGatewayType.YOOKASSA,
    gatewayId: overrides.gatewayId === undefined ? 'yoo-payment-1' : overrides.gatewayId,
    gatewayData: overrides.gatewayData ?? null,
    fulfilledAt:
      overrides.fulfilledAt === undefined ? new Date('2026-04-19T11:00:00.000Z') : overrides.fulfilledAt,
    currency: 'RUB',
    amount: { toString: () => overrides.amount ?? '1000.00' },
  };
}

function createService(input: {
  readonly transaction?: ReturnType<typeof createTransaction> | null;
  readonly gateway?: Record<string, unknown> | null;
  readonly httpStatus?: number;
  readonly httpData?: unknown;
} = {}) {
  const state = {
    updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    audits: [] as Array<Record<string, unknown>>,
    posts: [] as Array<{ url: string; body: Record<string, unknown>; config: Record<string, unknown> }>,
    // Emulates the refund webhook landing between the provider call and our
    // write: the row re-read afterwards already carries reconciliation stamps.
    refreshedGatewayData: null as Record<string, unknown> | null,
    refreshedCalls: 0,
  };
  const transaction = input.transaction === undefined ? createTransaction() : input.transaction;
  // The refund write is fenced with `SELECT ... FOR UPDATE` inside an
  // interactive transaction. With no contender a pass-through is enough; the
  // interleave tests below model the lock for real.
  const transactionClient = {
    $queryRaw: async () => [{ id: 'tx-1' }],
    transaction: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (args.select !== undefined) {
          state.refreshedCalls += 1;
          return { gatewayData: state.refreshedGatewayData };
        }
        return transaction;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        state.updates.push(args);
        return null;
      },
    },
  };
  const prisma = {
    ...transactionClient,
    $transaction: async <T>(callback: (tx: typeof transactionClient) => Promise<T>): Promise<T> =>
      callback(transactionClient),
    paymentGateway: {
      findUnique: async () =>
        input.gateway === undefined
          ? {
              type: PaymentGatewayType.YOOKASSA,
              isActive: true,
              settings: { shopId: 'shop-1', apiKey: 'key-1' },
            }
          : input.gateway,
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.audits.push(args.data);
        return null;
      },
    },
  };
  const httpService = {
    post: (url: string, body: Record<string, unknown>, config: Record<string, unknown>) => {
      state.posts.push({ url, body, config });
      return of({
        status: input.httpStatus ?? 200,
        data: input.httpData ?? { id: 'refund-1', status: 'succeeded' },
      });
    },
  };
  // A FULL refund now reverses the side-effects here instead of waiting for a
  // provider webhook that some gateways never send.
  const reversals: string[] = [];
  const service = new PaymentRefundService(
    prisma as never,
    httpService as never,
    new PaymentWebhookPayloadRedactionService(),
    {
      reverseFulfilledPayment: async (transaction: { id: string }) => {
        reversals.push(transaction.id);
      },
    } as never,
  );
  return { service, state, reversals };
}

/**
 * Both refund writers against ONE row, with a real lock.
 *
 * `$transaction` models `SELECT ... FOR UPDATE`: whoever is inside the callback
 * holds the row and every other writer queues behind it. That is precisely what
 * the fence buys — before it the panel opened no transaction at all, so a
 * concurrent write landed between its read and its write and was then
 * overwritten wholesale.
 *
 * The counterpart is `PaymentReconciliationService.handleRefundReversal`,
 * modelled by `webhookRefund` with the merge it actually performs (id-keyed
 * dedupe, running total, reverse iff this entry crosses the captured amount).
 * `payment-reconciliation-notifications.service.spec.ts` pins that producing
 * shape and drives the mirror-image race against the real service.
 */
function createRefundRace(input: {
  readonly paidAmount: string;
  /** Fires the instant the panel has read the ledger — the window at issue. */
  readonly webhookRefund: { readonly refundId: string; readonly amount: string };
}) {
  const row = { gatewayData: null as Record<string, unknown> | null };
  const paid = Number(input.paidAmount);
  const reversals: string[] = [];
  const commits: string[] = [];
  const pending: Array<Promise<void>> = [];
  let webhookArmed = true;

  // FIFO row lock: each holder queues behind the one before it.
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

  const webhookRefund = (refundId: string, amount: string): Promise<void> =>
    withRowLock(() => {
      const live = row.gatewayData ?? {};
      const ledger = Array.isArray(live.refunds)
        ? [...(live.refunds as ReadonlyArray<{ refundId: string; amount: string; at: string }>)]
        : [];
      const alreadyLedgered = ledger.some((entry) => entry.refundId === refundId);
      if (!alreadyLedgered) {
        ledger.push({ refundId, amount, at: '2026-04-19T12:30:00.000Z' });
      }
      const total =
        Number(live.refundedAmountTotal ?? '0') + (alreadyLedgered ? 0 : Number(amount));
      row.gatewayData = { ...live, refunds: ledger, refundedAmountTotal: total.toFixed(2) };
      commits.push(`webhook:${refundId}`);
      if (total >= paid - 0.000001) {
        reversals.push(`webhook:${refundId}`);
      }
    });

  const transaction = createTransaction({ amount: input.paidAmount });
  const transactionClient = {
    $queryRaw: async () => [{ id: 'tx-1' }],
    transaction: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (args.select === undefined) {
          return transaction;
        }
        // Snapshot BEFORE releasing the counterpart, so the panel is holding
        // exactly what a stale read would have handed it.
        const snapshot = { gatewayData: row.gatewayData };
        if (webhookArmed) {
          webhookArmed = false;
          pending.push(webhookRefund(input.webhookRefund.refundId, input.webhookRefund.amount));
        }
        return snapshot;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        row.gatewayData = args.data.gatewayData as Record<string, unknown>;
        commits.push('panel');
        return null;
      },
    },
  };
  const prisma = {
    ...transactionClient,
    $transaction: async <T>(callback: (tx: typeof transactionClient) => Promise<T>): Promise<T> =>
      withRowLock(() => callback(transactionClient)),
    paymentGateway: {
      findUnique: async () => ({
        type: PaymentGatewayType.YOOKASSA,
        isActive: true,
        settings: { shopId: 'shop-1', apiKey: 'key-1' },
      }),
    },
    adminAuditLog: { create: async () => null },
  };
  const httpService = {
    // A DIFFERENT refund from the webhook's, so neither side may deduplicate
    // the other away — both entries have to end up in the ledger.
    post: () => of({ status: 200, data: { id: 'refund-2', status: 'succeeded' } }),
  };
  const service = new PaymentRefundService(
    prisma as never,
    httpService as never,
    new PaymentWebhookPayloadRedactionService(),
    {
      reverseFulfilledPayment: async (reversed: { id: string }) => {
        reversals.push(`panel:${reversed.id}`);
      },
    } as never,
  );
  return {
    service,
    row,
    reversals,
    commits,
    /** Waits for the counterpart writer to drain off the row lock. */
    settle: async (): Promise<void> => {
      await Promise.all(pending);
    },
  };
}

describe('PaymentRefundService.getEligibility', () => {
  it('allows a fulfilled YooKassa payment and reports the full amount as refundable', async () => {
    const { service } = createService();
    assert.deepStrictEqual(await service.getEligibility('tx-1'), {
      refundable: true,
      reason: null,
      refundableAmount: '1000.00',
      currency: 'RUB',
      refundedAmount: '0.00',
    });
  });

  it('subtracts what was already refunded', async () => {
    const { service } = createService({
      transaction: createTransaction({ gatewayData: { refundedAmountTotal: '400.00' } }),
    });
    const eligibility = await service.getEligibility('tx-1');
    assert.equal(eligibility.refundable, true);
    assert.equal(eligibility.refundableAmount, '600.00');
    assert.equal(eligibility.refundedAmount, '400.00');
  });

  it('refuses every non-refundable state with a specific reason', async () => {
    const cases: ReadonlyArray<[TransactionOverrides, string]> = [
      [{ gatewayType: PaymentGatewayType.TELEGRAM_STARS }, 'PAYMENT_REFUND_UNSUPPORTED_GATEWAY'],
      [{ status: TransactionStatus.PENDING }, 'PAYMENT_REFUND_NOT_COMPLETED'],
      [{ fulfilledAt: null }, 'PAYMENT_REFUND_NOT_FULFILLED'],
      [{ gatewayId: null }, 'PAYMENT_REFUND_MISSING_PROVIDER_ID'],
      // Checkout claim marker — not a real provider id.
      [{ gatewayId: '__RENEWAL_PROVIDER_CREATE__:tx-1' }, 'PAYMENT_REFUND_MISSING_PROVIDER_ID'],
      [{ gatewayData: { refundedAmountTotal: '1000.00' } }, 'PAYMENT_REFUND_ALREADY_REFUNDED'],
    ];
    for (const [overrides, reason] of cases) {
      const { service } = createService({ transaction: createTransaction(overrides) });
      const eligibility = await service.getEligibility('tx-1');
      assert.equal(eligibility.refundable, false, `expected ${reason} to block the refund`);
      assert.equal(eligibility.reason, reason);
    }
  });

  it('throws when the transaction does not exist', async () => {
    const { service } = createService({ transaction: null });
    await assert.rejects(() => service.getEligibility('missing'), /not found/i);
  });
});

describe('PaymentRefundService.refundTransaction', () => {
  // The reversal used to run only from a `refund.succeeded` webhook. A gateway
  // that sends none — or a refund the operator issues in the provider's own
  // dashboard — left the partner commission paid, the income declared to the tax
  // service and the advertising revenue standing forever.
  it('reverses the side-effects itself on a full refund', async () => {
    const { service, reversals } = createService();
    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: null, // null = refund everything
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });
    assert.deepEqual(reversals, ['tx-1']);
  });

  it('leaves the side-effects alone on a partial refund', async () => {
    // An all-or-nothing reversal would wipe the whole commission and cancel the
    // full tax income over a small giveback, so a partial refund is escalated to
    // an operator instead — the same rule the webhook path applies.
    const { service, reversals } = createService();
    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '100.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });
    assert.deepEqual(reversals, []);
  });


  it('calls the provider with a transaction+amount idempotence key and records the audit trail', async () => {
    const { service, state } = createService();

    const result = await service.refundTransaction({
      transactionId: 'tx-1',
      amount: null,
      reason: 'duplicate charge',
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    assert.deepStrictEqual(result, {
      transactionId: 'tx-1',
      refundId: 'refund-1',
      amount: '1000.00',
      currency: 'RUB',
      providerStatus: 'succeeded',
    });
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].url, 'https://api.yookassa.ru/v3/refunds');
    assert.deepStrictEqual(state.posts[0].body, {
      payment_id: 'yoo-payment-1',
      amount: { value: '1000.00', currency: 'RUB' },
      description: 'duplicate charge',
    });
    // Same transaction + same amount must replay the original refund, never
    // create a second one.
    assert.equal(
      (state.posts[0].config.headers as Record<string, string>)['Idempotence-Key'],
      'refund:tx-1:1000.00',
    );
    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundedAmountTotal, '1000.00');
    assert.equal(gatewayData.refundId, 'refund-1');
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].action, 'payments.transaction.refund');
  });

  it('does not double-count when the provider replays the same refund', async () => {
    // Same transaction + same amount = same Idempotence-Key, so YooKassa hands
    // back the ORIGINAL refund instead of creating a second one. Summing the
    // amount again would invent a refund that never happened and lock the
    // operator out of the remaining balance.
    const { service, state } = createService({
      transaction: createTransaction({
        gatewayData: {
          refunds: [{ refundId: 'refund-1', amount: '300.00', at: '2026-04-19T12:00:00.000Z' }],
          refundedAmountTotal: '300.00',
        },
      }),
    });

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '300.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal((gatewayData.refunds as unknown[]).length, 1);
    assert.equal(gatewayData.refundedAmountTotal, '300.00');
  });

  it('does not count a pending refund against the refundable balance', async () => {
    // A pending refund can still be cancelled; reserving the amount would strand
    // it with no way to re-issue.
    const { service, state } = createService({
      httpData: { id: 'refund-pending', status: 'pending' },
    });

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '100.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.deepStrictEqual(gatewayData.refunds, []);
    assert.equal(gatewayData.refundedAmountTotal, '0.00');
  });

  it('accumulates on top of a total recorded outside the panel (webhook, no ledger)', async () => {
    // A refund issued straight in the provider dashboard reaches us as a
    // webhook that records the total but no ledger entry. Deriving the total
    // from the ledger alone would forget it and hand back balance already gone.
    const { service, state } = createService({
      transaction: createTransaction({ gatewayData: { refundedAmountTotal: '250.00' } }),
    });

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '150.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundedAmountTotal, '400.00');
  });

  it('re-reads the row so a refund webhook arriving mid-flight is not clobbered', async () => {
    const { service, state } = createService();
    // Reconciliation wrote these while the provider call was in flight.
    state.refreshedGatewayData = {
      refundReversedAt: '2026-04-19T12:00:00.000Z',
      subscriptionRevoked: true,
    };

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '100.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    assert.equal(state.refreshedCalls, 1);
    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundReversedAt, '2026-04-19T12:00:00.000Z');
    assert.equal(gatewayData.subscriptionRevoked, true);
    assert.equal(gatewayData.refundId, 'refund-1');
  });

  it('does not double-count when the refund webhook lands before the panel write', async () => {
    // The race, from the panel's side. The operator refunds 500 of 1000; the
    // `refund.succeeded` webhook for that same refund arrives while the provider
    // call is still in flight and reconciliation records it. The re-read must
    // recognise the refund by its provider id and not count it a second time —
    // 1000 would read as a full refund and revoke a subscription the customer
    // has only been given half their money back for.
    //
    // This is exactly what `PaymentReconciliationService` writes on a partial
    // refund; `payment-reconciliation-notifications.service.spec.ts` pins the
    // producing side of the same shape.
    const { service, state, reversals } = createService();
    state.refreshedGatewayData = {
      refundedAmountTotal: '500.00',
      refunds: [{ refundId: 'refund-1', amount: '500.00', at: '2026-04-19T12:00:00.000Z' }],
      partialRefundAt: '2026-04-19T12:00:00.000Z',
      refundNeedsManualReview: true,
    };

    await service.refundTransaction({
      transactionId: 'tx-1',
      amount: '500.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });

    const gatewayData = state.updates[0].data.gatewayData as Record<string, unknown>;
    assert.equal(gatewayData.refundedAmountTotal, '500.00');
    assert.equal((gatewayData.refunds as unknown[]).length, 1);
    assert.deepEqual(reversals, []);
  });

  // The genuine interleave, with both writers on ONE row and a real lock. Two
  // DIFFERENT refunds: the panel issues refund-2 while the `refund.succeeded`
  // webhook for refund-1 is being reconciled. Before the row lock the panel
  // merged onto a snapshot it had already read, so the webhook's write landed in
  // that gap and was overwritten — the ledger lost an entry and the total went
  // backwards. Under-counting is safe by construction (it can only ever fall
  // into the partial branch), which is why this was a latent hardening gap and
  // not an active money leak, but the accounting was still wrong and the
  // reversal that should have fired never did.
  it('panel-then-webhook: both ledger entries survive and the reversal fires exactly once', async () => {
    const race = createRefundRace({
      paidAmount: '1000.00',
      webhookRefund: { refundId: 'refund-1', amount: '500.00' },
    });

    await race.service.refundTransaction({
      transactionId: 'tx-1',
      amount: '500.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });
    await race.settle();

    // The panel committed first, the webhook merged onto what it committed.
    assert.deepEqual(race.commits, ['panel', 'webhook:refund-1']);
    assert.deepEqual(
      (race.row.gatewayData?.refunds as ReadonlyArray<{ refundId: string }>).map(
        (entry) => entry.refundId,
      ),
      ['refund-2', 'refund-1'],
    );
    assert.equal(race.row.gatewayData?.refundedAmountTotal, '1000.00');
    // 500 + 500 of 1000 — the customer is whole, so exactly one of the two
    // writers must reverse, and it is the one whose entry crossed.
    assert.deepEqual(race.reversals, ['webhook:refund-1']);
  });

  it('panel-then-webhook: keeps both entries and reverses nothing when they fall short', async () => {
    // Same interleave, amounts that do NOT add up to the captured 1000. The
    // ledger still has to carry both, and the all-or-nothing reversal must stay
    // out of it — a partial giveback leaves the commission, the tax income and
    // the subscription exactly as they were.
    const race = createRefundRace({
      paidAmount: '1000.00',
      webhookRefund: { refundId: 'refund-1', amount: '300.00' },
    });

    await race.service.refundTransaction({
      transactionId: 'tx-1',
      amount: '500.00',
      reason: null,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_META,
    });
    await race.settle();

    assert.equal((race.row.gatewayData?.refunds as unknown[]).length, 2);
    assert.equal(race.row.gatewayData?.refundedAmountTotal, '800.00');
    assert.deepEqual(race.reversals, []);
  });

  it('refuses an amount above the remaining balance before calling the provider', async () => {
    const { service, state } = createService({
      transaction: createTransaction({ gatewayData: { refundedAmountTotal: '900.00' } }),
    });

    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: '200.00',
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /EXCEEDS_BALANCE/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('refuses a non-positive amount', async () => {
    const { service, state } = createService();
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: '0',
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /AMOUNT_INVALID/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('refuses to touch the provider when the transaction is not refundable', async () => {
    const { service, state } = createService({
      transaction: createTransaction({ status: TransactionStatus.CANCELED }),
    });
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /NOT_COMPLETED/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('surfaces a provider rejection and writes nothing', async () => {
    const { service, state } = createService({
      httpStatus: 400,
      httpData: { code: 'invalid_request', description: 'not enough funds' },
    });

    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /PAYMENT_REFUND_PROVIDER_REJECTED/,
    );
    assert.deepStrictEqual(state.updates, []);
    assert.deepStrictEqual(state.audits, []);
  });

  it('refuses to refund through a disabled gateway', async () => {
    const { service, state } = createService({
      gateway: { type: PaymentGatewayType.YOOKASSA, isActive: false, settings: { shopId: 's', apiKey: 'k' } },
    });
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /PAYMENT_GATEWAY_NOT_ACTIVE/,
    );
    assert.equal(state.posts.length, 0);
  });

  it('fails when the gateway is not configured', async () => {
    const { service, state } = createService({ gateway: null });
    await assert.rejects(
      () =>
        service.refundTransaction({
          transactionId: 'tx-1',
          amount: null,
          reason: null,
          currentAdmin: ADMIN,
          requestMetadata: REQUEST_META,
        }),
      /PAYMENT_GATEWAY_NOT_ACTIVE/,
    );
    assert.equal(state.posts.length, 0);
  });
});
