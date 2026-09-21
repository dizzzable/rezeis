import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { of } from 'rxjs';

import { toBullMqJobId } from '../src/common/queue/bullmq-job-id';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { readAdminBotToken } from '../src/common/utils/admin-bot-token.util';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';
import {
  REIWA_RELAY_QUEUE,
  type ReiwaRelayJobData,
} from '../src/modules/notifications/reiwa-relay.constants';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { TelegramDirectQueueService } from '../src/modules/notifications/services/telegram-direct-queue.service';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import {
  describeFetchFailure,
  type TelegramDirectClient,
} from '../src/modules/notifications/services/telegram-direct.client';
import {
  TELEGRAM_DIRECT_JOB,
  TELEGRAM_DIRECT_QUEUE,
  TELEGRAM_FLOOD_WAIT_CEILING_SECONDS,
  isTelegramDirectLoopGuardedEvent,
  resolveTelegramDirectBackoff,
  type TelegramDirectJobData,
} from '../src/modules/notifications/telegram-direct.constants';
import {
  classifyTelegramResponse,
  isRetryableTelegramOutcome,
  type TelegramDirectResult,
} from '../src/modules/notifications/telegram-direct.outcome';
import { TelegramDirectProcessor } from '../src/modules/notifications/telegram-direct.processor';
import type { UndeliveredRecord } from '../src/modules/notifications/undelivered-record';
import { AUTOMATION_CHAIN_DEPTH_KEY } from '../src/modules/automations/chain-depth';
import { OfflineBullMqQueue } from './helpers/bullmq-offline-queue';
import { ReconnectingBullMqQueue } from './helpers/bullmq-reconnecting-queue';

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
 *
 * ── The roads are the REAL producers, on queues that answer like BullMQ ────
 *
 * Both queues used to be `{ enqueue: async () => true }`. That recorded the
 * road a card took and nothing about whether the road existed: every system
 * card is keyed `sysevt:<type>:<ISO time>:…`, BullMQ refused every one of those
 * job ids ("Custom Id cannot contain :"), and in production every card went
 * out on the one-attempt fallback while these tests said "queued". So the
 * producers here are the real `ReiwaRelayQueueService` and
 * `TelegramDirectQueueService`, over `OfflineBullMqQueue`, which runs BullMQ's
 * own admission code — a road is only counted when BullMQ took the job.
 */

const CRYPT_KEY = 'test-crypt-key-for-bot-token';
const STORED_TOKEN = '7000000000:AAH-panel-owned-token';

interface Roads {
  /** Relay events BullMQ accepted onto the reiwa queue, in order. */
  readonly relay: string[];
  /** Jobs BullMQ accepted onto the panel's own Telegram queue, in order. */
  readonly direct: TelegramDirectJobData[];
  /** Relay events sent down the one-shot bot client, in order. */
  relayDirect: string[];
  /** Cards the Telegram producer had to send without its queue. */
  directFallback: TelegramDirectJobData[];
  /** Bot API calls made inline by `SystemEventsService` itself. */
  inline: number;
}

/** Prisma, as far as the relay producer's channel-post bookkeeping reaches. */
const CHANNEL_POST_PRISMA = { broadcast: { updateMany: async () => ({ count: 0 }) } } as never;

/** The real relay producer over a BullMQ-validating queue. */
function realRelayQueue(notifier: { deliverRelayEvent: BotNotifierClient['deliverRelayEvent'] }) {
  const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
  const producer = new ReiwaRelayQueueService(
    queue.asQueue(),
    { isEnabled: true, deliverRelayEvent: notifier.deliverRelayEvent } as unknown as BotNotifierClient,
    () => undefined,
    CHANNEL_POST_PRISMA,
  );
  return { queue, producer };
}

/** The real Telegram producer over a BullMQ-validating queue. */
function realDirectQueue(fallback: TelegramDirectJobData[]) {
  const queue = new OfflineBullMqQueue<TelegramDirectJobData>(TELEGRAM_DIRECT_QUEUE);
  const producer = new TelegramDirectQueueService(
    queue.asQueue(),
    {
      send: async (data: TelegramDirectJobData): Promise<TelegramDirectResult> => {
        fallback.push(data);
        return { status: 'sent', httpStatus: 200, detail: null, retryAfterSeconds: null, migrateToChatId: null };
      },
    } as unknown as TelegramDirectClient,
    () => undefined,
  );
  return { queue, producer };
}

function buildService(opts: {
  readonly telegram: Record<string, unknown>;
  readonly storeToken?: boolean;
  readonly directQueueRegistered?: boolean;
}): { service: SystemEventsService; roads: Roads } {
  const relayDirect: string[] = [];
  const directFallback: TelegramDirectJobData[] = [];

  const notifier = {
    deliverRelayEvent: async (event: string) => {
      relayDirect.push(event);
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null } as const;
    },
  };
  const relay = realRelayQueue(notifier as never);
  const telegram = realDirectQueue(directFallback);
  const relayQueue = relay.producer;
  const directQueue = telegram.producer;
  const roads: Roads = {
    get relay() {
      return relay.queue.admitted.map((call) => call.data.event);
    },
    get direct() {
      return telegram.queue.admitted.map((call) => call.data);
    },
    relayDirect,
    directFallback,
    inline: 0,
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
    // And "on the queue" means ON it. BullMQ refused the `sysevt:` key raw, so
    // this card used to go out on the one-attempt fallback instead.
    assert.deepStrictEqual(roads.directFallback, []);
  });

  it('still goes through the reiwa bot when the panel holds no token', async () => {
    const { service, roads } = buildService({ telegram: GROUP, storeToken: false });

    service.info('payment.completed', 'PAYMENT', 'Платёж получен', { amount: 100 });
    await flush();

    // Unchanged split-deployment behaviour — this is the case the relay exists
    // for, and it must survive the change that made the other case direct.
    assert.deepStrictEqual(roads.relay, ['reiwa.channel.broadcast']);
    assert.deepStrictEqual(roads.direct, []);
    assert.deepStrictEqual(roads.relayDirect, [], 'the relay job was refused and sent once, unqueued');
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
    assert.deepStrictEqual(roads.directFallback, []);
  });

  it('stamps both jobs with the automation hop count of the event they are for', async () => {
    const { service, roads } = buildService({
      telegram: { ...GROUP, errorReports: { mode: 'manual', telegramTxt: true } },
    });

    // A rule-produced event three hops into a chain, and an ordinary one.
    service.error('system.error', 'SYSTEM', 'boom', { stack: 'at x', [AUTOMATION_CHAIN_DEPTH_KEY]: 3 });
    service.info('payment.completed', 'PAYMENT', 'Платёж получен', { amount: 100 });
    await flush();

    // The two emits deliver concurrently, so the jobs are compared as a set.
    const stamped = roads.direct
      .map((job) => `${job.sourceEventType}/${job.kind}/${String(job.automationChainDepth)}`)
      .sort();
    assert.deepStrictEqual(stamped, [
      'payment.completed/message/undefined',
      'system.error/document/3',
      'system.error/message/3',
    ]);
    const ordinary = roads.direct.find((job) => job.sourceEventType === 'payment.completed');
    assert.equal(AUTOMATION_CHAIN_DEPTH_KEY in (ordinary ?? {}), false, 'no key on a card no rule produced');
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

/**
 * The Telegram producer, on the road it is supposed to take
 * ═════════════════════════════════════════════════════════
 * Every card `SystemEventsService` queues is keyed on a `sysevt:` id, and
 * BullMQ refused all of them raw. The fallback then made one attempt, reported
 * "not durable" whatever happened, and — when that attempt failed — left a
 * log line where the processor would have written `telegram.direct_undelivered`.
 */
describe('the panel’s Telegram producer', () => {
  const SYSEVT_KEY = 'sysevt:payment.completed:2026-09-14T10:00:00.000Z:direct-0123456789abcdef';
  const CARD: TelegramDirectJobData = {
    kind: 'message',
    chatId: '-1002000000000',
    topicId: 42,
    text: '<b>Платёж получен</b>',
    parseMode: 'HTML',
    sourceEventType: 'payment.completed',
  };
  const SENT: TelegramDirectResult = {
    status: 'sent',
    httpStatus: 200,
    detail: null,
    retryAfterSeconds: null,
    migrateToChatId: null,
  };

  function build(opts: { readonly redisDown?: boolean; readonly send?: () => Promise<TelegramDirectResult> } = {}) {
    const queue = new OfflineBullMqQueue<TelegramDirectJobData>(TELEGRAM_DIRECT_QUEUE);
    if (opts.redisDown === true) queue.goDown();
    const sent: TelegramDirectJobData[] = [];
    const recorded: UndeliveredRecord[] = [];
    const producer = new TelegramDirectQueueService(
      queue.asQueue(),
      {
        send: async (data: TelegramDirectJobData) => {
          sent.push(data);
          return opts.send === undefined ? SENT : opts.send();
        },
      } as unknown as TelegramDirectClient,
      (record) => void recorded.push(record),
    );
    return { queue, producer, sent, recorded };
  }

  it('queues a system card keyed on its sysevt id instead of refusing it', async () => {
    const { queue, producer, sent } = build();

    assert.equal(await producer.enqueue(CARD, SYSEVT_KEY), true);

    assert.deepStrictEqual(queue.refused, [], 'BullMQ refused the job id');
    assert.equal(queue.admitted.length, 1);
    assert.equal(queue.admitted[0]?.jobId, toBullMqJobId(TELEGRAM_DIRECT_JOB, SYSEVT_KEY));
    assert.deepStrictEqual(queue.admitted[0]?.data, CARD, 'the card is queued as it was handed over');
    assert.deepStrictEqual(sent, [], 'a queued card is not also sent inline');
  });

  it('collapses a double enqueue of one card, and keeps two cards apart', async () => {
    const { queue, producer } = build();

    await producer.enqueue(CARD, SYSEVT_KEY);
    await producer.enqueue(CARD, SYSEVT_KEY);
    await producer.enqueue(CARD, SYSEVT_KEY.replace('direct-', 'direct-document-'));

    assert.deepStrictEqual(
      queue.admitted.map((call) => call.collapsed),
      [false, true, false],
    );
    assert.equal(queue.heldIds().length, 2);
  });

  it('answers true when Redis refused the card but the direct attempt sent it', async () => {
    const { producer, sent, recorded } = build({ redisDown: true });

    assert.equal(await producer.enqueue(CARD, SYSEVT_KEY), true, 'the card is in the chat');
    assert.equal(sent.length, 1);
    assert.deepStrictEqual(recorded, []);
  });

  it('records a card neither road delivered, as the processor records one', async () => {
    const { producer, recorded } = build({
      redisDown: true,
      send: async () => ({
        status: 'unauthorized',
        httpStatus: 401,
        detail: 'Unauthorized',
        retryAfterSeconds: null,
        migrateToChatId: null,
      }),
    });

    assert.equal(await producer.enqueue(CARD, SYSEVT_KEY), false);

    assert.equal(recorded.length, 1);
    const record = recorded[0] as UndeliveredRecord;
    assert.equal(
      record.message,
      'Панель не доставила карточку в Telegram: Telegram отклонил токен бота — проверьте «Настройки» → «Токен бота»',
    );
    assert.equal(record.metadata['sourceEventType'], 'payment.completed');
    assert.equal(record.metadata['telegramStatus'], 'unauthorized');
    assert.equal(record.metadata['attemptsMade'], 1);
    assert.equal(record.metadata['attempts'], 1);
    assert.match(String(record.metadata['enqueueError']), /Connection is closed/);
  });

  it('records a send that threw, instead of throwing at the caller', async () => {
    const { producer, recorded } = build({
      redisDown: true,
      send: async () => {
        throw new Error('database unavailable');
      },
    });

    assert.equal(await producer.enqueue(CARD, SYSEVT_KEY), false);
    assert.equal(recorded[0]?.metadata['telegramStatus'], 'failed');
  });

  /**
   * The add timed out — and Redis replayed it. The Bot API has no idempotency
   * key, so a card sent by the fallback AND by the job that landed afterwards
   * is two identical cards in the operator's topic.
   */
  describe('when the add only timed out', () => {
    const JOB_ID = toBullMqJobId(TELEGRAM_DIRECT_JOB, SYSEVT_KEY);

    function buildLate(send: () => Promise<TelegramDirectResult>) {
      const queue = new ReconnectingBullMqQueue<TelegramDirectJobData>(TELEGRAM_DIRECT_QUEUE);
      const sent: TelegramDirectJobData[] = [];
      const recorded: UndeliveredRecord[] = [];
      const producer = new TelegramDirectQueueService(
        queue.asQueue(),
        {
          send: async (data: TelegramDirectJobData) => {
            sent.push(data);
            return send();
          },
        } as unknown as TelegramDirectClient,
        (record) => void recorded.push(record),
      );
      return { queue, producer, sent, recorded };
    }

    it('does not send the card itself when the job is there by the time it looks', async () => {
      const { queue, producer, sent } = buildLate(async () => SENT);
      queue.goAway();
      queue.reconnectWhen('getJob');

      assert.equal(await producer.enqueue(CARD, SYSEVT_KEY), true);

      assert.deepStrictEqual(sent, [], 'the job will send it; sending here is the second card');
      assert.deepStrictEqual(queue.inner.heldIds(), [JOB_ID]);
    });

    it('withdraws the job when the card went out directly and the add lands later', async () => {
      const { queue, producer, sent } = buildLate(async () => SENT);
      queue.goAway();

      assert.equal(await producer.enqueue(CARD, SYSEVT_KEY), true);
      assert.equal(sent.length, 1);

      await queue.reconnect();
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepStrictEqual(queue.inner.heldIds(), [], 'a landed job here is a second, identical card');
    });

    it('does not record a card as lost when its job landed while the send failed', async () => {
      const { queue, producer, recorded } = buildLate(async () => {
        await queue.reconnect();
        return { status: 'upstream_error', httpStatus: 502, detail: null, retryAfterSeconds: null, migrateToChatId: null };
      });
      queue.goAway();

      assert.equal(await producer.enqueue(CARD, SYSEVT_KEY), true, 'the job has four attempts at it');
      assert.deepStrictEqual(recorded, []);
    });
  });
});

/**
 * The automation hop count, handed back by a card the panel could not send
 * ════════════════════════════════════════════════════════════════════════
 * The relay record hands the count back; this one did not. A rule "tell me on
 * Telegram when a card cannot be sent" then queued its own card, a revoked
 * token refused it at once, and the record put a depth-zero event back on the
 * bus — a fresh four-hop budget per generation, for as long as the token stays
 * revoked.
 */
describe('a card the panel could not send carries its chain depth back', () => {
  const STAMPED: TelegramDirectJobData = {
    kind: 'message',
    chatId: '-1002000000000',
    topicId: null,
    text: 'rule fired',
    parseMode: 'HTML',
    sourceEventType: 'automation.telegram_notify',
    automationChainDepth: 3,
  };
  const REVOKED: TelegramDirectResult = {
    status: 'unauthorized',
    httpStatus: 401,
    detail: 'Unauthorized',
    retryAfterSeconds: null,
    migrateToChatId: null,
  };

  it('from the processor', async () => {
    const recorded: UndeliveredRecord[] = [];
    const processor = new TelegramDirectProcessor(
      { send: async () => REVOKED } as unknown as TelegramDirectClient,
      (record) => {
        recorded.push(record);
      },
    );

    await assert.rejects(() =>
      processor.process({ id: 'card-1', data: STAMPED, attemptsMade: 0, opts: { attempts: 4 } } as never),
    );

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.metadata[AUTOMATION_CHAIN_DEPTH_KEY], 3);
  });

  it('from the producer’s direct fallback', async () => {
    const queue = new OfflineBullMqQueue<TelegramDirectJobData>(TELEGRAM_DIRECT_QUEUE);
    queue.goDown();
    const recorded: UndeliveredRecord[] = [];
    const producer = new TelegramDirectQueueService(
      queue.asQueue(),
      { send: async () => REVOKED } as unknown as TelegramDirectClient,
      (record) => void recorded.push(record),
    );

    assert.equal(await producer.enqueue(STAMPED, 'sysevt:automation.telegram_notify:2026-09-14T10:00:00.000Z:direct-0'), false);

    assert.equal(recorded[0]?.metadata[AUTOMATION_CHAIN_DEPTH_KEY], 3);
  });

  it('and adds none to a card no rule produced', async () => {
    const recorded: UndeliveredRecord[] = [];
    const processor = new TelegramDirectProcessor(
      { send: async () => REVOKED } as unknown as TelegramDirectClient,
      (record) => {
        recorded.push(record);
      },
    );
    const { automationChainDepth: _depth, ...unstamped } = STAMPED;

    await assert.rejects(() =>
      processor.process({ id: 'card-2', data: unstamped, attemptsMade: 0, opts: { attempts: 4 } } as never),
    );

    assert.equal(AUTOMATION_CHAIN_DEPTH_KEY in (recorded[0]?.metadata ?? {}), false);
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
  function buildNotifications(opts: {
    readonly storeToken: boolean;
    /** The recipient row; the default has no Telegram id, so only the mirror sends. */
    readonly user?: Record<string, unknown>;
  }): {
    service: UserNotificationsService;
    /** Relay events BullMQ accepted, in order. */
    relay: () => string[];
    relayJobs: () => ReiwaRelayJobData[];
    /** Telegram jobs BullMQ accepted, in order. */
    direct: () => TelegramDirectJobData[];
  } {
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
    const userRow = opts.user ?? {
      telegramId: null,
      isBotBlocked: false,
      name: 'Пользователь',
      username: null,
      language: 'ru',
    };

    let created = 0;
    const prisma = {
      // The full `select` the service asks for. A stub that returns only `id`
      // makes `fanout` receive undefined userId/type and die inside its own
      // catch — the mirror then never runs and the test fails for a reason
      // that has nothing to do with routing.
      userNotificationEvent: {
        create: async (args: { data: { userId: string; type: string; payload: unknown } }) => ({
          id: `evt-${(created += 1)}`,
          userId: args.data.userId,
          type: args.data.type,
          payload: args.data.payload,
        }),
      },
      user: { findUnique: async () => userRow },
      settings: { findUnique: async () => ({ systemNotifications }) },
    };
    const relay = realRelayQueue({
      deliverRelayEvent: async () => ({ status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null }),
    });
    const telegram = realDirectQueue([]);
    const service = new UserNotificationsService(
      prisma as never,
      { getByType: async () => null } as never,
      { notifyUser: async () => undefined } as never,
      {
        resolveBrandName: async () => 'Winger VPN',
        sendToUser: async () => ({ attempted: 0, delivered: 0, failed: 0, disabled: true }),
        isConfigured: async () => false,
        countSubscriptions: async () => 0,
      } as never,
      {
        substituteTelegramHtml: async (t: string) => t,
        substituteFallbacks: async (t: string) => t,
      } as never,
      relay.producer,
      telegram.producer,
      { cryptKey: CRYPT_KEY } as never,
    );
    return {
      service,
      relay: () => relay.queue.admitted.map((call) => call.data.event),
      relayJobs: () => relay.queue.admitted.map((call) => call.data),
      direct: () => telegram.queue.admitted.map((call) => call.data),
    };
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

    assert.equal(direct().length, 1);
    assert.equal(direct()[0]?.chatId, '-1002000000000');
    assert.equal(direct()[0]?.topicId, 7);
    assert.equal(direct()[0]?.sourceEventType, 'user_notification.operator_mirror');
    // The template it copies, so a refusal of this template is its own
    // incident in the undelivered alert, not one shared by every mirror.
    assert.equal(direct()[0]?.notificationType, 'subscription.expiring');
    // And the bot is not asked to carry the operator's copy any more.
    assert.equal(relay().includes('reiwa.channel.broadcast'), false);
  });

  it('keeps handing the operator’s copy to the bot when there is no token', async () => {
    const { service, relay, relayJobs, direct } = buildNotifications({ storeToken: false });

    await service.create({
      userId: 'user-1',
      type: 'subscription.expiring',
      payload: {},
      preRenderedText: 'Подписка истекает',
    });
    await flush();

    assert.deepStrictEqual(direct(), []);
    assert.equal(relay().includes('reiwa.channel.broadcast'), true);
    const mirror = relayJobs().find((job) => job.event === 'reiwa.channel.broadcast');
    assert.equal(mirror?.metadata['notificationType'], 'subscription.expiring');
    assert.equal(mirror?.metadata['sourceEventType'], 'user_notification.operator_mirror');
  });

  it('posts no copy of a broadcast, which calls create() once per recipient', async () => {
    // A broadcast to three subscribers was three identical cards in the USER
    // topic — and a thousand for a thousand. A broadcast has its own operator
    // copy already: the channel post.
    for (const storeToken of [true, false]) {
      const { service, relay, direct } = buildNotifications({ storeToken });

      for (const userId of ['user-1', 'user-2', 'user-3']) {
        await service.create({
          userId,
          type: 'broadcast',
          payload: { broadcastId: 'b-1', broadcastMessageId: `m-${userId}` },
          preRenderedText: '<b>Анонс</b>\n\nСкидка 20%',
          skipTelegram: true,
        });
      }
      await flush();

      assert.deepStrictEqual(direct(), [], `token=${storeToken}: a mirror per broadcast recipient`);
      assert.equal(
        relay().includes('reiwa.channel.broadcast'),
        false,
        `token=${storeToken}: a mirror per broadcast recipient, through the bot`,
      );
    }
  });

  it('posts no blank card', async () => {
    // A media-only broadcast used to reach the mirror as `' '`. Whatever the
    // caller, a card with no words in it copies nothing.
    const { service, direct } = buildNotifications({ storeToken: true });

    await service.create({ userId: 'user-1', type: 'ADMIN_MESSAGE', payload: {}, preRenderedText: ' ' });
    await service.create({ userId: 'user-1', type: 'ADMIN_MESSAGE', payload: {}, preRenderedText: '<b> </b>\n' });
    await flush();

    assert.deepStrictEqual(direct(), []);
  });

  it('names the recipient on the copy, escaped', async () => {
    const { service, direct } = buildNotifications({
      storeToken: true,
      user: {
        telegramId: 12345n,
        isBotBlocked: false,
        name: 'Nina <b>&',
        username: 'nina_k',
        language: 'ru',
      },
    });

    await service.create({
      userId: 'user-1',
      type: 'subscription.expiring',
      payload: {},
      preRenderedText: 'Подписка истекает',
    });
    await flush();

    const card = direct()[0]?.text ?? '';
    assert.ok(card.startsWith('Подписка истекает'), 'the notification itself comes first, unchanged');
    assert.ok(card.includes('👤 <b>Получатель:</b>'), card);
    assert.ok(card.includes('🪪 Telegram ID: <code>12345</code>'), card);
    assert.ok(card.includes('👾 Reiwa ID: <code>user-1</code>'), card);
    assert.ok(card.includes('👤 Имя: Nina &lt;b&gt;&amp; (@nina_k)'), card);
    assert.equal(card.includes('Nina <b>'), false, 'a display name is not markup');
  });

  it('keeps a copy of a notification at the limit inside one Telegram message, on both roads', async () => {
    // An operator's message may use all 4096 characters. The recipient block
    // appended after it made the copy ~200 characters too long, so Telegram
    // (or the cabinet's `max(4096)`, through the bot) refused every such
    // mirror — a lost copy and an operator alert per notification.
    const user = {
      telegramId: 123456789n,
      isBotBlocked: false,
      name: 'Нина & <Карпова>',
      username: 'nina_karpova',
      language: 'ru',
    };
    const notification = `<b>Важное</b>\n${'Ж'.repeat(4_082)}`;
    assert.equal(notification.length, 4_096, 'the notification alone is exactly at the limit');

    for (const storeToken of [true, false]) {
      const { service, direct, relayJobs } = buildNotifications({ storeToken, user });

      await service.create({ userId: 'user-1', type: 'ADMIN_MESSAGE', payload: {}, preRenderedText: notification });
      await flush();

      const card = storeToken
        ? String(direct()[0]?.text ?? '')
        : String(relayJobs().find((job) => job.event === 'reiwa.channel.broadcast')?.metadata['text'] ?? '');
      const road = storeToken ? 'panel' : 'bot';
      assert.ok(card.length > 0, `${road}: no mirror was queued`);
      assert.ok(card.length <= 4_096, `${road}: the copy is ${card.length} characters, Telegram takes 4096`);
      assert.ok(card.startsWith('<b>Важное</b>\nЖЖЖ'), `${road}: the notification leads, clipped at its end`);
      assert.ok(card.includes('\n…\n\n👤 <b>Получатель:</b>'), `${road}: the cut is marked, then the block follows`);
      assert.ok(card.endsWith('</blockquote>'), `${road}: the recipient block is whole`);
      assert.ok(card.includes('🪪 Telegram ID: <code>123456789</code>'), road);
      assert.ok(card.includes('👤 Имя: Нина &amp; &lt;Карпова&gt; (@nina_karpova)'), road);
    }
  });

  it('leaves a notification that fits untouched', async () => {
    const { service, direct } = buildNotifications({ storeToken: true });
    const notification = `<b>Коротко</b>\n${'ж'.repeat(3_000)}`;

    await service.create({ userId: 'user-1', type: 'ADMIN_MESSAGE', payload: {}, preRenderedText: notification });
    await flush();

    const card = String(direct()[0]?.text ?? '');
    assert.ok(card.startsWith(`${notification}\n\n👤 <b>Получатель:</b>`), 'no clip marker on a copy that fits');
  });

  it('names the recipient on the copy of an operator’s own message, and through the bot too', async () => {
    const { service, relayJobs } = buildNotifications({
      storeToken: false,
      user: { telegramId: 777n, isBotBlocked: false, name: 'Oleg', username: null, language: 'ru' },
    });

    await service.sendOperatorMessage({ userId: 'user-9', text: 'Здравствуйте', channels: [] });

    const mirror = relayJobs().find((job) => job.event === 'reiwa.channel.broadcast');
    const text = String(mirror?.metadata['text'] ?? '');
    assert.ok(text.startsWith('Здравствуйте'), text);
    assert.ok(text.includes('🪪 Telegram ID: <code>777</code>'), text);
    assert.ok(text.includes('👾 Reiwa ID: <code>user-9</code>'), text);
    assert.ok(text.includes('👤 Имя: Oleg'), text);
    // The bot dedups on this, so it must stay the logical key.
    assert.equal(mirror?.metadata['eventId'], 'evt-1:operator-mirror');
  });
});

