import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionStatus } from '@prisma/client';

import {
  claimForImmediateFulfillment,
  enqueueSyncJobsDeferringFailure,
  releaseFulfillmentClaim,
} from '../src/modules/payments/services/payment-fulfillment-claim.util';

describe('payment-fulfillment-claim.util fencing', () => {
  it('releases only the exact claim lease, not a newer one', async () => {
    const row = {
      id: 'tx-1',
      status: TransactionStatus.PENDING as TransactionStatus,
      fulfilledAt: null as Date | null,
    };
    const prisma = {
      transaction: {
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const where = args.where;
          if (where['fulfilledAt'] === null && row.fulfilledAt === null) {
            Object.assign(row, args.data);
            return { count: 1 };
          }
          if (
            where['fulfilledAt'] instanceof Date &&
            row.fulfilledAt instanceof Date &&
            where['fulfilledAt'].getTime() === row.fulfilledAt.getTime()
          ) {
            Object.assign(row, args.data);
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
    };

    const first = await claimForImmediateFulfillment(prisma, 'tx-1');
    assert.ok(first instanceof Date);
    assert.equal(row.status, TransactionStatus.COMPLETED);

    // Simulate stale recovery / second path taking a new lease after release window.
    const secondLease = new Date(first.getTime() + 120_000);
    row.fulfilledAt = secondLease;

    await releaseFulfillmentClaim(prisma, 'tx-1', first);
    // Old claimant must not erase the newer lease.
    assert.equal(row.fulfilledAt?.getTime(), secondLease.getTime());

    await releaseFulfillmentClaim(prisma, 'tx-1', secondLease);
    assert.equal(row.fulfilledAt, null);
  });

  it('returns null when claim is already held', async () => {
    const heldAt = new Date('2026-07-21T12:00:00.000Z');
    const prisma = {
      transaction: {
        updateMany: async () => ({ count: 0 }),
        // row already held — updateMany matches 0
      },
    };
    // Seed is irrelevant; count 0 means lost race.
    void heldAt;
    const claim = await claimForImmediateFulfillment(prisma, 'tx-2');
    assert.equal(claim, null);
  });
});

describe('enqueueSyncJobsDeferringFailure', () => {
  it('enqueues every job and answers null when Redis takes them all', async () => {
    const pushed: string[] = [];
    const failure = await enqueueSyncJobsDeferringFailure(
      { enqueue: async (id: string) => void pushed.push(id) },
      [{ id: 'sync-1' }, { id: 'sync-2' }],
    );

    assert.equal(failure, null);
    assert.deepStrictEqual(pushed, ['sync-1', 'sync-2']);
  });

  it('stops at the first refusal and RETURNS it instead of throwing past the caller', async () => {
    const pushed: string[] = [];
    const refusal = new Error('redis is down');

    const failure = await enqueueSyncJobsDeferringFailure(
      {
        enqueue: async (id: string) => {
          if (id === 'sync-2') throw refusal;
          pushed.push(id);
        },
      },
      [{ id: 'sync-1' }, { id: 'sync-2' }, { id: 'sync-3' }],
    );

    assert.deepStrictEqual(failure, { error: refusal });
    assert.deepStrictEqual(pushed, ['sync-1'], 'the sweep re-drives the PENDING rest');
  });
});
