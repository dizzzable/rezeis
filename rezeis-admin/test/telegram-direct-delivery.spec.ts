import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { of } from 'rxjs';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { readAdminBotToken } from '../src/common/utils/admin-bot-token.util';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { TelegramDirectQueueService } from '../src/modules/notifications/services/telegram-direct-queue.service';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { describeFetchFailure } from '../src/modules/notifications/services/telegram-direct.client';
import {
  TELEGRAM_FLOOD_WAIT_CEILING_SECONDS,
  isTelegramDirectLoopGuardedEvent,
  resolveTelegramDirectBackoff,
  type TelegramDirectJobData,
} from '../src/modules/notifications/telegram-direct.constants';
import {
  classifyTelegramResponse,
  isRetryableTelegramOutcome,
} from '../src/modules/notifications/telegram-direct.outcome';

/**
 * The panel sends its own operator cards
 * ══════════════════════════════════════
 * Until this change every operator-facing card left rezeis through the reiwa
 * bot, and it looked like an architectural choice. It was not one:
 * `SystemEventsService` looked for its bot token at
 * `systemNotifications.telegram.botToken`, a PLAINTEXT key that no write path
 * in the tree has ever produced, so its "do I have a token?" test answered no
 * on every deployment — including the ones with a token sitting in Settings →
 * Bot Token — and every card took the split-deployment fallback.
 *
 * These tests pin three separate things, and they fail for three different
 * reasons on purpose:
 *
 *  1. WHERE the token comes from. If someone restores the plaintext read as a
 *     "legacy fallback", the second test here fails — and it must, because
 *     `maskSystemNotifications` drops secrets by top-level key and `telegram`
 *     is not one of them, so a token at that path is served to the browser in
 *     the clear on every settings fetch.
 *  2. WHICH road a card takes. Token present → the panel's own queue and the
 *     reiwa relay untouched; token absent → the relay, exactly as before.
 *     Counting deliveries cannot tell those apart, so the stubs record the
 *     road.
 *  3. WHAT DID NOT MOVE. Subscriber notifications stay on the bot. That is the
 *     half of the split with no visible symptom if it silently breaks — a
 *     subscriber who stops receiving messages does not file a ticket against
 *     the panel — so it is asserted rather than assumed.
 */

const CRYPT_KEY = 'test-crypt-key-for-bot-token';
const STORED_TOKEN = '7000000000:AAH-panel-owned-token';

interface Roads {
  /** Relay events handed to the reiwa queue, in order. */
  relay: string[];
  /** Jobs handed to the panel's own Telegram queue, in order. */
  direct: TelegramDirectJobData[];
  /** Relay events sent down the one-shot bot client, in order. */
  relayDirect: string[];
  /** Bot API calls made inline by `SystemEventsService` itself. */
  inline: number;
}

function buildService(opts: {
  readonly telegram: Record<string, unknown>;
  readonly storeToken?: boolean;
  readonly directQueueRegistered?: boolean;
}): { service: SystemEventsService; roads: Roads } {
  const roads: Roads = { relay: [], direct: [], relayDirect: [], inline: 0 };

  const notifier = {
    deliverRelayEvent: async (event: string) => {
      roads.relayDirect.push(event);
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string) => {
      roads.relay.push(event);
      return true;
    },
  };
  const directQueue = {
    enqueue: async (data: TelegramDirectJobData) => {
      roads.direct.push(data);
      return true;
    },
  };

  const systemNotifications: Record<string, unknown> = { telegram: opts.telegram };
  if (opts.storeToken !== false) {
    systemNotifications.botTokenEnc = encryptTotpSecret(STORED_TOKEN, CRYPT_KEY);
  }

  const prisma = {
    settings: { findFirst: async () => ({ systemNotifications }) },
    adminAuditLog: { create: async () => ({}) },
  };

  const httpService = {
    // `of(...)`, not a resolved promise: the caller wraps this in
    // `firstValueFrom`. A plain object counts the call and then throws
    // `source.subscribe is not a function` inside the try — which the test
    // would still pass, having proved the call happened and nothing about
    // what happened next.
    post: () => {
      roads.inline += 1;
      return of({ data: { ok: true } });
    },
  };

  const moduleRef = {
    get: (token: unknown) => {
      if (token === BotNotifierClient) return notifier;
      if (token === ReiwaRelayQueueService) return relayQueue;
      if (token === TelegramDirectQueueService) {
        if (opts.directQueueRegistered === false) throw new Error('not registered');
        return directQueue;
      }
      throw new Error('not registered');
    },
  };

  const service = new SystemEventsService(
    prisma as never,
    { enabled: false, urls: [] } as never,
    httpService as never,
    moduleRef as never,
    { cryptKey: CRYPT_KEY } as never,
  );
  return { service, roads };
}

/** An operator group is configured, so the card has somewhere direct to go. */
const GROUP: Record<string, unknown> = {
  enabled: true,
  chatId: '-1002000000000',
  topicId: 42,
  errorReports: { mode: 'manual', telegramTxt: false },
};

/** Let the fire-and-forget delivery microtasks settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('where the panel looks for its own bot token', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('finds the token the Bot Token card actually stores', () => {
    const stored = { botTokenEnc: encryptTotpSecret(STORED_TOKEN, CRYPT_KEY) };
    assert.equal(readAdminBotToken(stored, CRYPT_KEY), STORED_TOKEN);
  });

  it('does NOT read the plaintext key that nothing writes and masking would leak', () => {
    // The exact shape `loadTelegramConfig` used to accept. It has to come back
    // null: `maskSystemNotifications` drops `email`, `botTokenEnc` and
    // `webPush` by top-level key, so a token parked under `telegram` rides out
    // to the SPA on every settings fetch. Reading it would make that a
    // supported place to put one.
    const legacy = { telegram: { botToken: '7000000000:AAH-plaintext' } };
    assert.equal(readAdminBotToken(legacy, CRYPT_KEY), null);
  });

  it('treats a token it cannot decrypt as absent rather than throwing', () => {
    const stored = { botTokenEnc: encryptTotpSecret(STORED_TOKEN, CRYPT_KEY) };
    assert.equal(readAdminBotToken(stored, 'a-different-key'), null);
    assert.equal(readAdminBotToken({ botTokenEnc: 'not-even-ciphertext' }, CRYPT_KEY), null);
  });

  it('returns nothing when there is no crypt key to decrypt with', () => {
    const stored = { botTokenEnc: encryptTotpSecret(STORED_TOKEN, CRYPT_KEY) };
    assert.equal(readAdminBotToken(stored, ''), null);
    assert.equal(readAdminBotToken(stored, undefined), null);
  });
});

describe('which road an operator card takes', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('goes out on the panel’s own queue when the panel holds a token', async () => {
    const { service, roads } = buildService({ telegram: GROUP });

    service.info('payment.completed', 'PAYMENT', 'Платёж получен', { amount: 100 });
    await flush();

    assert.equal(roads.direct.length, 1);
    assert.equal(roads.direct[0]?.kind, 'message');
    assert.equal(roads.direct[0]?.chatId, '-1002000000000');
    assert.equal(roads.direct[0]?.topicId, 42);
    assert.equal(roads.direct[0]?.sourceEventType, 'payment.completed');
    assert.ok(roads.direct[0]?.text.includes('#EventPaymentCompleted'));
    // The whole point: the bot is not involved at all.
    assert.deepStrictEqual(roads.relay, []);
    assert.deepStrictEqual(roads.relayDirect, []);
  });

  it('still goes through the reiwa bot when the panel holds no token', async () => {
    const { service, roads } = buildService({ telegram: GROUP, storeToken: false });

    service.info('payment.completed', 'PAYMENT', 'Платёж получен', { amount: 100 });
    await flush();

    // Unchanged split-deployment behaviour — this is the case the relay exists
    // for, and it must survive the change that made the other case direct.
    assert.deepStrictEqual(roads.relay, ['reiwa.channel.broadcast']);
    assert.deepStrictEqual(roads.direct, []);
  });

  it('sends the error report as its own job, not as a caption', async () => {
    const { service, roads } = buildService({
      telegram: { ...GROUP, errorReports: { mode: 'manual', telegramTxt: true } },
    });

    service.error('system.error', 'SYSTEM', 'boom', { stack: 'at x' });
    await flush();

    assert.equal(roads.direct.length, 2);
    assert.equal(roads.direct[0]?.kind, 'message');
    assert.equal(roads.direct[1]?.kind, 'document');
    // Same two messages this path has always produced with a token: the card,
    // then the .txt behind it. The relay collapses them into one captioned
    // document because the cabinet's route takes one call — a property of that
    // transport, not of the card.
    assert.equal(roads.direct[1]?.text, '');
    assert.ok(roads.direct[1]?.filename?.startsWith('error_'));
    assert.ok((roads.direct[1]?.content ?? '').length > 0);
  });

  it('falls back to one inline send when the queue module is not registered', async () => {
    const { service, roads } = buildService({ telegram: GROUP, directQueueRegistered: false });

    service.info('payment.completed', 'PAYMENT', 'Платёж получен', {});
    await flush();

    // Strictly what this path did before it was durable — a worker runtime
    // without the module must not silently lose the card.
    assert.equal(roads.inline, 1);
    assert.deepStrictEqual(roads.direct, []);
  });

  it('sends the settings test card inline, because a human is waiting on it', async () => {
    const { service, roads } = buildService({ telegram: GROUP });

    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: 'проверка',
      adminId: 'admin-1',
    });

    assert.equal(result.via, 'primary');
    // Queuing it would answer "sent" before anything was, and a wrong token
    // would surface a minute later in the event feed instead of under the
    // button the operator just pressed.
    assert.equal(roads.inline, 1);
    assert.deepStrictEqual(roads.direct, []);
  });

  it('never puts the alert about a failed send back on the queue that failed', async () => {
    const { service, roads } = buildService({ telegram: GROUP });

    service.warn('telegram.direct_undelivered', 'SYSTEM', 'Панель не доставила карточку', {
      telegramStatus: 'unauthorized',
    });
    await flush();

    // Queue it and the failure feeds itself: exhausted job → alert → new job →
    // exhausted, for as long as Telegram refuses. One inline attempt instead;
    // the event is already in AdminAuditLog and on the realtime socket.
    assert.deepStrictEqual(roads.direct, []);
    assert.equal(roads.inline, 1);
    assert.equal(isTelegramDirectLoopGuardedEvent('telegram.direct_undelivered'), true);
    // And it guards only that one — a real event must not be swept up by it.
    assert.equal(isTelegramDirectLoopGuardedEvent('payment.completed'), false);
    assert.equal(isTelegramDirectLoopGuardedEvent('reiwa.relay_undelivered'), false);
  });
});

describe('what stayed with the bot', () => {
  it('leaves subscriber notifications on the relay, where the delivery state lives', async () => {
    // `reiwa.user.notify` is the one event on the relay that is a message to a
    // SUBSCRIBER. The panel cannot send it: it does not know who has started
    // the bot, does not hold the per-recipient bookkeeping, and must not be
    // the thing that discovers a blocked bot. Nothing in the direct path may
    // ever learn to carry it.
    const { RELAY_EVENT_POLICY } = await import('../src/modules/notifications/reiwa-relay.policy');
    assert.equal(RELAY_EVENT_POLICY['reiwa.user.notify']?.durability, 'durable');

    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/common/services/system-events.service.ts', 'utf8'),
    );
    // A canary, and worth naming as one: it catches the specific edit that
    // would cross the split here — teaching the panel's own event pipeline to
    // address a subscriber — and nothing more. It cannot prove the capability
    // was not added somewhere else, and it is not trying to.
    assert.equal(
      source.includes("'reiwa.user.notify'"),
      false,
      'the panel event pipeline must not learn to address subscribers directly',
    );
  });
});

describe('reading Telegram’s answer', () => {
  it('calls a 200 with ok:true delivered', () => {
    const outcome = classifyTelegramResponse({ httpStatus: 200, body: { ok: true, result: {} } });
    assert.equal(outcome.status, 'sent');
  });

  it('does NOT call a 200 with ok:false delivered', () => {
    // The one direction that must not slip: a failure reported as a success is
    // a card nobody will ever look for again.
    const outcome = classifyTelegramResponse({
      httpStatus: 200,
      body: { ok: false, description: 'Bad Request: chat not found' },
    });
    assert.notEqual(outcome.status, 'sent');
    assert.equal(outcome.detail, 'Bad Request: chat not found');
  });

  it('reads a flood-wait as a flood-wait, not as a rejection', () => {
    const outcome = classifyTelegramResponse({
      httpStatus: 429,
      body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 42 } },
    });
    assert.equal(outcome.status, 'flood_wait');
    assert.equal(outcome.retryAfterSeconds, 42);
    assert.equal(isRetryableTelegramOutcome(outcome, TELEGRAM_FLOOD_WAIT_CEILING_SECONDS), true);
  });

  it('stops waiting when the flood-wait outlasts the ceiling', () => {
    const outcome = classifyTelegramResponse({
      httpStatus: 429,
      body: {
        ok: false,
        parameters: { retry_after: TELEGRAM_FLOOD_WAIT_CEILING_SECONDS + 1 },
      },
    });
    // An alert delivered an hour late is a log entry. Past the ceiling the
    // operator is better served by being told the panel is being throttled.
    assert.equal(isRetryableTelegramOutcome(outcome, TELEGRAM_FLOOD_WAIT_CEILING_SECONDS), false);
  });

  it('never retries a bad token', () => {
    const outcome = classifyTelegramResponse({
      httpStatus: 401,
      body: { ok: false, description: 'Unauthorized' },
    });
    assert.equal(outcome.status, 'unauthorized');
    // Three more attempts with the same wrong token is three more of the same
    // answer. The remedy is a setting.
    assert.equal(isRetryableTelegramOutcome(outcome, TELEGRAM_FLOOD_WAIT_CEILING_SECONDS), false);
  });

  it('keeps the new chat id when a group becomes a supergroup', () => {
    const outcome = classifyTelegramResponse({
      httpStatus: 400,
      body: {
        ok: false,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: -1002000000000 },
      },
    });
    assert.equal(outcome.status, 'rejected');
    // Telegram says this exactly once. Every later attempt is a plain "chat
    // not found" with no hint at all, so an alert that drops it leaves the
    // operator with a chat that works in their client and not in the panel.
    assert.equal(outcome.migrateToChatId, '-1002000000000');
    assert.equal(isRetryableTelegramOutcome(outcome, TELEGRAM_FLOOD_WAIT_CEILING_SECONDS), false);
  });

  it('retries Telegram having a bad moment', () => {
    const outcome = classifyTelegramResponse({ httpStatus: 502, body: null });
    assert.equal(outcome.status, 'upstream_error');
    assert.equal(isRetryableTelegramOutcome(outcome, TELEGRAM_FLOOD_WAIT_CEILING_SECONDS), true);
  });

  it('does not retry a payload Telegram refuses', () => {
    const outcome = classifyTelegramResponse({
      httpStatus: 400,
      body: { ok: false, description: "Bad Request: can't parse entities" },
    });
    assert.equal(outcome.status, 'rejected');
    assert.equal(isRetryableTelegramOutcome(outcome, TELEGRAM_FLOOD_WAIT_CEILING_SECONDS), false);
  });
});

describe('the backoff a flood-wait earns', () => {
  it('grows exponentially when Telegram named no wait', () => {
    assert.equal(resolveTelegramDirectBackoff(1, null), 15_000);
    assert.equal(resolveTelegramDirectBackoff(2, null), 30_000);
    assert.equal(resolveTelegramDirectBackoff(3, null), 60_000);
  });

  it('waits out a flood-wait longer than the backoff, with a second of slack', () => {
    // Retrying at 15s inside a 42s ban does not fail politely — it earns a
    // longer ban. Landing on the exact boundary earns one too.
    assert.equal(resolveTelegramDirectBackoff(1, 42), 43_000);
  });

  it('keeps its own backoff when the flood-wait is shorter', () => {
    assert.equal(resolveTelegramDirectBackoff(3, 5), 60_000);
  });
});

describe('a failed request never repeats the URL it was given', () => {
  it('keeps the bot token out of the log line', () => {
    // The Bot API puts the token in the PATH, so `fetch`'s own message — which
    // is entitled to quote the request URL — is a secret. This line goes to
    // stdout, and on this product stdout goes to a log aggregator.
    const err = new Error(
      `request to https://api.telegram.org/bot${STORED_TOKEN}/sendMessage failed`,
    );
    err.name = 'TypeError';
    (err as { cause?: unknown }).cause = { code: 'ECONNRESET' };

    const described = describeFetchFailure(err);
    assert.equal(described, 'TypeError: ECONNRESET');
    assert.equal(described.includes(STORED_TOKEN), false);
    assert.equal(described.includes('api.telegram.org'), false);
  });

  it('still says something useful when there is no cause code', () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    assert.equal(describeFetchFailure(err), 'TimeoutError');
  });

  it('keeps the token out of the no-cause branch too', () => {
    // The branch the previous two do not reach, and the one where a leak would
    // actually happen: no cause code, so the only thing left to return is
    // either the name or the message — and the message is the URL. Mutation
    // testing found this hole: swapping `err.name` for `err.message` in that
    // branch left every other assertion here green.
    const err = new Error(
      `request to https://api.telegram.org/bot${STORED_TOKEN}/sendDocument failed`,
    );
    err.name = 'TypeError';

    const described = describeFetchFailure(err);
    assert.equal(described, 'TypeError');
    assert.equal(described.includes(STORED_TOKEN), false);
  });

  it('refuses a cause “code” that is really a sentence', () => {
    const err = new Error('nope');
    err.name = 'TypeError';
    (err as { cause?: unknown }).cause = {
      code: `fetch to https://api.telegram.org/bot${STORED_TOKEN} failed`,
    };
    const described = describeFetchFailure(err);
    assert.equal(described, 'TypeError');
    assert.equal(described.includes(STORED_TOKEN), false);
  });
});

describe('the operator mirror of a user notification', () => {
  /**
   * The clearest instance of the split in one method: `notifyUser` fans a
   * rendered notification out to the SUBSCRIBER through the bot, and then
   * mirrors the same HTML into the OPERATOR's chat. One event, two audiences.
   * After this change the second copy is the panel's own send and the first is
   * still the bot's — and nothing in the types stops a later edit from moving
   * the wrong one, so both halves are asserted here.
   */
  function buildNotifications(opts: { readonly storeToken: boolean }): {
    service: UserNotificationsService;
    relay: string[];
    direct: TelegramDirectJobData[];
  } {
    const relay: string[] = [];
    const direct: TelegramDirectJobData[] = [];
    const systemNotifications: Record<string, unknown> = {
      telegram: {
        enabled: true,
        mirrorUserNotifications: true,
        chatId: '-1002000000000',
        topicId: 7,
      },
    };
    if (opts.storeToken) {
      systemNotifications.botTokenEnc = encryptTotpSecret(STORED_TOKEN, CRYPT_KEY);
    }

    const prisma = {
      // The full `select` the service asks for. A stub that returns only `id`
      // makes `fanout` receive undefined userId/type and die inside its own
      // catch — the mirror then never runs and the test fails for a reason
      // that has nothing to do with routing.
      userNotificationEvent: {
        create: async () => ({
          id: 'evt-1',
          userId: 'user-1',
          type: 'subscription.expiring',
          payload: {},
        }),
      },
      user: {
        findUnique: async () => ({
          telegramId: null,
          isBotBlocked: false,
          name: 'Пользователь',
          language: 'ru',
        }),
      },
      settings: { findUnique: async () => ({ systemNotifications }) },
    };
    const service = new UserNotificationsService(
      prisma as never,
      { getByType: async () => null } as never,
      { notifyUser: async () => undefined } as never,
      { sendToUser: async () => undefined } as never,
      {
        substituteTelegramHtml: async (t: string) => t,
        substituteFallbacks: async (t: string) => t,
      } as never,
      {
        enqueue: async (event: string) => {
          relay.push(event);
          return true;
        },
      } as never,
      {
        enqueue: async (data: TelegramDirectJobData) => {
          direct.push(data);
          return true;
        },
      } as never,
      { cryptKey: CRYPT_KEY } as never,
    );
    return { service, relay, direct };
  }

  it('sends the operator’s copy itself once the panel holds a token', async () => {
    const { service, relay, direct } = buildNotifications({ storeToken: true });

    await service.create({
      userId: 'user-1',
      type: 'subscription.expiring',
      payload: {},
      preRenderedText: 'Подписка истекает',
    });
    await flush();

    assert.equal(direct.length, 1);
    assert.equal(direct[0]?.chatId, '-1002000000000');
    assert.equal(direct[0]?.topicId, 7);
    assert.equal(direct[0]?.sourceEventType, 'user_notification.operator_mirror');
    // And the bot is not asked to carry the operator's copy any more.
    assert.equal(relay.includes('reiwa.channel.broadcast'), false);
  });

  it('keeps handing the operator’s copy to the bot when there is no token', async () => {
    const { service, relay, direct } = buildNotifications({ storeToken: false });

    await service.create({
      userId: 'user-1',
      type: 'subscription.expiring',
      payload: {},
      preRenderedText: 'Подписка истекает',
    });
    await flush();

    assert.deepStrictEqual(direct, []);
    assert.equal(relay.includes('reiwa.channel.broadcast'), true);
  });
});
