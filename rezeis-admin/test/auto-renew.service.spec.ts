import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType, TransactionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';

/**
 * Regression coverage for the createExpiryWarnings dedup after the N+1 removal:
 * the per-subscription `findFirst` was replaced by a single `findMany` + Set.
 * These tests pin the exact behavior — one notification per user per run,
 * users with a recent event skipped, and the dedup query fired ONCE.
 */

interface SubRow {
  id: string;
  userId: string;
  expiresAt: Date;
  planSnapshot: unknown;
}

function createHarness(opts: {
  expiring: SubRow[];
  alreadyNotifiedUserIds: string[];
}): {
  service: AutoRenewService;
  createdFor: string[];
  counters: { eventFindMany: number };
} {
  const createdFor: string[] = [];
  // Object (not a primitive) so the closure's increments are visible via the
  // returned reference.
  const counters = { eventFindMany: 0 };

  const prisma = {
    subscription: {
      // HONOURS `userId.notIn`. The already-notified customers are now excluded
      // in the QUERY rather than dropped from the batch afterwards, which is
      // what stops a full batch of people who have all been told from coming
      // back every tick and starving the ones behind it. A double that ignored
      // the term would make that fix untestable.
      findMany: async (args: {
        where?: { userId?: { notIn?: string[] } };
        take?: number;
      }) => {
        const excluded = new Set(args.where?.userId?.notIn ?? []);
        const matching = opts.expiring.filter((row) => !excluded.has(row.userId));
        // `take` IS honoured, and it has to be: the starvation this fix is
        // about only appears at the batch boundary. A double that returned
        // everything would make the batch-full case unreachable and the test
        // below would pass against the defect.
        return args.take === undefined ? matching : matching.slice(0, args.take);
      },
    },
    userNotificationEvent: {
      // Asked by type and recency only — every customer told inside the window,
      // not just the ones in some batch we happened to read first.
      findMany: async () => {
        counters.eventFindMany += 1;
        return opts.alreadyNotifiedUserIds.map((userId) => ({ userId }));
      },
    },
  };

  const userNotifications = {
    create: async (input: { userId: string }) => {
      createdFor.push(input.userId);
    },
  };

  const service = new AutoRenewService(
    prisma as never,
    userNotifications as never,
    { createCheckout: async () => ({}) } as never,
    { findPreferredForCharge: async () => null } as never,
    // The shared notice-payload builder. Inert here: what these cases are
    // about is who gets notified and how often, not what the message says.
    { build: async () => ({}) } as never,
  );
  return { service, createdFor, counters };
}

const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('AutoRenewService.createExpiryWarnings', () => {
  it('notifies each un-notified user exactly once and dedups the query to a single findMany', async () => {
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon, planSnapshot: { name: 'Pro' } },
        { id: 's2', userId: 'userB', expiresAt: soon, planSnapshot: { name: 'Pro' } },
      ],
      alreadyNotifiedUserIds: [],
    });
    const created = await h.service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' });
    assert.equal(created, 2);
    assert.deepEqual(h.createdFor.sort(), ['userA', 'userB']);
    assert.equal(h.counters.eventFindMany, 1); // no N+1
  });

  it('skips a user who already has a recent notification of this type', async () => {
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon, planSnapshot: {} },
        { id: 's2', userId: 'userB', expiresAt: soon, planSnapshot: {} },
      ],
      alreadyNotifiedUserIds: ['userA'],
    });
    const created = await h.service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' });
    assert.equal(created, 1);
    assert.deepEqual(h.createdFor, ['userB']);
  });

  it('sends only ONE notification to a user with multiple expiring subs (within-batch dedup)', async () => {
    const h = createHarness({
      expiring: [
        { id: 's1', userId: 'userA', expiresAt: soon, planSnapshot: {} },
        { id: 's2', userId: 'userA', expiresAt: soon, planSnapshot: {} },
        { id: 's3', userId: 'userA', expiresAt: soon, planSnapshot: {} },
      ],
      alreadyNotifiedUserIds: [],
    });
    const created = await h.service.createExpiryWarnings({ daysAhead: 3, notificationType: 'expires_in_3_days' });
    assert.equal(created, 1);
    assert.deepEqual(h.createdFor, ['userA']);
  });

  it('sends nothing, and asks for the notified set exactly once, when nothing is expiring', async () => {
    // The events query now runs FIRST and unconditionally, which reverses what
    // this test used to assert. It has to: the already-notified customers are
    // excluded in the subscription query rather than dropped from the batch
    // afterwards, and that is what stops a full batch of people who have all
    // been told from coming back every tick while the ones behind it are never
    // reached — a permanent miss, because a subscription sits in its window for
    // only three hours.
    //
    // The cost is one indexed read per family per tick on an idle install. The
    // thing it buys is that no customer silently goes untold.
    const h = createHarness({ expiring: [], alreadyNotifiedUserIds: [] });
    const created = await h.service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' });
    assert.equal(created, 0);
    assert.equal(h.counters.eventFindMany, 1);
    assert.deepEqual(h.createdFor, []);
  });

  it('reaches the customers behind a batch full of already-notified ones', async () => {
    // THE starvation case. Under the old shape the batch was taken first and
    // filtered afterwards, so a window holding more expiries than one batch
    // served the same already-notified rows every tick and never advanced. The
    // rows it could not reach were the oldest — the ones that leave the window
    // first — so they were not delayed, they were never told at all, and
    // `created: 0` read exactly like a quiet night.
    // One batch (200) of customers who have all been told, plus five behind
    // them. Under the old shape the take returned the first 200, every one of
    // them was dropped in memory, and the five were never seen — on this tick
    // or any other, because the query is deterministic.
    const WARNING_BATCH = 200;
    const expiring = Array.from({ length: WARNING_BATCH + 5 }, (_, index) => ({
      id: `sub-${index}`,
      userId: `user-${index}`,
      expiresAt: new Date(Date.now() + 60_000),
      planSnapshot: null,
    })) as never[];
    const h = createHarness({
      expiring,
      alreadyNotifiedUserIds: Array.from(
        { length: WARNING_BATCH },
        (_, index) => `user-${index}`,
      ),
    });

    const created = await h.service.createExpiryWarnings({
      daysAhead: 3,
      notificationType: 'expires_in_3_days',
    });

    assert.equal(created, 5);
    assert.deepEqual(h.createdFor, [
      'user-200',
      'user-201',
      'user-202',
      'user-203',
      'user-204',
    ]);
  });
});

describe('AutoRenewService.processAutopayCharges', () => {
  it('does not create attempt a2 while the a1 provider outcome is unresolved', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    let renewalCalls = 0;
    const prisma = {
      subscription: {
        findMany: async () => [{ id: 'sub-1', userId: 'user-1', expiresAt }],
      },
      transaction: {
        findMany: async () => [
          {
            status: TransactionStatus.PENDING,
            idempotencyKey: `auto-renew:sub-1:${expiresAt.getTime()}:a1`,
            checkoutUrl: null,
            gatewayId: '__RENEWAL_PROVIDER_CREATE__:payment-a1',
          },
        ],
      },
    };
    const service = new AutoRenewService(
      prisma as never,
      { create: async () => undefined } as never,
      {
        renewalCheckout: async () => {
          renewalCalls += 1;
          throw new Error('attempt a2 must not be created');
        },
      } as never,
      {
        findPreferredForCharge: async () => ({
          id: 'method-1',
          gatewayType: PaymentGatewayType.YOOKASSA,
        }),
      } as never,
      // The shared notice-payload builder. Inert here: what these cases are
      // about is who gets notified and how often, not what the message says.
      { build: async () => ({}) } as never,
    );

    const result = await service.processAutopayCharges();

    assert.equal(renewalCalls, 0);
    assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, skipped: 1 });
  });
});
