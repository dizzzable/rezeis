import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, TransactionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';
import { WINBACK_NOTIFICATION_TYPES } from '../src/modules/notifications/utils/notification-toggle.util';

/**
 * «Возврат покупателя» (the owner, 15.10.2026): 3, 7 and 14 days after a
 * subscription ended, a reminder to a customer who paid and has not come back
 * — «только платившим». Three rules, each a way to write to the wrong people:
 *
 *  - OFF until the operator turns it on: nothing at all is written while off,
 *    not even the cabinet's feed row an operator's switch otherwise leaves.
 *  - Only a customer who has paid money, is not blocked, and has no other live
 *    subscription — one who bought a new subscription has come back.
 *  - «Подписка закончилась вчера» is a reminder too, and stops for a customer
 *    who came back; the day-of notice is a fact about this subscription and
 *    goes to everyone it happened to.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function build(options: { readonly toggles?: unknown; readonly rows?: ReadonlyArray<Record<string, unknown>> } = {}) {
  const created: Array<{ type: string }> = [];
  const queries: Array<Record<string, unknown>> = [];
  const rows = options.rows ?? [{ id: 'sub-1', userId: 'user-1', expiresAt: new Date(NOW - 7 * DAY_MS) }];
  const prisma = {
    settings: { findUnique: async () => ({ userNotifications: options.toggles ?? {} }) },
    subscription: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        return rows;
      },
      findUnique: async () => ({ status: SubscriptionStatus.EXPIRED }),
    },
    userNotificationEvent: { findMany: async () => [] },
  };
  const service = new AutoRenewService(
    prisma as never,
    {
      create: async (input: { type: string }) => {
        created.push(input);
      },
    } as never,
    {} as never,
    { findPreferredForCharge: async () => null } as never,
    { build: async () => ({}) } as never,
    { requiresPlanSelection: async () => false } as never,
    { info: () => undefined } as never,
  );
  return { service, created, queries };
}

/** The `user` relation filter of the one subscription query. */
const userFilterOf = (where: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  where?.['user'] as Record<string, unknown> | undefined;

describe('«Возврат покупателя» is off until the operator turns it on', () => {
  for (const type of WINBACK_NOTIFICATION_TYPES) {
    it(`${type}: writes nothing, and asks for no subscription, while the switch was never touched`, async () => {
      const { service, created, queries } = build();
      const count = await service.createExpiredNotices({ daysAgo: 7, notificationType: type, audience: 'paidNotReturned' });
      assert.equal(count, 0);
      assert.deepEqual(created, []);
      assert.deepEqual(queries, []);
    });
  }

  it('writes nothing while switched off', async () => {
    const { service, created } = build({ toggles: { expired_7_days_ago: false } });
    assert.equal(
      await service.createExpiredNotices({ daysAgo: 7, notificationType: 'expired_7_days_ago', audience: 'paidNotReturned' }),
      0,
    );
    assert.deepEqual(created, []);
  });

  it('writes the reminder once switched on', async () => {
    const { service, created } = build({ toggles: { expired_7_days_ago: true } });
    assert.equal(
      await service.createExpiredNotices({ daysAgo: 7, notificationType: 'expired_7_days_ago', audience: 'paidNotReturned' }),
      1,
    );
    assert.equal(created[0]?.type, 'expired_7_days_ago');
  });
});

describe('who a reminder is for', () => {
  it('a reminder: a customer who paid money, is not blocked and has no other live subscription', async () => {
    const { service, queries } = build({ toggles: { expired_14_days_ago: true } });
    await service.createExpiredNotices({ daysAgo: 14, notificationType: 'expired_14_days_ago', audience: 'paidNotReturned' });

    assert.equal(queries[0]?.['status'], SubscriptionStatus.EXPIRED);
    const window = queries[0]?.['expiresAt'] as { gt: Date; lte: Date };
    // Fourteen days back, three hours wide.
    assert.ok(Math.abs(window.lte.getTime() - (NOW - 14 * DAY_MS)) < 60_000);
    assert.equal(window.lte.getTime() - window.gt.getTime(), 3 * 60 * 60 * 1000);
    assert.deepEqual(userFilterOf(queries[0]), {
      subscriptions: {
        none: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED, SubscriptionStatus.DISABLED] } },
      },
      isBlocked: false,
      transactions: { some: { status: TransactionStatus.COMPLETED, amount: { gt: 0 } } },
    });
  });

  it('«закончилась вчера»: not to a customer who came back, paid or not', async () => {
    const { service, queries } = build();
    await service.createExpiredNotices({ daysAgo: 1, notificationType: 'expired_1_day_ago', audience: 'notReturned' });
    assert.deepEqual(userFilterOf(queries[0]), {
      subscriptions: {
        none: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED, SubscriptionStatus.DISABLED] } },
      },
    });
  });

  it('«Подписка закончилась» on the day: to everyone it happened to', async () => {
    const { service, queries } = build();
    await service.createExpiredNotices({ daysAgo: 0, notificationType: 'expired' });
    assert.equal(userFilterOf(queries[0]), undefined);
  });
});

describe('the cycle', () => {
  it('runs each reminder for whom it is meant, on its own day', async () => {
    const { service } = build();
    const calls: Array<Record<string, unknown>> = [];
    const stub = service as unknown as Record<string, unknown>;
    stub['processAutopayCharges'] = async () => ({ attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
    stub['markExpiredSubscriptions'] = async () => 0;
    stub['createExpiryWarnings'] = async () => 0;
    stub['createExpiredNotices'] = async (input: Record<string, unknown>) => {
      calls.push(input);
      return 0;
    };

    const result = await service.runCycle();

    assert.deepEqual(calls, [
      { daysAgo: 0, notificationType: 'expired' },
      { daysAgo: 1, notificationType: 'expired_1_day_ago', audience: 'notReturned' },
      { daysAgo: 3, notificationType: 'expired_3_days_ago', audience: 'paidNotReturned' },
      { daysAgo: 7, notificationType: 'expired_7_days_ago', audience: 'paidNotReturned' },
      { daysAgo: 14, notificationType: 'expired_14_days_ago', audience: 'paidNotReturned' },
    ]);
    assert.deepEqual(result.winBackNotices, { expired_3_days_ago: 0, expired_7_days_ago: 0, expired_14_days_ago: 0 });
  });
});
