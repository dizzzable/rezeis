import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { describe, it } from 'node:test';

import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';

/**
 * WHAT IS ALLOWED TO REPLACE WHAT IN THE NOTIFICATION TRAY.
 *
 * A browser notification carries a `tag`, and two notifications sharing one are
 * ONE notification: the second replaces the first and the first is never read.
 * The cabinet's service worker has to choose a tag for every push. Until now the
 * payload carried no identity at all — `title`, `body`, `url`, and optionally an
 * icon and a badge number — so its only material was the destination plus a
 * digest of the words, and `resolveNotificationPushUrl` maps many types onto six
 * URLs. `/renew` alone serves `expires_in_3_days`, `expires_in_1_days`,
 * `expired`, `expired_1_day_ago` and `limited`.
 *
 * It cost nothing while every push went out with `TTL: 60`: a closed browser
 * could never have more than one message waiting. `PUSH_TTL_SECONDS` became a
 * day in this same session, messages genuinely queue now, and a weekend's worth
 * arrives as one banner.
 *
 * These cases pin the DECISION, not the table. Each one is a pair of
 * notifications and an answer to "should the second one erase the first" — the
 * question a reviewer has to be able to check without reading
 * `PUSH_TAG_FAMILY_BY_TYPE` at all. Driven through `create()` /
 * `sendOperatorMessage()` rather than by reading the table out of the source,
 * because a table nobody hands to `sendToUser` is a decision that never happens
 * — the failure the TTL table beside it was written to prevent.
 */

interface PushCall {
  readonly userId: string;
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly tag?: string;
  readonly type?: string;
  readonly ttlSeconds?: number;
  readonly badgeCount?: number;
}

describe('the collapse key a push carries', () => {
  it('is on the payload at all', async () => {
    // The anti-emptiness anchor. Everything below compares tags to each other,
    // and two `undefined`s are equal — so without this the whole file would go
    // green on a service that sends no tag whatsoever, which is precisely the
    // state being fixed.
    const [push] = await pushesFor([{ type: 'points_cashback_credited', payload: {} }]);
    assert.equal(typeof push.tag, 'string', 'the push carries no tag at all');
    assert.ok((push.tag as string).length > 0, 'the tag is blank, which the cabinet reads as absent');
  });

  it('lets the current state of a deadline replace the last thing said about it', async () => {
    // "Expires in 3 days", "expires tomorrow" and "has ended" are three
    // restatements of ONE fact — where this customer's deadline stands. The
    // customer needs the current state, not a history of it, and three banners
    // for one subscription is the noise that gets notifications switched off.
    //
    // EVERY stage the auto-renew cron emits, not a sample of them: a family
    // with one member missing is a member that quietly stops being superseded,
    // and nothing else in the product would show it.
    const pushes = await pushesFor([
      { type: 'expires_in_3_days', payload: {} },
      { type: 'expires_in_2_days', payload: {} },
      { type: 'expires_in_1_days', payload: {} },
      { type: 'expired', payload: {} },
      { type: 'expired_1_day_ago', payload: {} },
    ]);

    const tags = new Set(pushes.map((push) => push.tag));
    assert.equal(
      tags.size,
      1,
      `the expiry family took ${tags.size} tags: ${[...tags].join(', ')}`,
    );
  });

  it('keeps traffic exhaustion apart from the expiry it shares a page with', async () => {
    // Both deep-link to `/renew`, which is exactly why the URL could never be
    // the key. But "your subscription is about to end" and "your traffic ran
    // out" are different facts about different things, and a customer whose
    // traffic ran out three days before their subscription ends has to read
    // both.
    const [expiring, limited] = await pushesFor([
      { type: 'expires_in_3_days', payload: {} },
      { type: 'limited', payload: {} },
    ]);

    assert.equal(expiring.url, '/renew');
    assert.equal(limited.url, '/renew', 'the two facts still share one destination');
    assert.notEqual(
      expiring.tag,
      limited.tag,
      'traffic exhaustion would erase the expiry warning that arrived before it',
    );
  });

  it('lets a statement about right now replace the last statement about right now', async () => {
    // `limited` is true when sent and false the moment the customer tops up —
    // the same reading of this type that gave it a one-hour TTL rather than the
    // day-long default. A second one is the current state, not a second fact,
    // so it supersedes. Its own family, though: see the case above.
    const pushes = await pushesFor([
      { type: 'limited', payload: {} },
      { type: 'limited', payload: {} },
    ]);

    assert.equal(pushes[0].tag, pushes[1].tag, 'two statements about the same right-now stacked up');
  });

  it('gives two support replies two banners', async () => {
    // Two replies on two different tickets share a type. Collapsing them loses
    // a message the customer was waiting for — the opposite of the expiry
    // family, and the reason this is a per-type decision rather than one rule.
    const pushes = await pushesFor([
      { type: 'support_reply', payload: { ticketId: 't-1' }, preRenderedText: 'Ответ по счёту' },
      { type: 'support_reply', payload: { ticketId: 't-2' }, preRenderedText: 'Ответ по ключу' },
    ]);

    assert.equal(pushes.length, 2);
    assert.notEqual(pushes[0].tag, pushes[1].tag, 'the second reply erased the first');
    assert.ok(
      (pushes[0].tag as string).includes('support_reply'),
      `a tag that does not name its type is unreadable in a log: ${pushes[0].tag}`,
    );
  });

  it('gives two rewards two banners', async () => {
    // Same shape as the support case and worth its own line, because money is
    // where a lost notification is least forgivable: two cashback credits are
    // two credits, not a correction of one.
    const pushes = await pushesFor([
      { type: 'points_cashback_credited', payload: { points: 100 } },
      { type: 'points_cashback_credited', payload: { points: 250 } },
    ]);

    assert.notEqual(pushes[0].tag, pushes[1].tag, 'the second credit erased the first');
  });

  it('reads a legacy alias as the family its modern spelling belongs to', async () => {
    // `subscription_expiring_3d` is what the auto-renew emitter historically
    // fired and what in-flight rows still carry. A table keyed on raw types
    // would miss it, and the miss is silent: the alias would get a
    // per-notification tag and stop being superseded by the warnings that
    // follow it. The same trap `isSubscriberNotificationEnabled` documents.
    const [alias, canonical] = await pushesFor([
      { type: 'subscription_expiring_3d', payload: {} },
      { type: 'expires_in_3_days', payload: {} },
    ]);

    assert.equal(alias.tag, canonical.tag, 'the legacy alias fell out of its own family');
  });

  it('sends a type only where the class is itself a correct collapse key', async () => {
    // The cabinet reads `data.tag` first and `data.type` only as a fallback,
    // and a fallback that is WRONG is worse than none: `type` collapses a whole
    // class onto one banner. That is the answer for the expiry family and it is
    // the defect being fixed for support replies. So the panel sends the field
    // only where it would be right on its own.
    const [expiring, reply] = await pushesFor([
      { type: 'expires_in_3_days', payload: {} },
      { type: 'support_reply', payload: { ticketId: 't-1' }, preRenderedText: 'Ответ' },
    ]);

    assert.equal(expiring.type, 'expires_in_3_days');
    assert.equal(
      reply.type,
      undefined,
      'a `type` here is a fallback that collapses two tickets into one banner',
    );
  });

  it('gives two operator messages two banners', async () => {
    // `sendOperatorMessage` is the other send in this service and it writes its
    // own row before any channel runs — so the id that makes one message
    // distinguishable from the next was already in scope, three lines above the
    // call, and simply was not passed down.
    const state = createState();
    const service = createService(state, {
      user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
    });

    await service.sendOperatorMessage({
      userId: 'user-1',
      text: 'Проверьте, пожалуйста, оплату',
      channels: ['webpush'],
    });
    await service.sendOperatorMessage({
      userId: 'user-1',
      text: 'И ещё одно: подписка продлена',
      channels: ['webpush'],
    });

    const pushes = state.webPushCalls as PushCall[];
    assert.equal(pushes.length, 2, `the operator path sent ${pushes.length} pushes`);
    assert.notEqual(
      pushes[0].tag,
      pushes[1].tag,
      'the operator’s second message erased the first',
    );
  });
});

/**
 * Fan each notification out through the real `create()` path and return the
 * `sendToUser` input each one produced, in order.
 */
async function pushesFor(
  notifications: ReadonlyArray<{
    readonly type: string;
    readonly payload: Record<string, unknown>;
    readonly preRenderedText?: string;
  }>,
): Promise<readonly PushCall[]> {
  const state = createState();
  const service = createService(state, {
    user: { telegramId: 42n, isBotBlocked: false, name: 'Ann' },
    template: { isActive: true, title: 'Заголовок', body: 'Текст.' },
  });

  for (const notification of notifications) {
    await service.create({
      userId: 'user-1',
      type: notification.type,
      payload: notification.payload,
      ...(notification.preRenderedText === undefined
        ? {}
        : { preRenderedText: notification.preRenderedText }),
    });
    await flushFanout();
  }

  assert.equal(
    state.webPushCalls.length,
    notifications.length,
    `expected one push per notification, got ${state.webPushCalls.length}`,
  );
  return state.webPushCalls as PushCall[];
}

function createService(
  state: ReturnType<typeof createState>,
  input: {
    readonly user?: {
      readonly telegramId: bigint | null;
      readonly isBotBlocked: boolean;
      readonly name: string | null;
    } | null;
    readonly template?: {
      readonly isActive: boolean;
      readonly title: string;
      readonly body: string;
    } | null;
  } = {},
): UserNotificationsService {
  let created = 0;
  const prisma = {
    userNotificationEvent: {
      count: async () => 3,
      create: async (args: {
        data: { userId: string; type: string; payload: Record<string, unknown> };
      }) => {
        // A DIFFERENT id per row, which is the whole point of the harness: an
        // id generator that returned a constant would make "two banners"
        // indistinguishable from "one banner" and every distinctness assertion
        // in this file vacuous.
        created += 1;
        return {
          id: `notification-${created}`,
          userId: args.data.userId,
          type: args.data.type,
          payload: args.data.payload,
        };
      },
      update: async (args: { where: { id: string } }) => ({ id: args.where.id }),
    },
    webAccount: { findFirst: async () => null },
    user: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
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
      findUnique: async () => ({ userNotifications: {}, systemNotifications: {} }),
    },
  };
  const templates = {
    getByType: async () => input.template ?? null,
  };
  const botNotifier = {
    notifyUser: async () => undefined,
    notifyBroadcast: async () => undefined,
  };
  const relayQueue = { enqueue: async () => true };
  const webPush = {
    sendToUser: async (call: unknown) => {
      state.webPushCalls.push(call);
      return { attempted: 1, delivered: 1, failed: 0, disabled: false };
    },
    // `sendOperatorMessage` refuses a channel the subscriber cannot receive on
    // before it sends anything, so both of these have to answer truthfully or
    // that path never reaches `sendToUser` and its case passes on an empty
    // array.
    isConfigured: async () => true,
    countSubscriptions: async () => 1,
  };
  const customEmoji = {
    substituteTelegramHtml: async (text: string) => text,
    substituteFallbacks: async (text: string) => text,
  };
  const emailDelivery = {
    getSmtpSettings: async () => ({ enabled: false, notifyUsers: false }),
    send: async () => undefined,
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

function createState() {
  return { webPushCalls: [] as unknown[] };
}

async function flushFanout(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
