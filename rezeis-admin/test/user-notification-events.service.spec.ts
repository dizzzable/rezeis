import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, Prisma, PurchaseChannel, PurchaseType, TransactionStatus } from '@prisma/client';

import { UserNotificationEventsService } from '../src/modules/user-activity/services/user-notification-events.service';

type UserNotificationEventsPrisma = ConstructorParameters<typeof UserNotificationEventsService>[0];
type UserNotificationEventCreateArgs = Parameters<UserNotificationEventsPrisma['userNotificationEvent']['create']>[0];
type UserNotificationEventUpdateArgs = Parameters<UserNotificationEventsPrisma['userNotificationEvent']['update']>[0];
type UserNotificationEventsPrismaDouble = {
  settings: {
    findFirst: () => Promise<{ botMenu: unknown } | null>;
  };
  userNotificationEvent: {
    create: (args: UserNotificationEventCreateArgs) => Promise<UserNotificationEventCreateArgs>;
    update?: (args: UserNotificationEventUpdateArgs) => Promise<unknown>;
  };
};

describe('UserNotificationEventsService', () => {
  it('creates completed payment notifications with rendered text and i18n payload', async () => {
    const createCalls: unknown[] = [];
    const prismaDouble: UserNotificationEventsPrismaDouble = {
      settings: { findFirst: async () => null },
      userNotificationEvent: {
        create: async (args: UserNotificationEventCreateArgs) => {
          createCalls.push(args);
          return args;
        },
      },
    };
    const service = new UserNotificationEventsService(prismaDouble as unknown as UserNotificationEventsPrisma);

    await service.writePaymentCompleted(createTransaction({ status: TransactionStatus.COMPLETED }));

    assert.deepStrictEqual(createCalls, [
      {
        data: {
          userId: 'user-1',
          type: 'PAYMENT_COMPLETED',
          i18nKey: 'user.notifications.payment.completed',
          i18nKwargs: {
            paymentId: 'payment-1',
              amount: '8',
            currency: Currency.USD,
            gatewayType: PaymentGatewayType.YOOKASSA,
            status: TransactionStatus.COMPLETED,
          },
          renderedText: 'Payment of 8 USD completed successfully.',
        },
      },
    ]);
  });

  it('skips disabled notification types from platform notification settings', async () => {
    const createCalls: unknown[] = [];
    const prismaDouble: UserNotificationEventsPrismaDouble = {
      settings: { findFirst: async () => ({ botMenu: { notificationSettings: { PAYMENT_COMPLETED: false } } }) },
      userNotificationEvent: { create: async (args: UserNotificationEventCreateArgs) => { createCalls.push(args); return args; } },
    };
    const service = new UserNotificationEventsService(prismaDouble as unknown as UserNotificationEventsPrisma);

    await service.writePaymentCompleted(createTransaction({ status: TransactionStatus.COMPLETED }));

    assert.equal(createCalls.length, 0);
  });

  it('renders notification text from admin-managed templates', async () => {
    const createCalls: unknown[] = [];
    const prismaDouble: UserNotificationEventsPrismaDouble = {
      settings: { findFirst: async () => ({ botMenu: { notificationTemplates: { PAYMENT_COMPLETED: 'Paid {{amount}} {{currency}} via {{gatewayType}}' } } }) },
      userNotificationEvent: { create: async (args: UserNotificationEventCreateArgs) => { createCalls.push(args); return args; } },
    };
    const service = new UserNotificationEventsService(prismaDouble as unknown as UserNotificationEventsPrisma);

    await service.writePaymentCompleted(createTransaction({ status: TransactionStatus.COMPLETED }));

    assert.equal((createCalls[0] as UserNotificationEventCreateArgs).data.renderedText, 'Paid 8 USD via YOOKASSA');
  });

  it('creates failed payment notifications', async () => {
    const createCalls: unknown[] = [];
    const prismaDouble: UserNotificationEventsPrismaDouble = {
      settings: { findFirst: async () => null },
      userNotificationEvent: {
        create: async (args: UserNotificationEventCreateArgs) => {
          createCalls.push(args);
          return args;
        },
      },
    };
    const service = new UserNotificationEventsService(prismaDouble as unknown as UserNotificationEventsPrisma);

    await service.writePaymentFailed(createTransaction({ status: TransactionStatus.CANCELED }));

    assert.deepStrictEqual(createCalls, [
      {
        data: {
          userId: 'user-1',
          type: 'PAYMENT_FAILED',
          i18nKey: 'user.notifications.payment.failed',
          i18nKwargs: {
            paymentId: 'payment-1',
              amount: '8',
            currency: Currency.USD,
            gatewayType: PaymentGatewayType.YOOKASSA,
            status: TransactionStatus.CANCELED,
          },
          renderedText: 'Payment of 8 USD could not be completed.',
        },
      },
    ]);
  });

  it('enqueues created notification events for bot delivery when queue service is available', async () => {
    const enqueued: string[] = [];
    const prismaDouble: UserNotificationEventsPrismaDouble = {
      settings: { findFirst: async () => null },
      userNotificationEvent: { create: async (args: UserNotificationEventCreateArgs) => ({ ...args, id: 'event-1' } as never) },
    };
    const service = new UserNotificationEventsService(
      prismaDouble as unknown as UserNotificationEventsPrisma,
      { enqueueEvent: async (eventId: string) => { enqueued.push(eventId); } } as never,
    );

    await service.writePaymentCompleted(createTransaction({ status: TransactionStatus.COMPLETED }));

    assert.deepStrictEqual(enqueued, ['event-1']);
  });

  it('marks created notification as failed when delivery enqueue fails', async () => {
    const updates: UserNotificationEventUpdateArgs[] = [];
    const rawQueueFailure = new Error('redis://queue.internal:6379 token=notification-secret event evt_unsafe_payload');
    const prismaDouble: UserNotificationEventsPrismaDouble = {
      settings: { findFirst: async () => null },
      userNotificationEvent: {
        create: async (args: UserNotificationEventCreateArgs) => ({ ...args, id: 'event-1' } as never),
        update: async (args: UserNotificationEventUpdateArgs) => { updates.push(args); return args; },
      },
    };
    const service = new UserNotificationEventsService(
      prismaDouble as unknown as UserNotificationEventsPrisma,
      { enqueueEvent: async () => { throw rawQueueFailure; } } as never,
    );

    await assert.rejects(
      () => service.writePaymentCompleted(createTransaction({ status: TransactionStatus.COMPLETED })),
      rawQueueFailure,
    );

    assert.equal(updates.length, 1);
    assert.deepStrictEqual(updates[0]?.where, { id: 'event-1' });
    assert.equal(updates[0]?.data.botDeliveryStatus, 'FAILED');
    assert.equal(updates[0]?.data.botDeliveryError, 'NOTIFICATION_DELIVERY_ENQUEUE_FAILED');
    assert.ok(updates[0]?.data.botDeliveryAttemptedAt instanceof Date);
    const serializedUpdate = JSON.stringify(updates);
    assert.equal(serializedUpdate.includes('redis://queue.internal'), false);
    assert.equal(serializedUpdate.includes('notification-secret'), false);
    assert.equal(serializedUpdate.includes('evt_unsafe_payload'), false);
  });

  it('preserves original enqueue failure when failure-marker update is unavailable', async () => {
    const rawQueueFailure = new Error('BullMQ enqueue failed with token=raw-secret');
    const prismaDouble: UserNotificationEventsPrismaDouble = {
      settings: { findFirst: async () => null },
      userNotificationEvent: {
        create: async (args: UserNotificationEventCreateArgs) => ({ ...args, id: 'event-1' } as never),
        update: async () => { throw new Error('db marker write failed with password=secret'); },
      },
    };
    const service = new UserNotificationEventsService(
      prismaDouble as unknown as UserNotificationEventsPrisma,
      { enqueueEvent: async () => { throw rawQueueFailure; } } as never,
    );

    await assert.rejects(
      () => service.writePaymentCompleted(createTransaction({ status: TransactionStatus.COMPLETED })),
      rawQueueFailure,
    );
  });
});

function createTransaction(input: { readonly status: TransactionStatus }) {
  return {
    id: 'tx-1',
    paymentId: 'payment-1',
    userId: 'user-1',
    subscriptionId: null,
    status: input.status,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    currency: Currency.USD,
    amount: new Prisma.Decimal('8.00'),
    paymentAsset: null,
    gatewayId: null,
    gatewayData: null,
    planSnapshot: { id: 'plan-1' },
    isTest: false,
    deviceTypes: [],
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}
