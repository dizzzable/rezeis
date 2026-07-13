import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';

/**
 * Stub the SettingsService + AccessModeGuard dependencies the constructor
 * gained for the access-mode gate. These tests only exercise the activity
 * feed, which never hits the gate path.
 */
const STUB_SETTINGS_SERVICE = {
  getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' as const }),
};
const STUB_ACCESS_MODE_GUARD = { evaluate: () => null };

function buildService(prisma: unknown): InternalUserEdgeService {
  return new InternalUserEdgeService(
    prisma as never,
    STUB_SETTINGS_SERVICE as never,
    STUB_ACCESS_MODE_GUARD as never,
    { info: () => undefined } as never,
  );
}

describe('InternalUserEdgeService activity feed', () => {
  it('lists recent notifications for the resolved Telegram user', async () => {
    const state = createState({ userId: 'user-1' });
    const service = buildService(createPrismaDouble(state));

    const result = await service.listNotifications('12345');

    assert.deepStrictEqual(state.userFindCalls, [{ where: { telegramId: BigInt(12345) }, select: { id: true } }]);
    assert.deepStrictEqual(state.notificationFindManyCalls, [
      { where: { userId: 'user-1' }, orderBy: { createdAt: 'desc' }, take: 50 },
    ]);
    assert.deepStrictEqual(result, {
      notifications: [
        {
          id: 'notification-1',
          type: 'PAYMENT_COMPLETED',
          payload: { paymentId: 'payment-1' },
          readAt: null,
          createdAt: '2026-04-20T00:00:00.000Z',
        },
      ],
    });
  });

  it('returns unread counts and marks all unread notifications read', async () => {
    const state = createState({ userId: 'user-1', unreadCount: 7, updateManyCount: 3 });
    const service = buildService(createPrismaDouble(state));

    assert.deepStrictEqual(await service.getUnreadCount('cmphfcr6i007v01jg0lcu653h'), { unread: 7 });
    const readAll = await service.markAllRead('cmphfcr6i007v01jg0lcu653h');

    assert.deepStrictEqual(readAll, { updated: 3 });
    assert.deepStrictEqual(state.notificationCountCalls, [
      { where: { userId: 'user-1', readAt: null } },
    ]);
    assert.equal(state.notificationUpdateManyCalls.length, 1);
    assert.deepStrictEqual(state.notificationUpdateManyCalls[0]?.where, {
      userId: 'user-1',
      readAt: null,
    });
    assert.ok(state.notificationUpdateManyCalls[0]?.data.readAt instanceof Date);
  });

  it('marks one notification read only when it belongs to the resolved user', async () => {
    const state = createState({ userId: 'user-1' });
    const service = buildService(createPrismaDouble(state));

    assert.deepStrictEqual(await service.markOneRead('12345', 'notification-1'), { ok: true });

    assert.deepStrictEqual(state.notificationFindUniqueCalls, [
      { where: { id: 'notification-1' }, select: { id: true, userId: true } },
    ]);
    assert.equal(state.notificationUpdateCalls.length, 1);
    assert.deepStrictEqual(state.notificationUpdateCalls[0]?.where, { id: 'notification-1' });
    assert.ok(state.notificationUpdateCalls[0]?.data.readAt instanceof Date);
  });

  it('rejects attempts to mark another user notification as read', async () => {
    const state = createState({ userId: 'user-1', notificationOwnerId: 'other-user' });
    const service = buildService(createPrismaDouble(state));

    await assert.rejects(
      () => service.markOneRead('12345', 'notification-1'),
      /Notification not found/,
    );
    assert.deepStrictEqual(state.notificationUpdateCalls, []);
  });

  it('lists recent transactions for the resolved user', async () => {
    const state = createState({ userId: 'user-1' });
    const service = buildService(createPrismaDouble(state));

    const result = await service.listTransactions('12345');

    assert.deepStrictEqual(state.transactionFindManyCalls, [
      { where: { userId: 'user-1' }, orderBy: { createdAt: 'desc' }, take: 50 },
    ]);
    assert.deepStrictEqual(result, {
      transactions: [
        {
          id: 'tx-1',
          paymentId: 'payment-1',
          status: TransactionStatus.COMPLETED,
          purchaseType: PurchaseType.NEW,
          channel: PurchaseChannel.WEB,
          gatewayType: PaymentGatewayType.YOOKASSA,
          currency: Currency.USD,
          amount: '8.00',
          title: 'Plan X',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z',
        },
      ],
    });
  });

  it('lists the user add-on entitlement history (own subscriptions only)', async () => {
    const state = createState({ userId: 'user-1' });
    const service = buildService(createPrismaDouble(state));

    const result = await service.listAddOnEntitlements('12345');

    assert.deepStrictEqual(state.subscriptionFindManyCalls, [
      { where: { userId: 'user-1' }, select: { id: true } },
    ]);
    assert.deepStrictEqual(state.entitlementFindManyCalls, [
      { where: { subscriptionId: { in: ['sub-1'] } }, orderBy: { purchasedAt: 'desc' }, take: 100 },
    ]);
    assert.deepStrictEqual(result, {
      entitlements: [
        {
          id: 'ent-1',
          subscriptionId: 'sub-1',
          receiptName: 'Extra 50GB',
          type: 'EXTRA_TRAFFIC',
          valuePerUnit: 50,
          quantity: 1,
          lifetime: 'UNTIL_SUBSCRIPTION_END',
          state: 'ACTIVE',
          currency: Currency.USD,
          totalAmount: '2.50',
          purchasedAt: '2026-04-20T00:00:00.000Z',
          activatedAt: '2026-04-20T00:00:00.000Z',
          expiresAt: null,
        },
      ],
    });
  });
});

function createPrismaDouble(state: ReturnType<typeof createState>) {
  return {
    user: {
      findUnique: async (args: unknown) => {
        state.userFindCalls.push(args);
        return state.userId === null ? null : { id: state.userId };
      },
    },
    userNotificationEvent: {
      findMany: async (args: unknown) => {
        state.notificationFindManyCalls.push(args);
        return [
          {
            id: 'notification-1',
            type: 'PAYMENT_COMPLETED',
            payload: { paymentId: 'payment-1' },
            readAt: null,
            createdAt: new Date('2026-04-20T00:00:00.000Z'),
          },
        ];
      },
      count: async (args: unknown) => {
        state.notificationCountCalls.push(args);
        return state.unreadCount;
      },
      updateMany: async (args: { readonly where: unknown; readonly data: { readonly readAt: Date } }) => {
        state.notificationUpdateManyCalls.push(args);
        return { count: state.updateManyCount };
      },
      findUnique: async (args: unknown) => {
        state.notificationFindUniqueCalls.push(args);
        return { id: 'notification-1', userId: state.notificationOwnerId };
      },
      update: async (args: { readonly where: unknown; readonly data: { readonly readAt: Date } }) => {
        state.notificationUpdateCalls.push(args);
        return { id: 'notification-1' };
      },
    },
    transaction: {
      findMany: async (args: unknown) => {
        state.transactionFindManyCalls.push(args);
        return [createTransaction()];
      },
    },
    subscription: {
      findMany: async (args: unknown) => {
        state.subscriptionFindManyCalls.push(args);
        return [{ id: 'sub-1' }];
      },
    },
    addOnEntitlement: {
      findMany: async (args: unknown) => {
        state.entitlementFindManyCalls.push(args);
        return [createEntitlement()];
      },
    },
  };
}

function createState(input: {
  readonly userId?: string | null;
  readonly notificationOwnerId?: string;
  readonly unreadCount?: number;
  readonly updateManyCount?: number;
} = {}) {
  return {
    userId: input.userId ?? 'user-1',
    notificationOwnerId: input.notificationOwnerId ?? input.userId ?? 'user-1',
    unreadCount: input.unreadCount ?? 0,
    updateManyCount: input.updateManyCount ?? 0,
    userFindCalls: [] as unknown[],
    notificationFindManyCalls: [] as unknown[],
    notificationCountCalls: [] as unknown[],
    notificationUpdateManyCalls: [] as Array<{ readonly where: unknown; readonly data: { readonly readAt: Date } }>,
    notificationFindUniqueCalls: [] as unknown[],
    notificationUpdateCalls: [] as Array<{ readonly where: unknown; readonly data: { readonly readAt: Date } }>,
    transactionFindManyCalls: [] as unknown[],
    subscriptionFindManyCalls: [] as unknown[],
    entitlementFindManyCalls: [] as unknown[],
  };
}

function createEntitlement() {
  return {
    id: 'ent-1',
    subscriptionId: 'sub-1',
    receiptName: 'Extra 50GB',
    type: 'EXTRA_TRAFFIC',
    valuePerUnit: 50,
    quantity: 1,
    lifetime: 'UNTIL_SUBSCRIPTION_END',
    state: 'ACTIVE',
    currency: Currency.USD,
    totalAmount: { toString: (): string => '2.50' },
    purchasedAt: new Date('2026-04-20T00:00:00.000Z'),
    activatedAt: new Date('2026-04-20T00:00:00.000Z'),
    expiresAt: null,
  };
}

function createTransaction() {
  return {
    id: 'tx-1',
    paymentId: 'payment-1',
    status: TransactionStatus.COMPLETED,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    currency: Currency.USD,
    amount: { toString: (): string => '8.00' },
    planSnapshot: { name: 'Plan X' },
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}
