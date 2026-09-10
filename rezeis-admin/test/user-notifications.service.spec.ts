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
      // `badgeCount` is the unread total the icon draws — it rides on every
      // templated push, so a closed app still learns the number.
      {
        userId: 'user-1',
        title: 'Reiwa',
        body: 'Manual message',
        url: '/dashboard',
        // Identity, so an operator's second message cannot erase the first in
        // the tray. No `type` alongside it: the class alone is not a safe
        // collapse key for a message somebody typed by hand.
        tag: 'ADMIN_MESSAGE:notification-1',
        badgeCount: 3,
      },
    ]);
    // The Telegram leg went to the durable queue, not to the one-shot client.
    // Asserting the payload alone would pass either way — both stubs record
    // into `notifyUserCalls` on purpose, so only these two lines tell them
    // apart.
    assert.deepStrictEqual(state.relayEvents, ['reiwa.user.notify']);
    assert.deepStrictEqual(state.directNotifierCalls, []);
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
        // The five expiry stages are one fact retold, so they share a family
        // key and the newest one replaces the rest in the tray.
        tag: 'subscription-deadline',
        type: 'expires_in_3_days',
        badgeCount: 3,
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
      {
        userId: 'user-1',
        title: 'Title',
        body: 'Body',
        url: '/dashboard',
        tag: 'custom:notification-1',
        badgeCount: 3,
      },
    ]);
  });
});

/**
 * What the cabinet feed has to print.
 *
 * The row is written first, so the feed shows it immediately; the template is
 * rendered later, inside the fanout, for Telegram and web-push. Nothing ever
 * carried that result back — so a feed row held whatever its emitter happened
 * to pass, and eight types pass bare identifiers and nothing else. «Трафик
 * исчерпан», «начислен кэшбэк» and «партнёру выплачено» all opened as
 * "Текст уведомления недоступен".
 *
 * The cabinet reads `payload.title` and `payload.text`, so this is also the
 * fix that needs no cabinet release to take effect.
 */
describe('the rendered copy reaches the feed row', () => {
  it('writes the template title and body onto the row', async () => {
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: { isActive: true, title: 'Трафик исчерпан', body: 'Лимит израсходован.' },
    });

    await service.create({ userId: 'user-1', type: 'limited', payload: { subscriptionId: 's-1' } });
    await flushFanout();

    assert.equal(state.updateCalls.length, 1);
    const payload = state.updateCalls[0].data.payload as Record<string, unknown>;
    assert.equal(payload.title, 'Трафик исчерпан');
    assert.equal(payload.text, 'Лимит израсходован.');
    assert.equal(payload.subscriptionId, 's-1', 'the emitter payload must survive');
  });

  it('does not overwrite copy the emitter already wrote', async () => {
    // `support_reply` stores a subject-bearing body on purpose, and it knows
    // more about its own message than a re-render does.
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: { isActive: true, title: 'Шаблон', body: 'Из шаблона.' },
    });

    await service.create({
      userId: 'user-1',
      type: 'limited',
      payload: { title: 'Своё', text: 'Свой текст' },
    });
    await flushFanout();

    assert.equal(state.updateCalls.length, 0);
  });

  it('fills only the half that is missing', async () => {
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: { isActive: true, title: 'Шаблон', body: 'Из шаблона.' },
    });

    await service.create({ userId: 'user-1', type: 'limited', payload: { title: 'Своё' } });
    await flushFanout();

    const payload = state.updateCalls[0].data.payload as Record<string, unknown>;
    assert.equal(payload.title, 'Своё');
    assert.equal(payload.text, 'Из шаблона.');
  });

  it('writes nothing for a preRenderedText send', async () => {
    // Those callers own their payload copy, and their body is Telegram HTML —
    // storing it in a field the feed prints trades a blank card for tags.
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: { isActive: true, title: 'Шаблон', body: 'Из шаблона.' },
    });

    await service.create({
      userId: 'user-1',
      type: 'support_reply',
      payload: { ticketId: 't-1' },
      preRenderedText: '<b>Поддержка ответила</b>',
    });
    await flushFanout();

    assert.equal(state.updateCalls.length, 0);
  });

  it('writes nothing when no template matches', async () => {
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: null,
    });

    await service.create({ userId: 'user-1', type: 'unknown_type', payload: {} });
    await flushFanout();

    assert.equal(state.updateCalls.length, 0);
  });
});

function createService(
  state: ReturnType<typeof createState>,
  input: {
    readonly user?: {
      readonly telegramId: bigint | null;
      readonly isBotBlocked: boolean;
      readonly name: string | null;
      /** The subscriber's own switches; absent means "everything on". */
      readonly notificationPrefs?: Record<string, boolean> | null;
    } | null;
    readonly template?: { readonly isActive: boolean; readonly title: string; readonly body: string } | null;
    /** SMTP config the email leg reads. Absent means the leg is not wired. */
    readonly smtp?: { readonly enabled: boolean; readonly notifyUsers: boolean } | null;
    /** An address on file, or `null` for none. */
    readonly verifiedEmail?: string | null;
    /** Whether that address is verified. Default true. */
    readonly emailVerified?: boolean;
  } = {},
): UserNotificationsService {
  const prisma = {
    userNotificationEvent: {
      // The unread total the push carries for the home-screen icon badge.
      // Fixed: what these cases assert is which channels fire and with what
      // text, and the count is neither.
      count: async () => 3,
      create: async (args: NotificationCreateArgs) => {
        state.createCalls.push(args);
        return {
          id: 'notification-1',
          userId: args.data.userId,
          type: args.data.type,
          payload: args.data.payload,
        };
      },
      // The rendered copy is written back onto the row so the cabinet feed
      // has something to print. A double without this method turns that
      // write into a caught-and-logged failure — green tests over a feature
      // that never ran.
      update: async (args: { where: { id: string }; data: { payload: unknown } }) => {
        state.updateCalls.push(args);
        return { id: args.where.id };
      },
    },
    webAccount: {
      // The double HONOURS the `where`, and that is the point: the
      // verification gate IS a where clause, so a stub that ignores it makes
      // "mails only verified addresses" untestable while reading as covered.
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        if (input.verifiedEmail === undefined || input.verifiedEmail === null) return null;
        const demandsVerified = args?.where?.emailVerifiedAt !== undefined;
        if (demandsVerified && input.emailVerified === false) return null;
        return { email: input.verifiedEmail };
      },
    },
    user: {
      // Honours `select`, like the `webAccount` double below. The fanout's
      // subscriber gate reads `notificationPrefs` off this row; drop the field
      // from the `select` and the column is simply absent, every subscriber
      // reads as having chosen nothing, and all five switches stop working
      // without a single error anywhere.
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        state.userFindCalls.push(args);
        if (input.user === undefined || input.user === null) return null;
        const select = args.select ?? {};
        const row: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input.user)) {
          if (select[key] === true) row[key] = value;
        }
        return row;
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
  // The direct relay client. After the durable-queue change nothing in this
  // service may reach it: a call here is a call that gets one attempt and
  // drops the outcome, which is the defect this replaced. Recorded rather than
  // thrown from, so a regression reports "used the direct client" instead of
  // an unhandled rejection the fanout's own catch would swallow.
  const botNotifier = {
    notifyUser: async (call: unknown) => {
      state.directNotifierCalls.push({ method: 'notifyUser', call });
    },
    notifyBroadcast: async (call: unknown) => {
      state.directNotifierCalls.push({ method: 'notifyBroadcast', call });
    },
  };
  const relayQueue = {
    enqueue: async (event: string, metadata: Record<string, unknown>) => {
      state.relayEvents.push(event);
      if (event === 'reiwa.user.notify') state.notifyUserCalls.push(metadata);
      else if (event === 'reiwa.channel.broadcast') state.notifyBroadcastCalls.push(metadata);
      return true;
    },
  };
  const webPush = {
    sendToUser: async (call: unknown) => {
      state.webPushCalls.push(call);
    },
  };
  // Custom-emoji pack substitution: passthrough stub. The helpers no-op for
  // token-less text in production too, so the rendered strings stay identical
  // to the pre-emoji-pack behaviour these assertions encode.
  const customEmoji = {
    substituteTelegramHtml: async (text: string) => text,
    substituteFallbacks: async (text: string) => text,
  };
  // The email leg is `@Optional()` at the tail, so the two positional slots
  // before it have to be filled to reach it. A double that omits the service
  // entirely turns the leg into a silent no-op — green tests over a channel
  // that never runs, which is the failure this file has hit before.
  const emailDelivery = {
    getSmtpSettings: async () => input.smtp ?? { enabled: false, notifyUsers: false },
    send: async (payload: Record<string, unknown>) => {
      state.emailCalls.push(payload);
    },
  };
  return new UserNotificationsService(
    prisma as never,
    templates as never,
    botNotifier as never,
    webPush as never,
    customEmoji as never,
    relayQueue as never,
    undefined,
    undefined,
    emailDelivery as never,
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
    emailCalls: [] as Array<Record<string, unknown>>,
    updateCalls: [] as Array<{ where: { id: string }; data: { payload: unknown } }>,
    settingsFindCalls: [] as unknown[],
    userFindCalls: [] as unknown[],
    templateLookups: [] as string[],
    notifyUserCalls: [] as unknown[],
    notifyBroadcastCalls: [] as unknown[],
    relayEvents: [] as string[],
    directNotifierCalls: [] as unknown[],
    webPushCalls: [] as unknown[],
  };
}

async function flushFanout(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * The subscriber's own switches, honoured at last.
 *
 * The cabinet's «Уведомления» screen shipped seven of them with no handler,
 * no route and no column: they stayed where you put them until the page
 * unmounted and changed nothing. What follows is the send-side half — the
 * half that makes the screen mean something.
 *
 * Two properties are load-bearing and pull against each other:
 *
 *  1. a muted type must not PUSH — no Telegram, no web-push;
 *  2. the cabinet feed row must be written anyway. The switch says "stop
 *     pushing this at me", not "hide it from me", and somebody who opens the
 *     app should still find out their subscription ended. Exactly the
 *     semantics the operator's own toggle already has.
 */
describe('a subscriber who switched a reminder off', () => {
  it('gets no Telegram and no web-push for that type', async () => {
    const state = createState({});
    const service = createService(state, {
      user: {
        telegramId: 42n,
        isBotBlocked: false,
        name: 'Ann',
        notificationPrefs: { expires_in_3_days: false },
      },
      template: { isActive: true, title: 'Через 3 дня', body: 'Скоро истекает.' },
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.deepStrictEqual(state.notifyUserCalls, []);
    assert.deepStrictEqual(state.webPushCalls, []);
  });

  it('still gets the row in the cabinet feed', async () => {
    // THE counterweight. An opt-out that also hid the notification would let
    // somebody switch off "your subscription ended" and then have no way to
    // learn that it did.
    const state = createState({});
    const service = createService(state, {
      user: {
        telegramId: 42n,
        isBotBlocked: false,
        name: 'Ann',
        notificationPrefs: { expired: false },
      },
      template: { isActive: true, title: 'Закончилась', body: 'Подписка закончилась.' },
    });

    await service.create({ userId: 'user-1', type: 'expired', payload: {} });
    await flushFanout();

    assert.equal(state.createCalls.length, 1);
    assert.equal(state.createCalls[0].data.type, 'expired');
  });

  it('keeps receiving every type they did not switch off', async () => {
    const state = createState({});
    const service = createService(state, {
      user: {
        telegramId: 42n,
        isBotBlocked: false,
        name: 'Ann',
        notificationPrefs: { expires_in_3_days: false },
      },
      template: { isActive: true, title: 'Завтра', body: 'Истекает завтра.' },
    });

    await service.create({ userId: 'user-1', type: 'expires_in_1_days', payload: {} });
    await flushFanout();

    assert.equal(state.notifyUserCalls.length, 1);
  });

  it('cannot silence a support reply', async () => {
    // Not in the mutable list, and it must never be: an opt-out there lets a
    // customer switch off the answer to their own question.
    const state = createState({});
    const service = createService(state, {
      user: {
        telegramId: 42n,
        isBotBlocked: false,
        name: 'Ann',
        notificationPrefs: { support_reply: false } as Record<string, boolean>,
      },
      template: { isActive: true, title: 'Поддержка', body: 'Ответ.' },
    });

    await service.create({ userId: 'user-1', type: 'support_reply', payload: {} });
    await flushFanout();

    assert.equal(state.notifyUserCalls.length, 1);
  });

  it('sends everything to a subscriber who never opened the screen', async () => {
    // The column is nullable and nearly every row has it null. Reading that
    // as "opted out of everything" would silence the entire customer base.
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann', notificationPrefs: null },
      template: { isActive: true, title: 'Через 3 дня', body: 'Скоро истекает.' },
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.equal(state.notifyUserCalls.length, 1);
  });
});

/**
 * Email as a third channel — and the four gates in front of it.
 *
 * The module's own docstring used to promise "a per-channel email bridge
 * reads the same rows on its own schedule". No such schedule existed, and
 * email appeared in neither the channel list nor the fanout: the cabinet told
 * customers their notifications could arrive by mail, and none ever did.
 *
 * Turning it on is not a code decision. Most addresses on file were given for
 * signing in, and their owners never asked to hear from the product in their
 * inbox — so the operator's switch is off until somebody sets it, and three
 * further gates decide the rest.
 */
describe('the email leg', () => {
  const SMTP_ON = { enabled: true, notifyUsers: true };
  const TEMPLATE = { isActive: true, title: 'Через 3 дня', body: 'Скоро истекает.' };

  it('sends to a verified address once the operator asked for it', async () => {
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: 'ann@example.com',
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.equal(state.emailCalls.length, 1);
    assert.equal(state.emailCalls[0].to, 'ann@example.com');
    assert.equal(state.emailCalls[0].subject, 'Через 3 дня');
  });

  it('sends nothing while the operator switch is off', async () => {
    // THE default. An install that upgrades into this feature has no stored
    // value, and a missing value must never mean "start mailing customers".
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: { enabled: true, notifyUsers: false },
      verifiedEmail: 'ann@example.com',
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.deepStrictEqual(state.emailCalls, []);
  });

  it('sends nothing when SMTP itself is off', async () => {
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: { enabled: false, notifyUsers: true },
      verifiedEmail: 'ann@example.com',
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.deepStrictEqual(state.emailCalls, []);
  });

  it('will not mail an address nobody verified', async () => {
    // An unverified address belongs to whoever typed it, which is not
    // necessarily the customer.
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: null,
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.deepStrictEqual(state.emailCalls, []);
  });

  it('will not mail an address that is on file but unverified', async () => {
    // THE gate. An address somebody typed and never confirmed may belong to
    // anyone; mailing a customer's subscription state to it is the one
    // mistake here that cannot be taken back.
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: 'stranger@example.com',
      emailVerified: false,
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.deepStrictEqual(state.emailCalls, []);
  });

  it('stays out of a broadcast, which mails on its own', async () => {
    // Broadcasts arrive here with `preRenderedText` and carry an email leg of
    // their own. A second one here means every recipient gets the letter
    // twice.
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: 'ann@example.com',
    });

    await service.create({
      userId: 'user-1',
      type: 'broadcast',
      payload: { broadcastId: 'b-1' },
      preRenderedText: '<b>Объявление</b>',
    });
    await flushFanout();

    assert.deepStrictEqual(state.emailCalls, []);
  });

  it('honours the subscriber who switched that reminder off', async () => {
    const state = createState({});
    const service = createService(state, {
      user: {
        telegramId: 42n,
        isBotBlocked: false,
        name: 'Ann',
        notificationPrefs: { expires_in_3_days: false },
      },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: 'ann@example.com',
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.deepStrictEqual(state.emailCalls, []);
  });

  it('keys the letter on the notification so a retry cannot double it', async () => {
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: 'ann@example.com',
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.equal(state.emailCalls[0].dedupeKey, 'notify:notification-1');
  });

  it('carries a plain-text part alongside the HTML', async () => {
    // A message with no text alternative scores worse with spam filters, and
    // a reader whose client refuses HTML would receive nothing at all.
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: 'ann@example.com',
    });

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.equal(typeof state.emailCalls[0].rawHtml, 'string');
    assert.equal(state.emailCalls[0].text, 'Скоро истекает.');
  });

  it('does not take down the Telegram send when mail fails', async () => {
    const state = createState({});
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
      template: TEMPLATE,
      smtp: SMTP_ON,
      verifiedEmail: 'ann@example.com',
    });
    // Break the mailer after construction.
    (service as unknown as { emailDelivery: { send: () => Promise<void> } }).emailDelivery.send =
      async () => {
        throw new Error('smtp down');
      };

    await service.create({ userId: 'user-1', type: 'expires_in_3_days', payload: {} });
    await flushFanout();

    assert.equal(state.notifyUserCalls.length, 1);
  });
});
