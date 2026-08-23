import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

/**
 * Operator sends a message to ONE user from the Users page, and chooses where
 * it goes.
 *
 * These drive the REAL route (`AdminUserManagementController.sendNotification`
 * / `.getNotifyChannels`) through the REAL `UserNotificationsService`, and
 * assert what each channel was actually ASKED TO DO — the relay metadata that
 * went on the queue, the web-push call that was or was not made — rather than
 * that a dispatcher method exists.
 *
 * What they are guarding against is specific and was the shipped behaviour:
 * the route took no channel parameter, wrote the feed row, fired the fanout
 * through `void this.fanout(...)` so nothing was awaited, and returned a
 * literal `{ sent: true }`. Every failure below — relay down, no browser
 * subscribed, no Telegram account linked — reached the operator as a green
 * "Notification sent" toast.
 */

const USER = {
  id: 'user-1',
  telegramId: BigInt(12345),
  isBotBlocked: false,
};

describe('AdminUserManagementController notify channels', () => {
  it('sends only on the channels the operator selected', async () => {
    const harness = createHarness();
    const controller = createController(harness);

    await controller.sendNotification('12345', { message: 'Telegram only', channels: ['telegram'] });

    // The Telegram leg went out with the operator's text...
    assert.deepStrictEqual(harness.state.relayCalls, [
      {
        event: 'reiwa.user.notify',
        metadata: {
          eventId: 'event-1',
          telegramId: '12345',
          text: 'Telegram only',
          parseMode: 'HTML',
        },
      },
    ]);
    // ...and web-push was not asked for anything. This is the assertion the
    // old route could not pass in either direction: it always did both.
    assert.deepStrictEqual(harness.state.webPushSends, []);
  });

  it('sends only web-push when that is the single channel selected', async () => {
    const harness = createHarness();
    const controller = createController(harness);

    await controller.sendNotification('12345', { message: 'Push only', channels: ['webpush'] });

    assert.deepStrictEqual(harness.state.relayCalls, []);
    assert.deepStrictEqual(harness.state.webPushSends, [
      { userId: 'user-1', title: 'Reiwa', body: 'Push only', url: '/dashboard' },
    ]);
  });

  it('writes the durable feed row even when the operator selects no channel', async () => {
    const harness = createHarness();
    const controller = createController(harness);

    const result = await controller.sendNotification('12345', {
      message: 'Recorded quietly',
      channels: [],
    });

    // The record is the point: "feed only" is a supported operator choice and
    // must not be expressible as "nothing happened".
    assert.deepStrictEqual(harness.state.eventCreates, [
      {
        data: { userId: 'user-1', type: 'ADMIN_MESSAGE', payload: { text: 'Recorded quietly' } },
        select: { id: true },
      },
    ]);
    assert.deepStrictEqual(harness.state.relayCalls, []);
    assert.deepStrictEqual(harness.state.webPushSends, []);
    assert.deepStrictEqual(
      result.outcomes.map((o) => [o.channel, o.status]),
      [
        ['telegram', 'notSelected'],
        ['webpush', 'notSelected'],
      ],
    );
    // Nothing was asked for, so nothing failed. `sent` must not read as a
    // delivery claim here, but it must also not read as an error.
    assert.equal(result.sent, true);
  });

  it('reports a Telegram relay that did not accept the message as a failure', async () => {
    // `enqueue` returns false when the relay is unconfigured, or Redis was
    // unreachable AND the single direct fallback attempt also failed. Both mean
    // the subscriber was not told.
    const harness = createHarness({ relayAccepts: false });
    const controller = createController(harness);

    const result = await controller.sendNotification('12345', {
      message: 'Does not arrive',
      channels: ['telegram'],
    });

    const telegram = result.outcomes.find((o) => o.channel === 'telegram');
    assert.equal(telegram?.status, 'failed');
    assert.equal(telegram?.reason, 'relayUnavailable');
    // THE assertion. The shipped route returned `{ sent: true }` unconditionally
    // and the SPA toasted success off it, so a dead relay was indistinguishable
    // from a delivered message.
    assert.equal(result.sent, false);
  });

  it('reports a push that every browser rejected as a failure, not a send', async () => {
    const harness = createHarness({ webPushResult: { attempted: 2, delivered: 0, failed: 2, disabled: false } });
    const controller = createController(harness);

    const result = await controller.sendNotification('12345', {
      message: 'Rejected everywhere',
      channels: ['webpush'],
    });

    const webpush = result.outcomes.find((o) => o.channel === 'webpush');
    assert.equal(webpush?.status, 'failed');
    assert.equal(webpush?.reason, 'pushRejected');
    assert.equal(webpush?.attempted, 2);
    assert.equal(webpush?.delivered, 0);
    assert.equal(result.sent, false);
  });

  it('reports a genuinely delivered send as delivered', async () => {
    // Anti-vacuity control. Every assertion above is about a failure being
    // reported; without this one, a change that reported EVERYTHING as failed
    // would pass the whole file.
    const harness = createHarness({
      webPushResult: { attempted: 2, delivered: 2, failed: 0, disabled: false },
    });
    const controller = createController(harness);

    const result = await controller.sendNotification('12345', {
      message: 'Arrives',
      channels: ['telegram', 'webpush'],
    });

    assert.deepStrictEqual(
      result.outcomes.map((o) => [o.channel, o.status, o.reason]),
      [
        ['telegram', 'delivered', null],
        ['webpush', 'delivered', null],
      ],
    );
    assert.equal(result.sent, true);
    assert.equal(harness.state.relayCalls.length, 1);
    assert.equal(harness.state.webPushSends.length, 1);
  });

  it('refuses to deliver on a channel the user cannot receive on, and says why', async () => {
    const harness = createHarness({
      user: { ...USER, telegramId: null },
      subscriptionCount: 0,
    });
    const controller = createController(harness);

    const result = await controller.sendNotification('12345', {
      message: 'Nowhere to go',
      channels: ['telegram', 'webpush'],
    });

    assert.deepStrictEqual(
      result.outcomes.map((o) => [o.channel, o.status, o.reason]),
      [
        ['telegram', 'unavailable', 'noTelegramId'],
        ['webpush', 'unavailable', 'noSubscription'],
      ],
    );
    // Nothing was attempted — an unavailable channel must not be "tried and
    // silently dropped", which is how a no-op reads as a success.
    assert.deepStrictEqual(harness.state.relayCalls, []);
    assert.deepStrictEqual(harness.state.webPushSends, []);
    assert.equal(result.sent, false);
  });

  it('treats an omitted channels field as every channel, so an older SPA build still delivers', async () => {
    const harness = createHarness({
      webPushResult: { attempted: 1, delivered: 1, failed: 0, disabled: false },
    });
    const controller = createController(harness);

    // No `channels` key at all — the request the pre-selector build posts.
    const result = await controller.sendNotification('12345', { message: 'Legacy body' });

    assert.equal(harness.state.relayCalls.length, 1);
    assert.equal(harness.state.webPushSends.length, 1);
    assert.equal(result.sent, true);
  });
});

describe('AdminUserManagementController notify channel availability', () => {
  it('offers Telegram and web-push when the user can receive on both', async () => {
    // Anti-vacuity control for this suite: without it, an availability rule
    // that answered "unavailable" to everything would satisfy the four cases
    // below.
    const harness = createHarness();
    const controller = createController(harness);

    assert.deepStrictEqual((await controller.getNotifyChannels('12345')).channels, [
      { channel: 'telegram', available: true, reason: null },
      { channel: 'webpush', available: true, reason: null },
    ]);
  });

  it('marks Telegram unavailable for a user with no linked account', async () => {
    const harness = createHarness({ user: { ...USER, telegramId: null } });
    const controller = createController(harness);

    const channels = (await controller.getNotifyChannels('12345')).channels;
    assert.deepStrictEqual(channels.find((c) => c.channel === 'telegram'), {
      channel: 'telegram',
      available: false,
      reason: 'noTelegramId',
    });
  });

  it('marks Telegram unavailable for a non-positive telegramId', async () => {
    // A zero or negative id is a dirty import, not a chat the bot can reach:
    // the bot's `/notify` answers 400 for it, which is why `fanout` gates on
    // `telegramId > 0n` rather than merely on the column being set. An
    // availability rule that only checked for `null` would offer Telegram here
    // and the operator would watch the send report success and never arrive —
    // and a `null` fixture alone cannot tell the two rules apart.
    //
    // BOTH values, and `0n` is the one that earns its place: it is the boundary
    // the `> 0n` guard is written around, so a rule that slipped to `>= 0n`
    // still rejects every negative fixture and only `0n` reports the change.
    for (const telegramId of [BigInt(0), BigInt(-100123)]) {
      const harness = createHarness({ user: { ...USER, telegramId } });
      const controller = createController(harness);

      const channels = (await controller.getNotifyChannels('12345')).channels;
      assert.deepStrictEqual(
        channels.find((c) => c.channel === 'telegram'),
        { channel: 'telegram', available: false, reason: 'noTelegramId' },
        `telegramId ${telegramId} must not be offered as a Telegram channel`,
      );

      // And the send path agrees with the answer — nothing is enqueued.
      const result = await controller.sendNotification('12345', {
        message: 'Unreachable',
        channels: ['telegram'],
      });
      assert.equal(result.outcomes.find((o) => o.channel === 'telegram')?.status, 'unavailable');
      assert.deepStrictEqual(harness.state.relayCalls, []);
      assert.equal(result.sent, false);
    }
  });

  it('marks Telegram unavailable for a user who blocked the bot', async () => {
    const harness = createHarness({ user: { ...USER, isBotBlocked: true } });
    const controller = createController(harness);

    const channels = (await controller.getNotifyChannels('12345')).channels;
    assert.deepStrictEqual(channels.find((c) => c.channel === 'telegram'), {
      channel: 'telegram',
      available: false,
      reason: 'botBlocked',
    });
  });

  it('separates "push is not configured" from "this user has no browser"', async () => {
    // Two different answers on purpose: one is an operator action in
    // Settings → Web-push, the other is not fixable by the operator at all.
    const unconfigured = createController(createHarness({ pushConfigured: false }));
    assert.deepStrictEqual(
      (await unconfigured.getNotifyChannels('12345')).channels.find((c) => c.channel === 'webpush'),
      { channel: 'webpush', available: false, reason: 'pushNotConfigured' },
    );

    const noBrowser = createController(createHarness({ subscriptionCount: 0 }));
    assert.deepStrictEqual(
      (await noBrowser.getNotifyChannels('12345')).channels.find((c) => c.channel === 'webpush'),
      { channel: 'webpush', available: false, reason: 'noSubscription' },
    );
  });
});

// ── Harness ─────────────────────────────────────────────────────────────────

interface HarnessOptions {
  readonly user?: { id: string; telegramId: bigint | null; isBotBlocked: boolean } | null;
  readonly relayAccepts?: boolean;
  readonly pushConfigured?: boolean;
  readonly subscriptionCount?: number;
  readonly webPushResult?: {
    attempted: number;
    delivered: number;
    failed: number;
    disabled: boolean;
  };
}

function createHarness(options: HarnessOptions = {}) {
  const user = options.user === undefined ? USER : options.user;
  const relayAccepts = options.relayAccepts ?? true;
  const pushConfigured = options.pushConfigured ?? true;
  const subscriptionCount = options.subscriptionCount ?? 1;
  const webPushResult =
    options.webPushResult ?? { attempted: 1, delivered: 1, failed: 0, disabled: false };

  const state = {
    eventCreates: [] as unknown[],
    relayCalls: [] as { event: string; metadata: Record<string, unknown> }[],
    webPushSends: [] as unknown[],
  };

  const prisma = {
    user: {
      // The controller resolves the route param to a row, then the service
      // reads the same user for its availability gate.
      findFirst: async () => user,
      findUnique: async () => user,
    },
    userNotificationEvent: {
      create: async (args: unknown) => {
        state.eventCreates.push(args);
        return { id: 'event-1' };
      },
    },
    settings: {
      // Operator mirror is off, so `mirrorToOperatorChat` is a no-op and the
      // relay calls recorded above are only the user-facing Telegram leg.
      findUnique: async () => ({ systemNotifications: {} }),
    },
  };

  const relayQueue = {
    enqueue: async (event: string, metadata: Record<string, unknown>) => {
      state.relayCalls.push({ event, metadata });
      return relayAccepts;
    },
  };

  const webPush = {
    isConfigured: async () => pushConfigured,
    countSubscriptions: async () => subscriptionCount,
    sendToUser: async (input: unknown) => {
      state.webPushSends.push(input);
      return webPushResult;
    },
  };

  const notifications = new UserNotificationsService(
    prisma as never,
    { findActiveByType: async () => null } as never,
    { notifyUser: async () => undefined } as never,
    webPush as never,
    {
      substituteTelegramHtml: async (text: string) => text,
      substituteFallbacks: async (text: string) => text,
    } as never,
    relayQueue as never,
  );

  return { state, prisma, notifications };
}

function createController(harness: ReturnType<typeof createHarness>) {
  return new AdminUserManagementController(
    harness.prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    harness.notifications,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // PlansAdminService
  );
}
