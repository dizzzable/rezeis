import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { describe, it } from 'node:test';

import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';

type NotificationCreateArgs = {
  readonly data: {
    readonly userId: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
  };
  readonly select: Record<string, true>;
};

describe('UserNotificationsService', () => {
  it('persists a notification and fans out pre-rendered operator text', async () => {
    const state = createState();
    const service = createService(state, {
      user: { telegramId: BigInt(12345), isBotBlocked: false, name: 'Nina' },
    });

    const id = await service.create({
      userId: 'user-1',
      type: 'ADMIN_MESSAGE',
      payload: { source: 'admin' },
      preRenderedText: 'Manual message',
    });
    await flushFanout();

    assert.equal(id, 'notification-1');
    assert.deepStrictEqual(state.createCalls, [
      {
        data: {
          userId: 'user-1',
          type: 'ADMIN_MESSAGE',
          payload: { source: 'admin' },
        },
        select: { id: true, userId: true, type: true, payload: true },
      },
    ]);
    assert.deepStrictEqual(state.notifyUserCalls, [
      {
        eventId: 'notification-1',
        telegramId: '12345',
        text: 'Manual message',
        parseMode: 'HTML',
        buttons: undefined,
        bannerUrl: undefined,
      },
    ]);
    assert.deepStrictEqual(state.webPushCalls, [
      { userId: 'user-1', title: 'Reiwa', body: 'Manual message', url: '/dashboard' },
    ]);
  });

  it('honours operator user-notification toggles while keeping the feed row', async () => {
    const state = createState({ userNotifications: { expires_in_3_days: false } });
    const service = createService(state, {
      user: { telegramId: BigInt(12345), isBotBlocked: false, name: 'Nina' },
    });

    await service.create({
      userId: 'user-1',
      type: 'subscription_expiring_3d',
      payload: { days: 3 },
    });
    await flushFanout();

    assert.equal(state.createCalls.length, 1);
    assert.deepStrictEqual(state.userFindCalls, []);
    assert.deepStrictEqual(state.notifyUserCalls, []);
    assert.deepStrictEqual(state.webPushCalls, []);
  });

  it('renders active templates through Telegram and web-push channels', async () => {
    const state = createState();
    const service = createService(state, {
      user: { telegramId: BigInt(12345), isBotBlocked: false, name: 'Nina' },
      template: {
        isActive: true,
        title: 'Expires soon',
        body: 'Hello {{name}}, {{days}} day(s) left',
      },
    });

    await service.create({
      userId: 'user-1',
      type: 'subscription_expiring_3d',
      payload: { days: 3 },
    });
    await flushFanout();

    assert.deepStrictEqual(state.templateLookups, ['expires_in_3_days']);
    assert.deepStrictEqual(state.notifyUserCalls, [
      {
        eventId: 'notification-1',
        telegramId: '12345',
        text: '<b>Expires soon</b>\n\nHello Nina, 3 day(s) left',
        parseMode: 'HTML',
        buttons: undefined,
        bannerUrl: undefined,
      },
    ]);
    assert.deepStrictEqual(state.webPushCalls, [
      {
        userId: 'user-1',
        title: 'Expires soon',
        body: 'Hello Nina, 3 day(s) left',
        url: '/renew',
      },
    ]);
  });

  it('skips Telegram fanout for blocked bot users but still sends web-push', async () => {
    const state = createState();
    const service = createService(state, {
      user: { telegramId: BigInt(12345), isBotBlocked: true, name: 'Nina' },
      template: { isActive: true, title: 'Title', body: 'Body' },
    });

    await service.create({ userId: 'user-1', type: 'custom', payload: {} });
    await flushFanout();

    assert.deepStrictEqual(state.notifyUserCalls, []);
    assert.deepStrictEqual(state.webPushCalls, [
      { userId: 'user-1', title: 'Title', body: 'Body', url: '/dashboard' },
    ]);
  });
});

function createService(
  state: ReturnType<typeof createState>,
  input: {
    readonly user?: { readonly telegramId: bigint | null; readonly isBotBlocked: boolean; readonly name: string | null } | null;
    readonly template?: { readonly isActive: boolean; readonly title: string; readonly body: string } | null;
  } = {},
): UserNotificationsService {
  const prisma = {
    userNotificationEvent: {
      create: async (args: NotificationCreateArgs) => {
        state.createCalls.push(args);
        return {
          id: 'notification-1',
          userId: args.data.userId,
          type: args.data.type,
          payload: args.data.payload,
        };
      },
    },
    user: {
      findUnique: async (args: unknown) => {
        state.userFindCalls.push(args);
        return input.user ?? null;
      },
    },
    settings: {
      findUnique: async (args: unknown) => {
        state.settingsFindCalls.push(args);
        return {
          userNotifications: state.userNotifications,
          systemNotifications: state.systemNotifications,
        };
      },
    },
  };
  const templates = {
    getByType: async (type: string) => {
      state.templateLookups.push(type);
      return input.template ?? null;
    },
  };
  const botNotifier = {
    notifyUser: async (call: unknown) => {
      state.notifyUserCalls.push(call);
    },
    notifyBroadcast: async (call: unknown) => {
      state.notifyBroadcastCalls.push(call);
    },
  };
  const webPush = {
    sendToUser: async (call: unknown) => {
      state.webPushCalls.push(call);
    },
  };
  return new UserNotificationsService(
    prisma as never,
    templates as never,
    botNotifier as never,
    webPush as never,
  );
}

function createState(input: {
  readonly userNotifications?: Record<string, unknown>;
  readonly systemNotifications?: Record<string, unknown>;
} = {}) {
  return {
    userNotifications: input.userNotifications ?? {},
    systemNotifications: input.systemNotifications ?? {},
    createCalls: [] as NotificationCreateArgs[],
    settingsFindCalls: [] as unknown[],
    userFindCalls: [] as unknown[],
    templateLookups: [] as string[],
    notifyUserCalls: [] as unknown[],
    notifyBroadcastCalls: [] as unknown[],
    webPushCalls: [] as unknown[],
  };
}

async function flushFanout(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
