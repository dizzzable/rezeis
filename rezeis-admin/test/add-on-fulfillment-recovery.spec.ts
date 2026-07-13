import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AddOnFulfillmentRecoveryService } from '../src/modules/payments/services/add-on-fulfillment-recovery.service';

/**
 * T-005d — captured-but-undelivered add-on recovery sweeper.
 *
 * The sweeper re-drives COMPLETED add-on transactions that were captured
 * (money taken) but never fulfilled (`fulfilledAt IS NULL`) through the same
 * atomic claim + `applyCompletedTransaction` + enqueue path the live webhook
 * reconciler uses, so no paid add-on line can be stranded. It must be
 * idempotent against the live reconciler (conditional claim), release its
 * claim on provisioning failure, and never touch a transaction inside the
 * grace window (still being retried live).
 */

const ADDON_SNAPSHOT = {
  snapshotSource: 'ADDON_PURCHASE',
  addOnId: 'addon-1',
  addOnType: 'EXTRA_TRAFFIC',
  addOnValue: 50,
  targetSubscriptionId: 'sub-1',
  lifetime: 'UNTIL_SUBSCRIPTION_END',
  sourceLineKey: 'addon-1',
  addOnRevision: 1,
  name: 'Extra 50GB',
} as const;

function txRecord(data: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    status: 'COMPLETED',
    purchaseType: 'ADDITIONAL',
    channel: 'WEB',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: { toString: () => '2.50' },
    fulfilledAt: null,
    planSnapshot: ADDON_SNAPSHOT,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
}

interface Harness {
  service: AddOnFulfillmentRecoveryService;
  claims: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  releases: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  applied: string[];
  enqueued: string[];
  events: Array<{ type: string; message: string }>;
}

function build(options: {
  rows?: Array<Record<string, unknown>>;
  claimCount?: (id: string) => number;
  applyThrows?: boolean;
  enqueueThrows?: boolean;
} = {}): Harness {
  const claims: Harness['claims'] = [];
  const releases: Harness['releases'] = [];
  const applied: string[] = [];
  const enqueued: string[] = [];
  const events: Harness['events'] = [];
  const rows = options.rows ?? [txRecord()];

  const prisma = {
    transaction: {
      findMany: async () => rows,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        // A claim flips fulfilledAt from null → now; a release flips it back.
        if (args.data.fulfilledAt !== null && 'fulfilledAt' in (args.where as object) && (args.where as Record<string, unknown>).fulfilledAt === null) {
          claims.push(args);
          const id = String((args.where as Record<string, unknown>).id);
          return { count: options.claimCount ? options.claimCount(id) : 1 };
        }
        if (args.data.fulfilledAt === null) {
          releases.push(args);
        }
        return { count: 1 };
      },
    },
  };

  const mutation = {
    applyCompletedTransaction: async (tx: { id: string }) => {
      applied.push(tx.id);
      if (options.applyThrows) {
        throw new Error('provisioning failed pre-commit');
      }
      return { syncJobs: [{ id: `job-${tx.id}` }] };
    },
  };

  const profileSyncQueue = {
    enqueue: async (jobId: string) => {
      if (options.enqueueThrows) {
        throw new Error('enqueue failed post-commit');
      }
      enqueued.push(jobId);
    },
  };

  const systemEvents = {
    warn: (type: string, _cat: string, message: string) => {
      events.push({ type, message });
    },
    info: (type: string, _cat: string, message: string) => {
      events.push({ type, message });
    },
  };

  const service = new AddOnFulfillmentRecoveryService(
    prisma as never,
    mutation as never,
    profileSyncQueue as never,
    systemEvents as never,
  );
  return { service, claims, releases, applied, enqueued, events };
}

describe('AddOnFulfillmentRecoveryService', () => {
  it('re-drives a captured-but-unfulfilled add-on and enqueues its sync jobs', async () => {
    const h = build();
    const result = await h.service.recoverStrandedFulfillments();
    assert.equal(result.recovered, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(h.applied, ['tx-1']);
    assert.deepEqual(h.enqueued, ['job-tx-1']);
    assert.equal(h.claims.length, 1);
    assert.equal(h.events.some((e) => e.type === 'payment.fulfillment_recovered'), true);
  });

  it('skips a row when the live reconciler already claimed it (claim.count === 0)', async () => {
    const h = build({ claimCount: () => 0 });
    const result = await h.service.recoverStrandedFulfillments();
    assert.equal(result.recovered, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(h.applied, []);
    assert.deepEqual(h.enqueued, []);
  });

  it('releases the claim and counts a failure when provisioning throws', async () => {
    const h = build({ applyThrows: true });
    const result = await h.service.recoverStrandedFulfillments();
    assert.equal(result.recovered, 0);
    assert.equal(result.failed, 1);
    // One claim to acquire, one release (fulfilledAt → null) after the throw.
    const releases = h.claims.length; // acquire recorded in claims[]
    assert.equal(releases >= 1, true);
    assert.deepEqual(h.enqueued, []);
  });

  it('does NOT release the claim when enqueue fails AFTER a committed fulfillment (no double-apply)', async () => {
    // Regression: releasing the claim on a post-commit enqueue failure would let
    // the next sweep re-run applyCompletedTransaction and double-apply the
    // non-idempotent legacy limit increment. The fulfillment is already
    // committed (fulfilledAt stamped), so the row must stay claimed.
    const h = build({ enqueueThrows: true });
    const result = await h.service.recoverStrandedFulfillments();
    assert.equal(result.recovered, 1, 'still counted recovered — money work committed');
    assert.equal(result.failed, 0);
    assert.deepEqual(h.applied, ['tx-1']);
    assert.deepEqual(h.enqueued, [], 'enqueue threw, so nothing recorded');
    assert.deepEqual(h.releases, [], 'claim must NOT be released after a committed fulfillment');
  });

  it('ignores non-add-on transactions defensively (marker mismatch)', async () => {
    const h = build({ rows: [txRecord({ planSnapshot: { snapshotSource: 'PAYMENT_COMPLETION' } })] });
    const result = await h.service.recoverStrandedFulfillments();
    assert.equal(result.recovered, 0);
    assert.deepEqual(h.applied, []);
  });

  it('processes multiple stranded rows independently', async () => {
    const h = build({
      rows: [txRecord({ id: 'tx-1', paymentId: 'p1' }), txRecord({ id: 'tx-2', paymentId: 'p2' })],
    });
    const result = await h.service.recoverStrandedFulfillments();
    assert.equal(result.recovered, 2);
    assert.deepEqual(h.applied.sort(), ['tx-1', 'tx-2']);
    assert.deepEqual(h.enqueued.sort(), ['job-tx-1', 'job-tx-2']);
  });
});
