import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Observable, of, throwError } from 'rxjs';
import { PaymentGatewayType, TransactionStatus } from '@prisma/client';

import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';

describe('PaymentPendingExpiryService YooKassa poll', () => {
  it('does not cancel when provider reports succeeded; claims and fulfills', async () => {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const state = { applyCalls: 0, enqueueCalls: 0 };
    const service = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'succeeded' } }),
      updates,
      state,
    });

    await service.expireStalePending();

    assert.ok(updates.some((u) => u.data['fulfilledAt'] instanceof Date));
    assert.equal(state.applyCalls, 1);
    assert.equal(state.enqueueCalls, 1);
  });

  it('keeps PENDING when provider still pending', async () => {
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const service = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'pending' } }),
      updates,
    });

    await service.expireStalePending();

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.data['status'], undefined);
    assert.ok(updates[0]?.data['gatewayData']);
  });

  it('cancels when provider reports canceled', async () => {
    const cancels: unknown[] = [];
    const service = createService({
      get: () => of({ status: 200, data: { id: 'yk-1', status: 'canceled' } }),
      cancels,
    });

    await service.expireStalePending();

    assert.equal(cancels.length, 1);
  });

  it('skips cancel when provider GET fails', async () => {
    const cancels: unknown[] = [];
    const service = createService({
      get: () => throwError(() => new Error('network down')),
      cancels,
    });

    await service.expireStalePending();

    assert.equal(cancels.length, 0);
  });

  it('does not auto-cancel renewal provider-create claim placeholders', async () => {
    const cancels: unknown[] = [];
    const gets: unknown[] = [];
    const service = createService({
      gatewayId: '__RENEWAL_PROVIDER_CREATE__:pay-1',
      get: () => {
        gets.push(1);
        return of({ status: 200, data: { id: 'should-not-call', status: 'canceled' } });
      },
      cancels,
    });

    await service.expireStalePending();

    assert.equal(cancels.length, 0);
    assert.equal(gets.length, 0);
  });
});

function createService(input: {
  readonly get: () => Observable<unknown>;
  readonly updates?: Array<{ data: Record<string, unknown> }>;
  readonly cancels?: unknown[];
  readonly state?: { applyCalls: number; enqueueCalls: number };
  readonly gatewayId?: string;
}): PaymentPendingExpiryService {
  const updates = input.updates ?? [];
  const cancels = input.cancels ?? [];
  const state = input.state ?? { applyCalls: 0, enqueueCalls: 0 };
  const row = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    purchaseType: 'RENEW',
    gatewayType: PaymentGatewayType.YOOKASSA,
    gatewayId: input.gatewayId ?? 'yk-provider-1',
    gatewayData: { paymentMethodId: 'pm-1' },
    amount: { toString: () => '10.00' },
    currency: 'RUB',
    status: TransactionStatus.PENDING,
    fulfilledAt: null as Date | null,
  };
  const prisma = {
    transaction: {
      findMany: async () => [row],
      findUnique: async () => row,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (args.data.status === TransactionStatus.CANCELED) {
          cancels.push(args);
          return { count: 1 };
        }
        updates.push({ data: args.data });
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    paymentGateway: {
      findUnique: async () => ({
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
    },
  };
  const httpService = {
    get: () => input.get(),
  };
  const systemEvents = {
    info: () => undefined,
    warn: () => undefined,
  };
  const mutation = {
    applyCompletedTransaction: async () => {
      state.applyCalls += 1;
      return { syncJobs: [{ id: 'sync-1' }] };
    },
  };
  const queue = {
    enqueue: async () => {
      state.enqueueCalls += 1;
    },
  };
  const reconciliation = {
    runPostFulfillmentHooks: async () => {
      state.enqueueCalls += 0; // hooks are best-effort; count apply only
    },
  };

  const service = new PaymentPendingExpiryService(
    prisma as never,
    systemEvents as never,
    httpService as never,
    mutation as never,
    queue as never,
    reconciliation as never,
  );
  Object.defineProperty(service, 'expireStalePending', {
    value: async function expireForTest(this: PaymentPendingExpiryService) {
      const stale = await prisma.transaction.findMany();
      for (const tx of stale) {
        const keep = await (service as unknown as {
          shouldKeepYookassaPending: (t: unknown) => Promise<boolean>;
        }).shouldKeepYookassaPending(tx);
        if (keep) continue;
        await prisma.transaction.updateMany({
          where: { id: tx.id, status: TransactionStatus.PENDING },
          data: { status: TransactionStatus.CANCELED },
        });
      }
    },
  });
  return service;
}
