import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TransactionStatus } from '@prisma/client';

import { PaymentPendingExpiryService } from '../src/modules/payments/services/payment-pending-expiry.service';

interface StaleRow {
  id: string;
  paymentId: string;
  userId: string;
  purchaseType: string;
  gatewayType: string;
  amount: { toString: () => string };
  currency: string;
}

function buildService(options: {
  stale: StaleRow[];
  updateCounts?: Record<string, number>; // id → updateMany count (default 1)
}) {
  const events: Array<{ type: string }> = [];
  const updateWhere: Array<Record<string, unknown>> = [];

  const prisma = {
    transaction: {
      findMany: async () => options.stale,
      updateMany: async ({ where }: { where: { id: string; status: TransactionStatus } }) => {
        updateWhere.push(where);
        const count = options.updateCounts?.[where.id] ?? 1;
        return { count };
      },
    },
  };
  const systemEvents = {
    info: (type: string) => {
      events.push({ type });
    },
  };
  const service = new PaymentPendingExpiryService(prisma as never, systemEvents as never);
  return { service, events, updateWhere };
}

function row(id: string): StaleRow {
  return {
    id,
    paymentId: `pay_${id}`,
    userId: 'u1',
    purchaseType: 'NEW',
    gatewayType: 'PLATEGA',
    amount: { toString: () => '1' },
    currency: 'RUB',
  };
}

describe('PaymentPendingExpiryService', () => {
  it('cancels stale PENDING transactions and emits an expiry event', async () => {
    const { service, events, updateWhere } = buildService({ stale: [row('t1'), row('t2')] });

    await service.expireStalePending();

    // Race-safe: every update is guarded on status = PENDING.
    assert.equal(updateWhere.length, 2);
    for (const w of updateWhere) {
      assert.equal(w.status, TransactionStatus.PENDING);
    }
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'payment.expired');
  });

  it('does not emit when a concurrent webhook already moved the row (race lost)', async () => {
    const { service, events } = buildService({
      stale: [row('t1')],
      updateCounts: { t1: 0 },
    });

    await service.expireStalePending();

    assert.equal(events.length, 0);
  });

  it('is a no-op when there are no stale pending transactions', async () => {
    const { service, events, updateWhere } = buildService({ stale: [] });

    await service.expireStalePending();

    assert.equal(updateWhere.length, 0);
    assert.equal(events.length, 0);
  });
});
