import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserNotificationsService } from '../src/modules/user-activity/services/user-notifications.service';

type UserNotificationsPrisma = ConstructorParameters<typeof UserNotificationsService>[0];
type UserNotificationEventCountArgs = Parameters<UserNotificationsPrisma['userNotificationEvent']['count']>[0];
type UserNotificationEventFindManyArgs = Parameters<UserNotificationsPrisma['userNotificationEvent']['findMany']>[0];
type UserNotificationEventUpdateManyArgs = Parameters<UserNotificationsPrisma['userNotificationEvent']['updateMany']>[0];
type UserNotificationEventUpdateManyResult = Awaited<ReturnType<UserNotificationsPrisma['userNotificationEvent']['updateMany']>>;
type UserNotificationRecord = {
  id: string;
  userId: string;
  type: string;
  i18nKey: string | null;
  i18nKwargs: unknown;
  renderedText: string | null;
  isRead: boolean;
  readAt: Date | null;
  readSource: string | null;
  botChatId: string | null;
  botMessageId: string | null;
  createdAt: Date;
};
type UserNotificationsPrismaDouble = {
  userNotificationEvent: {
    count: (args: UserNotificationEventCountArgs) => Promise<number>;
    findMany: (args: UserNotificationEventFindManyArgs) => Promise<UserNotificationRecord[]>;
    updateMany: (args: UserNotificationEventUpdateManyArgs) => Promise<UserNotificationEventUpdateManyResult>;
  };
};

describe('UserNotificationsService', () => {
  it('lists paginated notifications and maps rendered text', async () => {
    const state = { countArgs: [] as unknown[], findManyArgs: [] as unknown[] };
    const prismaDouble: UserNotificationsPrismaDouble = {
      userNotificationEvent: {
        count: async (args: UserNotificationEventCountArgs) => {
          state.countArgs.push(args);
          return 1;
        },
        findMany: async (args: UserNotificationEventFindManyArgs) => {
          state.findManyArgs.push(args);
          return [createNotification({ id: 'notification-1', isRead: false, renderedText: 'Payment completed' })];
        },
        updateMany: async (): Promise<UserNotificationEventUpdateManyResult> => ({ count: 0 }),
      },
    };
    const service = new UserNotificationsService(prismaDouble as unknown as UserNotificationsPrisma);

    const result = await service.listNotifications({
      userId: 'user-1',
      isRead: false,
      type: 'PAYMENT_COMPLETED',
      page: 2,
      limit: 5,
    });

    assert.deepStrictEqual(result, {
      items: [
        {
          id: 'notification-1',
          userId: 'user-1',
          type: 'PAYMENT_COMPLETED',
          title: null,
          message: 'Payment completed',
          isRead: false,
          readAt: null,
          readSource: null,
          createdAt: '2026-04-20T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 2,
      limit: 5,
    });
    assert.deepStrictEqual(state.countArgs, [
      {
        where: {
          userId: 'user-1',
          isRead: false,
          type: 'PAYMENT_COMPLETED',
        },
      },
    ]);
    assert.deepStrictEqual(state.findManyArgs, [
      {
        where: {
          userId: 'user-1',
          isRead: false,
          type: 'PAYMENT_COMPLETED',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 5,
        take: 5,
      },
    ]);
  });

  it('returns unread counts', async () => {
    const prismaDouble: UserNotificationsPrismaDouble = {
      userNotificationEvent: {
        count: async (args: UserNotificationEventCountArgs) => {
          assert.deepStrictEqual(args, { where: { userId: 'user-1', isRead: false } });
          return 7;
        },
        findMany: async (_args: UserNotificationEventFindManyArgs) => [],
        updateMany: async (_args: UserNotificationEventUpdateManyArgs): Promise<UserNotificationEventUpdateManyResult> => ({ count: 0 }),
      },
    };
    const service = new UserNotificationsService(prismaDouble as unknown as UserNotificationsPrisma);

    assert.deepStrictEqual(await service.getUnreadCount({ userId: 'user-1' }), { unread: 7 });
  });

  it('marks a single notification as read with the supplied source', async () => {
    const updateManyCalls: UserNotificationEventUpdateManyArgs[] = [];
    const prismaDouble: UserNotificationsPrismaDouble = {
      userNotificationEvent: {
        count: async (_args: UserNotificationEventCountArgs) => 0,
        findMany: async (_args: UserNotificationEventFindManyArgs) => [],
        updateMany: async (args: UserNotificationEventUpdateManyArgs): Promise<UserNotificationEventUpdateManyResult> => {
          updateManyCalls.push(args);
          return { count: 1 };
        },
      },
    };
    const service = new UserNotificationsService(prismaDouble as unknown as UserNotificationsPrisma);

    const result = await service.markNotificationRead({
      notificationId: 'notification-1',
      userId: 'user-1',
      readSource: 'MANUAL',
    });

    assert.deepStrictEqual(result, { updated: 1 });
    assert.equal(updateManyCalls.length, 1);
    assert.deepStrictEqual(updateManyCalls[0], {
      where: {
        id: 'notification-1',
        userId: 'user-1',
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: updateManyCalls[0].data?.readAt,
        readSource: 'MANUAL',
      },
    });
    assert.ok(updateManyCalls[0].data?.readAt instanceof Date);
  });

  it('marks all notifications as read with the default source', async () => {
    const updateManyCalls: UserNotificationEventUpdateManyArgs[] = [];
    const prismaDouble: UserNotificationsPrismaDouble = {
      userNotificationEvent: {
        count: async (_args: UserNotificationEventCountArgs) => 0,
        findMany: async (_args: UserNotificationEventFindManyArgs) => [],
        updateMany: async (args: UserNotificationEventUpdateManyArgs): Promise<UserNotificationEventUpdateManyResult> => {
          updateManyCalls.push(args);
          return { count: 3 };
        },
      },
    };
    const service = new UserNotificationsService(prismaDouble as unknown as UserNotificationsPrisma);

    const result = await service.markAllNotificationsRead({ userId: 'user-1' });

    assert.deepStrictEqual(result, { updated: 3 });
    assert.equal(updateManyCalls.length, 1);
    assert.deepStrictEqual(updateManyCalls[0], {
      where: {
        userId: 'user-1',
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: updateManyCalls[0].data?.readAt,
        readSource: 'INTERNAL_ADMIN',
      },
    });
    assert.ok(updateManyCalls[0].data?.readAt instanceof Date);
  });
});

function createNotification(input: {
  readonly id: string;
  readonly isRead: boolean;
  readonly renderedText: string | null;
}) {
  return {
    id: input.id,
    userId: 'user-1',
    type: 'PAYMENT_COMPLETED',
    i18nKey: null,
    i18nKwargs: null,
    renderedText: input.renderedText,
    isRead: input.isRead,
    readAt: null,
    readSource: null,
    botChatId: null,
    botMessageId: null,
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}
