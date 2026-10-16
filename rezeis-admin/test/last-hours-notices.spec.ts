import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { AutoRenewService, expiryWarningWindow } from '../src/modules/auto-renew/auto-renew.service';
import {
  LAST_HOURS_NOTIFICATION_TYPES,
  isNotificationDeliveryEnabled,
  subscriberSwitchesOffered,
} from '../src/modules/notifications/utils/notification-toggle.util';

/**
 * The last hours (the owner, 17.10.2026): reminders 3 hours and 1 hour before a
 * subscription ends — extra ones, «захочет владелец включит, не захочет не
 * будут работать». Three rules:
 *
 *  - OFF until the operator turns each on, and while off nothing is written —
 *    not even the cabinet's feed row.
 *  - Each one's window ends where the next one's begins: «за 3 часа» covers 3 h
 *    down to 1 h before the end, «за 1 час» the last hour. Nobody with forty
 *    minutes left is told «через 3 часа».
 *  - The subscriber's switch for each shows only once the operator turned it on.
 */

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();

function build(options: { readonly toggles?: unknown; readonly expiresInMs?: number } = {}) {
  const created: Array<{ type: string }> = [];
  const queries: Array<Record<string, unknown>> = [];
  const expiresAt = new Date(NOW + (options.expiresInMs ?? 2 * HOUR_MS));
  const prisma = {
    settings: { findUnique: async () => ({ userNotifications: options.toggles ?? {} }) },
    subscription: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        return [{ id: 'sub-1', userId: 'user-1', expiresAt }];
      },
      findUnique: async () => ({ status: SubscriptionStatus.ACTIVE, expiresAt }),
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

describe('the last-hours reminders are off until the operator turns them on', () => {
  for (const type of LAST_HOURS_NOTIFICATION_TYPES) {
    it(`${type}: writes nothing, and asks for no subscription, while the switch was never touched`, async () => {
      const { service, created, queries } = build();
      assert.equal(await service.createExpiryWarnings({ hoursAhead: 3, notificationType: type }), 0);
      assert.deepEqual(created, []);
      assert.deepEqual(queries, []);
      assert.equal(isNotificationDeliveryEnabled({}, type), false);
    });
  }

  it('writes nothing while switched off', async () => {
    const { service, created } = build({ toggles: { expires_in_3_hours: false } });
    assert.equal(await service.createExpiryWarnings({ hoursAhead: 3, notificationType: 'expires_in_3_hours' }), 0);
    assert.deepEqual(created, []);
  });

  it('writes the reminder once switched on', async () => {
    const { service, created } = build({ toggles: { expires_in_3_hours: true } });
    assert.equal(await service.createExpiryWarnings({ hoursAhead: 3, notificationType: 'expires_in_3_hours' }), 1);
    assert.equal(created[0]?.type, 'expires_in_3_hours');
  });

  it('leaves the day warnings as they were: on unless switched off', async () => {
    const { service, created } = build({ expiresInMs: 23 * HOUR_MS });
    assert.equal(await service.createExpiryWarnings({ daysAhead: 1, notificationType: 'expires_in_1_days' }), 1);
    assert.equal(created[0]?.type, 'expires_in_1_days');
  });
});

describe('where each reminder looks', () => {
  it('«за 3 часа»: from 3 hours down to 1 hour before the end', async () => {
    const { service, queries } = build({ toggles: { expires_in_3_hours: true } });
    await service.createExpiryWarnings({ hoursAhead: 3, notificationType: 'expires_in_3_hours' });
    const window = queries[0]?.['expiresAt'] as { gt: Date; lt: Date };
    assert.ok(Math.abs(window.lt.getTime() - (NOW + 3 * HOUR_MS)) < 60_000);
    assert.equal(window.lt.getTime() - window.gt.getTime(), 2 * HOUR_MS);
    assert.equal(queries[0]?.['status'], SubscriptionStatus.ACTIVE);
  });

  it('«за 1 час»: the last hour', async () => {
    const { service, queries } = build({ toggles: { expires_in_1_hour: true }, expiresInMs: 40 * 60 * 1000 });
    await service.createExpiryWarnings({ hoursAhead: 1, notificationType: 'expires_in_1_hour' });
    const window = queries[0]?.['expiresAt'] as { gt: Date; lt: Date };
    assert.ok(Math.abs(window.lt.getTime() - (NOW + HOUR_MS)) < 60_000);
    assert.equal(window.lt.getTime() - window.gt.getTime(), HOUR_MS);
  });

  it('the two windows meet without a gap or an overlap', () => {
    const three = expiryWarningWindow({ hoursAhead: 3 });
    const one = expiryWarningWindow({ hoursAhead: 1 });
    assert.equal(three.leadMs - three.windowMs, one.leadMs);
    assert.equal(one.leadMs - one.windowMs, 0);
  });

  it('the day warnings keep their three-hour window', () => {
    assert.deepEqual(expiryWarningWindow({ daysAhead: 3 }), { leadMs: 72 * HOUR_MS, windowMs: 3 * HOUR_MS });
  });

  it('does not tell a subscription renewed meanwhile that it is about to end', async () => {
    const { service, created } = build({ toggles: { expires_in_1_hour: true }, expiresInMs: 30 * 60 * 1000 });
    const stub = service as unknown as { prismaService: { subscription: { findUnique: () => Promise<unknown> } } };
    stub.prismaService.subscription.findUnique = async () => ({
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date(NOW + 30 * 24 * HOUR_MS),
    });
    assert.equal(await service.createExpiryWarnings({ hoursAhead: 1, notificationType: 'expires_in_1_hour' }), 0);
    assert.deepEqual(created, []);
  });
});

describe('the cycle and the subscriber', () => {
  it('runs both reminders, each with its own hours', async () => {
    const { service } = build();
    const calls: Array<Record<string, unknown>> = [];
    const stub = service as unknown as Record<string, unknown>;
    stub['processAutopayCharges'] = async () => ({ attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
    stub['markExpiredSubscriptions'] = async () => 0;
    stub['createExpiredNotices'] = async () => 0;
    stub['createExpiryWarnings'] = async (input: Record<string, unknown>) => {
      calls.push(input);
      return 0;
    };

    const result = await service.runCycle();

    assert.deepEqual(
      calls.filter((call) => call['hoursAhead'] !== undefined),
      [
        { hoursAhead: 3, notificationType: 'expires_in_3_hours' },
        { hoursAhead: 1, notificationType: 'expires_in_1_hour' },
      ],
    );
    assert.deepEqual(result.lastHoursNotices, { expires_in_3_hours: 0, expires_in_1_hour: 0 });
  });

  it('offers the subscriber a switch only for a reminder the operator turned on', () => {
    assert.equal(subscriberSwitchesOffered({}).includes('expires_in_3_hours'), false);
    const offered = subscriberSwitchesOffered({ expires_in_1_hour: true });
    assert.equal(offered.includes('expires_in_1_hour'), true);
    assert.equal(offered.includes('expires_in_3_hours'), false);
  });
});
