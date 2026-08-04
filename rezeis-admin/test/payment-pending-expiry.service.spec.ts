import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Observable, of, throwError } from 'rxjs';
import { PaymentGatewayType, TransactionStatus } from '@prisma/client';

import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';

/**
 * These drive the REAL `expireStalePending`. An earlier version of this spec
 * replaced the method with a reimplementation that called the private provider
 * check directly — so it exercised the copy, not the code, and could not see
 * that the sweep cancelled a transaction while leaving its paid-trial
 * reservation RESERVED. That leak burned the buyer's trial quota permanently on
 * every abandoned checkout.
 */

interface ReleaseCall {
  readonly transactionId: unknown;
  readonly status: unknown;
  readonly reason: unknown;
}

describe('PaymentPendingExpiryService YooKassa poll', () => {
  it('does not cancel when provider reports succeeded; claims and fulfills', async () => {
    const h = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'succeeded' } }),
    });

    await h.service.expireStalePending();

    assert.ok(h.updates.some((u) => u.data['fulfilledAt'] instanceof Date));
    assert.equal(h.state.applyCalls, 1);
    assert.equal(h.state.enqueueCalls, 1);
    assert.equal(h.cancels.length, 0);
  });

  it('keeps PENDING when provider still pending', async () => {
    const h = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'pending' } }),
    });

    await h.service.expireStalePending();

    assert.equal(h.cancels.length, 0);
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0]?.data['status'], undefined);
    assert.ok(h.updates[0]?.data['gatewayData']);
  });

  it('cancels when provider reports canceled', async () => {
    const h = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'canceled' } }),
    });

    await h.service.expireStalePending();

    assert.equal(h.cancels.length, 1);
  });

  it('skips cancel when provider GET fails', async () => {
    const h = createService({ get: () => throwError(() => new Error('network down')) });

    await h.service.expireStalePending();

    assert.equal(h.cancels.length, 0);
  });

  it('does not auto-cancel renewal provider-create claim placeholders', async () => {
    const gets: unknown[] = [];
    const h = createService({
      gatewayId: '__RENEWAL_PROVIDER_CREATE__:pay-1',
      get: () => {
        gets.push(1);
        return of({ status: 200, data: { id: 'should-not-call', status: 'canceled' } });
      },
    });

    await h.service.expireStalePending();

    assert.equal(h.cancels.length, 0);
    assert.equal(gets.length, 0);
  });
});

describe('PaymentPendingExpiryService trial reservation release', () => {
  it('releases the paid-trial reservation when it cancels a stale draft', async () => {
    // The regression: without this the buyer's trial was gone for good, because
    // the quota counter treats RESERVED as spent and nothing else released it.
    const h = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'canceled' } }),
    });

    await h.service.expireStalePending();

    assert.equal(h.releases.length, 1);
    assert.equal(h.releases[0]?.transactionId, 'tx-1');
    assert.equal(h.releases[0]?.status, 'RESERVED');
  });

  it('credits the provider when the provider is the one calling it dead', async () => {
    const h = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'canceled' } }),
    });

    await h.service.expireStalePending();

    assert.equal(h.releases[0]?.reason, 'PROVIDER_TERMINAL_EXPIRED');
  });

  it('marks a release that rests on our own TTL as such', async () => {
    // No provider verdict is available without a YooKassa provider id, so the
    // reason must not claim one — it is the audit trail for this decision.
    const h = createService({
      gatewayId: null,
      get: () => of({ status: 200, data: {} }),
    });

    await h.service.expireStalePending();

    assert.equal(h.cancels.length, 1);
    assert.equal(h.releases[0]?.reason, 'LOCAL_TTL_EXPIRED');
  });

  it('releases nothing when it cancels nothing', async () => {
    const h = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'pending' } }),
    });

    await h.service.expireStalePending();

    assert.equal(h.releases.length, 0);
  });

  it('does not release when a webhook wins the cancel race', async () => {
    // `updateMany` matching zero rows means the payment completed between the
    // read and the write. Releasing then would free a reservation that is about
    // to be consumed by fulfillment.
    const h = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'canceled' } }),
      cancelRaceLost: true,
    });

    await h.service.expireStalePending();

    assert.equal(h.releases.length, 0);
  });
});

interface Harness {
  readonly service: PaymentPendingExpiryService;
  readonly updates: Array<{ data: Record<string, unknown> }>;
  readonly cancels: unknown[];
  readonly releases: ReleaseCall[];
  readonly state: { applyCalls: number; enqueueCalls: number };
}

function createService(input: {
  readonly get: () => Observable<unknown>;
  readonly gatewayId?: string | null;
  readonly cancelRaceLost?: boolean;
}): Harness {
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const cancels: unknown[] = [];
  const releases: ReleaseCall[] = [];
  const state = { applyCalls: 0, enqueueCalls: 0 };

  const row = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    purchaseType: 'NEW',
    gatewayType: PaymentGatewayType.YOOKASSA,
    gatewayId: input.gatewayId === undefined ? 'yk-provider-1' : input.gatewayId,
    gatewayData: { paymentMethodId: 'pm-1' },
    amount: { toString: () => '10.00' },
    currency: 'RUB',
    status: TransactionStatus.PENDING,
    fulfilledAt: null as Date | null,
  };

  const transactionClient = {
    transaction: {
      findMany: async () => [row],
      findUnique: async () => row,
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (args.data.status === TransactionStatus.CANCELED) {
          if (input.cancelRaceLost === true) return { count: 0 };
          cancels.push(args);
          return { count: 1 };
        }
        updates.push({ data: args.data });
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    trialClaim: {
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        releases.push({
          transactionId: args.where['transactionId'],
          status: args.where['status'],
          reason: args.data['releaseReason'],
        });
        return { count: 1 };
      },
    },
  };

  const prisma = {
    ...transactionClient,
    paymentGateway: {
      findUnique: async () => ({ settings: { shopId: 'shop-1', apiKey: 'secret-1' } }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(transactionClient),
  };

  const service = new PaymentPendingExpiryService(
    prisma as never,
    { info: () => undefined, warn: () => undefined } as never,
    { get: () => input.get() } as never,
    {
      applyCompletedTransaction: async () => {
        state.applyCalls += 1;
        return { syncJobs: [{ id: 'sync-1' }] };
      },
    } as never,
    {
      enqueue: async () => {
        state.enqueueCalls += 1;
      },
    } as never,
    { runPostFulfillmentHooks: async () => undefined } as never,
  );

  return { service, updates, cancels, releases, state };
}
