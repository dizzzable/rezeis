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
      findMany: async () => opts.expiring,
    },
    userNotificationEvent: {
      findMany: async (args: { where: { userId: { in: string[] } } }) => {
        counters.eventFindMany += 1;
        const requested = new Set(args.where.userId.in);
        return opts.alreadyNotifiedUserIds
          .filter((id) => requested.has(id))
          .map((userId) => ({ userId }));
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

  it('returns 0 without querying events when nothing is expiring', async () => {
    const h = createHarness({ expiring: [], alreadyNotifiedUserIds: [] });
    const created = await h.service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' });
    assert.equal(created, 0);
    assert.equal(h.counters.eventFindMany, 0);
    assert.deepEqual(h.createdFor, []);
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
    );

    const result = await service.processAutopayCharges();

    assert.equal(renewalCalls, 0);
    assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, skipped: 1 });
  });
});
