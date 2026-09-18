import 'reflect-metadata';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { getQueueToken } from '@nestjs/bullmq';
import { createIORedisClient, createNodeRedisClient, type Queue } from 'bullmq';
import { Redis, ReplyError, type Command } from 'ioredis';

import { SystemEventsService } from '../src/common/services/system-events.service';
import {
  REIWA_RELAY_QUEUE,
  type ReiwaRelayEvent,
  type ReiwaRelayJobData,
} from '../src/modules/notifications/reiwa-relay.constants';
import {
  buildRelayUndeliveredRecorder,
  ReiwaRelayModule,
} from '../src/modules/notifications/reiwa-relay.module';
import { ReiwaRelayProcessor } from '../src/modules/notifications/reiwa-relay.processor';
import type { NotifyDeliveryResult } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import type { TelegramDirectClient } from '../src/modules/notifications/services/telegram-direct.client';
import { TelegramDirectQueueService } from '../src/modules/notifications/services/telegram-direct-queue.service';
import {
  TELEGRAM_DIRECT_QUEUE,
  type TelegramDirectJobData,
} from '../src/modules/notifications/telegram-direct.constants';
import {
  buildTelegramDirectUndeliveredRecorder,
  TelegramDirectModule,
} from '../src/modules/notifications/telegram-direct.module';
import type { TelegramDirectResult } from '../src/modules/notifications/telegram-direct.outcome';
import { TelegramDirectProcessor } from '../src/modules/notifications/telegram-direct.processor';
import {
  createUndeliveredRecorder,
  gateRedisOf,
  UNDELIVERED_ALERT_COOLDOWN_MS,
  UndeliveredAlertGate,
  type UndeliveredGateRedis,
} from '../src/modules/notifications/undelivered-alert-gate';
import {
  buildRelayUndeliveredRecord,
  buildTelegramDirectUndeliveredRecord,
  RELAY_UNDELIVERED_RECORDER,
  TELEGRAM_DIRECT_UNDELIVERED_RECORDER,
  type UndeliveredRecord,
} from '../src/modules/notifications/undelivered-record';
import { OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * One operator alert per cause
 * ════════════════════════════
 * A template Telegram refuses is refused once per subscriber, and every refusal
 * used to be its own `reiwa.relay_undelivered`: an audit row, a realtime push
 * and a card in the operator's topic each, plus an `UnrecoverableError` job in a
 * failed set bounded at a hundred. These specs drive the recorder the modules
 * actually bind, over a Redis double both "containers" share, and count what
 * reaches `SystemEventsService`.
 *
 * The double is a Redis server, as far as the commands the gate sends go
 * (`SET … PX … NX`, and `GET`/`DEL` or `INCR`/`PEXPIRE` in a `MULTI`), with
 * Redis's semantics — TTLs included — rather than answering the gate's
 * questions for it, so the windowing logic under test is the gate's own. It
 * answers where the socket would (see `RedisDouble.connect`), so the client in
 * front of it is the real one: ioredis, under the Proxy bullmq 5.81.5 hands out
 * as `Queue#client`.
 */

interface Clock {
  now: number;
}

/**
 * Redis, for the commands the gate sends, on a clock the spec moves.
 *
 * Every ioredis command, pipelined or not, leaves for the socket through
 * `sendCommand`, and that is the one method the double takes over. Everything
 * above it is the library: ioredis's commands, its MULTI pipeline and the way it
 * unwraps EXEC, and — through `queueOn` — BullMQ's Proxy over the client. A
 * change in any of them reaches these specs, which a double answering `set` and
 * `multi()` itself could never show.
 */
class RedisDouble {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  private refusal: string | null = null;

  public constructor(private readonly clock: Clock) {}

  /** A connection to this Redis: an ioredis client that never opens a socket. */
  public connect(): Redis {
    const client = new Redis({ lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    // MULTI state belongs to the connection, as it does in Redis.
    let transaction: string[][] | null = null;
    client.sendCommand = (command: Command): Promise<unknown> => {
      const argv = [command.name.toUpperCase(), ...command.args.map((arg) => String(arg))];
      if (argv[0] === 'MULTI') {
        transaction = [];
        command.resolve('OK');
      } else if (argv[0] === 'EXEC') {
        // Redis answers EXEC with every reply, a refused command's error included.
        const replies = (transaction ?? []).map((queued) => this.answer(queued));
        transaction = null;
        command.resolve(replies);
      } else if (transaction !== null) {
        transaction.push(argv);
        command.resolve('QUEUED');
      } else {
        const reply = this.answer(argv);
        if (reply instanceof Error) command.reject(reply);
        else command.resolve(reply);
      }
      return command.promise;
    };
    return client;
  }

  /** From now on a replica: every write is refused, in Redis's words. */
  public refuseWrites(reason: string): void {
    this.refusal = reason;
  }

  public keys(): string[] {
    return [...this.store.keys()].filter((key) => this.live(key) !== undefined);
  }

  /** The reply to one command, or the error Redis would send instead. */
  private answer([name, ...args]: string[]): unknown {
    if (this.refusal !== null && name !== 'GET') return new ReplyError(this.refusal);
    switch (name) {
      case 'SET':
        return this.set(args);
      case 'GET':
        return this.live(args[0])?.value ?? null;
      case 'DEL':
        return args.filter((key) => this.live(key) !== undefined && this.store.delete(key)).length;
      case 'INCR': {
        const entry = this.live(args[0]);
        const next = (entry === undefined ? 0 : Number(entry.value)) + 1;
        if (!Number.isSafeInteger(next)) return new ReplyError('ERR value is not an integer or out of range');
        // INCR keeps an existing TTL.
        this.store.set(args[0], { value: String(next), expiresAt: entry?.expiresAt ?? null });
        return next;
      }
      case 'PEXPIRE': {
        const entry = this.live(args[0]);
        if (entry === undefined) return 0;
        entry.expiresAt = this.clock.now + Number(args[1]);
        return 1;
      }
      default:
        // Not a command anyone taught this double: refused, never shrugged off.
        return new ReplyError(`ERR unknown command '${name}'`);
    }
  }

  private set([key, value, ...options]: string[]): 'OK' | null | Error {
    let expiresAt: number | null = null;
    let onlyIfAbsent = false;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index]?.toUpperCase();
      if (option === 'NX') {
        onlyIfAbsent = true;
      } else if (option === 'PX') {
        index += 1;
        expiresAt = this.clock.now + Number(options[index]);
      } else {
        return new ReplyError('ERR syntax error');
      }
    }
    if (onlyIfAbsent && this.live(key) !== undefined) return null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock.now) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }
}

interface Emitted {
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

/** `SystemEventsService`, as far as the recorders reach: every warn is an alert. */
function eventsSink(emitted: Emitted[]): Pick<SystemEventsService, 'warn'> {
  return {
    warn: (type: string, _category: string, message: string, metadata?: Record<string, unknown>) => {
      emitted.push({ type, message, metadata: metadata ?? {} });
    },
  } as Pick<SystemEventsService, 'warn'>;
}

/**
 * A BullMQ queue, as far as the recorder reaches: `Queue#client`, resolving to
 * what bullmq 5.81.5 resolves it to — BullMQ's Proxy over an ioredis client,
 * made by `createIORedisClient`, the call `RedisConnection` makes on the client
 * it builds from our `{ url }`.
 */
function queueOn(redis: RedisDouble): Pick<Queue, 'client'> {
  return { client: Promise.resolve(createIORedisClient(redis.connect())) };
}

function refusal(detail: string): NotifyDeliveryResult {
  return { status: 'rejected', messageId: null, httpStatus: 422, detail };
}

function relayJob(event: ReiwaRelayEvent, metadata: Record<string, unknown>, attemptsMade = 0) {
  return { id: 'job', data: { event, metadata } satisfies ReiwaRelayJobData, attemptsMade, opts: { attempts: 4 } } as never;
}

const CHANNEL_POST_PRISMA = { broadcast: { updateMany: async () => ({ count: 0 }) } } as never;

describe('the alert gate', () => {
  it('alerts the first time, counts the rest, and the next alert carries the count', async () => {
    const clock: Clock = { now: 1_000_000 };
    const gate = new UndeliveredAlertGate(null, { now: () => clock.now });

    assert.deepStrictEqual(await gate.admit('cause-a'), { alert: true, repeats: 0 });
    assert.deepStrictEqual(await gate.admit('cause-a'), { alert: false, repeats: 1 });
    assert.deepStrictEqual(await gate.admit('cause-a'), { alert: false, repeats: 2 });
    // A different cause is a different incident, inside the same minute.
    assert.deepStrictEqual(await gate.admit('cause-b'), { alert: true, repeats: 0 });

    clock.now += UNDELIVERED_ALERT_COOLDOWN_MS - 1;
    assert.deepStrictEqual(await gate.admit('cause-a'), { alert: false, repeats: 3 });
    clock.now += 1;
    assert.deepStrictEqual(
      await gate.admit('cause-a'),
      { alert: true, repeats: 3 },
      'the cause is still there after the cooldown: it alerts again, with its size',
    );
    assert.deepStrictEqual(await gate.admit('cause-a'), { alert: false, repeats: 1 });
  });

  it('keeps one window for both containers when they share Redis', async () => {
    const clock: Clock = { now: 5_000_000 };
    const redis = new RedisDouble(clock);
    const apiConnection = redis.connect();
    const workerConnection = redis.connect();
    const api = new UndeliveredAlertGate(async () => apiConnection);
    const worker = new UndeliveredAlertGate(async () => workerConnection);

    assert.deepStrictEqual(await api.admit('cause'), { alert: true, repeats: 0 });
    assert.deepStrictEqual(await worker.admit('cause'), { alert: false, repeats: 1 });
    assert.deepStrictEqual(await api.admit('cause'), { alert: false, repeats: 2 });

    clock.now += UNDELIVERED_ALERT_COOLDOWN_MS;
    assert.deepStrictEqual(await worker.admit('cause'), { alert: true, repeats: 2 });
    // Both keys carry a TTL: the window's is the cooldown, the counter's is
    // refreshed by every repeat — nothing here outlives its purpose.
    clock.now += 8 * 24 * 60 * 60 * 1_000;
    assert.deepStrictEqual(redis.keys(), []);
  });

  it('decides alone, and still coalesces, when Redis does not answer', async () => {
    const clock: Clock = { now: 0 };
    const silent = new UndeliveredAlertGate(() => new Promise<never>(() => undefined), {
      redisTimeoutMs: 20,
      now: () => clock.now,
    });

    const first = await silent.admit('cause');
    const second = await silent.admit('cause');

    assert.deepStrictEqual(first, { alert: true, repeats: 0 }, 'silence is the wrong way for an alert to fail');
    assert.deepStrictEqual(second, { alert: false, repeats: 1 }, 'and a storm is the thing being fixed');

    const replica = new RedisDouble(clock);
    replica.refuseWrites("READONLY You can't write against a read only replica.");
    const replicaConnection = replica.connect();
    const refusing = new UndeliveredAlertGate(async () => replicaConnection);
    assert.deepStrictEqual(await refusing.admit('cause'), { alert: true, repeats: 0 });
    assert.deepStrictEqual(await refusing.admit('cause'), { alert: false, repeats: 1 });
    assert.deepStrictEqual(replica.keys(), [], 'the replica took no write');
  });

  it('puts the count on the alert that carries it, in its sentence and its metadata', async () => {
    const clock: Clock = { now: 0 };
    const emitted: UndeliveredRecord[] = [];
    const record = (n: number): UndeliveredRecord => ({
      message: 'Reiwa relay did not deliver reiwa.user.notify (rejected)',
      metadata: { attempt: n },
      signature: 'same cause',
    });
    const recorder = createUndeliveredRecorder({
      gate: new UndeliveredAlertGate(null, { now: () => clock.now }),
      emit: (r) => emitted.push(r),
      describeRepeats: (repeats) => ` (+${repeats})`,
    });

    const answers: unknown[] = [];
    for (let n = 0; n < 5; n += 1) answers.push(await recorder(record(n)));
    clock.now += UNDELIVERED_ALERT_COOLDOWN_MS;
    answers.push(await recorder(record(5)));

    // It says which it did: a caller with its own card to raise about the same
    // loss needs to know whether one went out.
    assert.deepStrictEqual(answers, ['alerted', 'counted', 'counted', 'counted', 'counted', 'alerted']);
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]?.message, 'Reiwa relay did not deliver reiwa.user.notify (rejected)');
    assert.equal('repeatsSincePreviousAlert' in (emitted[0]?.metadata ?? {}), false);
    assert.equal(emitted[1]?.message, 'Reiwa relay did not deliver reiwa.user.notify (rejected) (+4)');
    assert.equal(emitted[1]?.metadata['repeatsSincePreviousAlert'], 4);
    assert.equal(emitted[1]?.metadata['attempt'], 5, 'the alert is the record that triggered it');
  });

  it('never rejects, so a job’s fate cannot depend on the audit log', async () => {
    const recorder = createUndeliveredRecorder({
      gate: new UndeliveredAlertGate(null),
      emit: () => {
        throw new Error('audit log unavailable');
      },
      describeRepeats: () => '',
    });
    assert.equal(await recorder({ message: 'x', metadata: {}, signature: 's' }), 'failed');
  });
});

describe('the connection the gate is given', () => {
  it('is the ioredis client BullMQ builds, from its own copy of ioredis', async () => {
    // What `RedisConnection` does with our `{ url }`: an ioredis client, made
    // with the ioredis BullMQ itself resolves, wrapped in BullMQ's Proxy. The
    // gate recognises ioredis by class, so a second copy of ioredis in the tree
    // — bullmq pins its own exact version — would leave every container
    // coalescing only for itself, with one warning each. That is this case red.
    const { Redis: BullMqRedis } = createRequire(require.resolve('bullmq'))('ioredis') as typeof import('ioredis');
    const raw = new BullMqRedis('redis://127.0.0.1:6379', { lazyConnect: true });
    const built = createIORedisClient(raw);

    await assert.doesNotReject(
      gateRedisOf({ client: Promise.resolve(built) }),
      'BullMQ built its client from an ioredis the gate does not recognise: two copies of ioredis in node_modules',
    );
    assert.equal(await gateRedisOf({ client: Promise.resolve(built) }), built);
  });

  it('is refused when BullMQ hands over any other client, whose SET would drop the NX', async () => {
    // BullMQ 5.81.5 ships drivers besides ioredis, and one assignment to
    // `RedisConnection.clientFactory` swaps them in. Its node-redis adapter,
    // over node-redis's own SET (options as an object, NX honoured when asked):
    const asked: unknown[] = [];
    const held = new Set<string>();
    const nodeRedis = Object.assign(new EventEmitter(), {
      isOpen: true,
      isReady: true,
      set: async (key: string, _value: string, options: { NX?: boolean; PX?: number } = {}) => {
        asked.push(options);
        if (options.NX === true && held.has(key)) return null;
        held.add(key);
        return 'OK';
      },
    });
    const adapter = createNodeRedisClient(nodeRedis);

    // Through the recorders the two modules bind, on a queue whose client this is.
    const record: UndeliveredRecord = { message: 'undelivered', metadata: {}, signature: 'same cause' };
    for (const build of [buildRelayUndeliveredRecorder, buildTelegramDirectUndeliveredRecorder]) {
      const emitted: Emitted[] = [];
      const recorder = build(eventsSink(emitted), { client: Promise.resolve(adapter) });
      assert.deepStrictEqual(
        [await recorder(record), await recorder(record)],
        ['alerted', 'counted'],
        `${build.name}: refused, the gate coalesces in this process instead`,
      );
      assert.equal(emitted.length, 1);
    }
    assert.deepStrictEqual(asked, [], 'the gate sent nothing through it');

    // Why: the adapter reads the gate's SET as a plain SET. Every record would
    // open a window, and every record would be an alert.
    const trusted = adapter as unknown as UndeliveredGateRedis;
    assert.equal(await trusted.set('k', '1', 'PX', 60_000, 'NX'), 'OK');
    assert.equal(await trusted.set('k', '1', 'PX', 60_000, 'NX'), 'OK');
    assert.deepStrictEqual(asked, [{}, {}], 'neither NX nor PX reached node-redis');
  });
});

describe('what counts as the same cause', () => {
  const base = { event: 'reiwa.user.notify' as const, attemptsMade: 4, attempts: 4 };

  it('is not the recipient, and not the positions Telegram quotes', () => {
    const a = buildRelayUndeliveredRecord({
      ...base,
      metadata: { eventId: 'n-1', telegramId: '111' },
      outcome: refusal("HTTP 422 Unprocessable Entity: Bad Request: can't parse entities: Unsupported start tag \"span\" at byte offset 57"),
    });
    const b = buildRelayUndeliveredRecord({
      ...base,
      metadata: { eventId: 'n-2', telegramId: '222222' },
      outcome: refusal("HTTP 422 Unprocessable Entity: Bad Request: can't parse entities: Unsupported start tag \"span\" at byte offset 63"),
    });
    assert.equal(a.signature, b.signature, 'one broken template, whatever the name rendered into it');
  });

  it('is the route, the status and the reason', () => {
    const of = (event: ReiwaRelayEvent, outcome: NotifyDeliveryResult, metadata: Record<string, unknown> = {}) =>
      buildRelayUndeliveredRecord({ ...base, event, metadata, outcome }).signature;
    const parse = refusal("HTTP 422 Unprocessable Entity: Bad Request: can't parse entities");
    const signatures = [
      of('reiwa.user.notify', parse),
      of('reiwa.user.notify', refusal('HTTP 422 Unprocessable Entity: Bad Request: BUTTON_URL_INVALID')),
      of('reiwa.user.notify', { status: 'rejected', messageId: null, httpStatus: 401, detail: 'HTTP 401 Unauthorized' }),
      // The digits of the REASON are normalised; the status itself is not.
      of('reiwa.user.notify', { ...parse, httpStatus: 400 }),
      of('reiwa.channel.broadcast', parse, { chatId: '-1001' }),
      of('reiwa.channel.broadcast', parse, { chatId: '-1002' }),
      of('reiwa.user.notify', { status: 'timeout', messageId: null, httpStatus: null, detail: 'timed out after 10000ms' }),
    ];
    assert.equal(new Set(signatures).size, signatures.length, signatures.join('\n'));
  });

  it('is what was being sent: two templates, two event cards', () => {
    // Telegram refuses two broken templates in the same words once the digits
    // go, and they were one incident: the second template's refusals were
    // counted into the first one's card, and nobody learned it was broken too.
    const refused = (offset: number) =>
      refusal(`HTTP 422 Unprocessable Entity: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset ${offset}`);
    const subscriber = (notificationType: string, offset: number) =>
      buildRelayUndeliveredRecord({
        ...base,
        metadata: { eventId: `n-${offset}`, telegramId: String(offset), notificationType },
        outcome: refused(offset),
      }).signature;
    assert.notEqual(subscriber('subscription_expiring_3d', 40), subscriber('referral_reward', 40));
    assert.equal(subscriber('referral_reward', 40), subscriber('referral_reward', 91), 'one template is still one cause');

    const card = (sourceEventType: string) =>
      buildTelegramDirectUndeliveredRecord({
        data: { kind: 'message', chatId: '-100200', topicId: 7, text: 'x', parseMode: 'HTML', sourceEventType },
        outcome: { status: 'rejected', httpStatus: 400, detail: "Bad Request: can't parse entities", retryAfterSeconds: null, migrateToChatId: null },
        attemptsMade: 1,
        attempts: 4,
      }).signature;
    assert.notEqual(card('payment.completed'), card('node.connection_lost'));

    // The operator mirror's source is the same for every template; its
    // template is what differs.
    const mirror = (notificationType: string) =>
      buildTelegramDirectUndeliveredRecord({
        data: {
          kind: 'message',
          chatId: '-100200',
          topicId: 7,
          text: 'x',
          parseMode: 'HTML',
          sourceEventType: 'user_notification.operator_mirror',
          notificationType,
        },
        outcome: { status: 'rejected', httpStatus: 400, detail: "Bad Request: can't parse entities", retryAfterSeconds: null, migrateToChatId: null },
        attemptsMade: 1,
        attempts: 4,
      }).signature;
    assert.notEqual(mirror('subscription_expiring_3d'), mirror('referral_reward'));
  });

  it('is the forum topic, on both transports', () => {
    // Two deleted topics in one operator chat answer the same "message thread
    // not found": two things to fix.
    const threadGone: TelegramDirectResult = {
      status: 'rejected',
      httpStatus: 400,
      detail: 'Bad Request: message thread not found',
      retryAfterSeconds: null,
      migrateToChatId: null,
    };
    const direct = (topicId: number) =>
      buildTelegramDirectUndeliveredRecord({
        data: { kind: 'message', chatId: '-100200', topicId, text: 'x', parseMode: 'HTML', sourceEventType: 'payment.completed' },
        outcome: threadGone,
        attemptsMade: 1,
        attempts: 4,
      });
    assert.notEqual(direct(7).signature, direct(9).signature);

    const relayed = (topicThreadId: number) =>
      buildRelayUndeliveredRecord({
        ...base,
        event: 'reiwa.channel.broadcast',
        metadata: { eventId: 'x:operator-mirror', chatId: '-100200', topicThreadId },
        outcome: refusal('HTTP 422 Unprocessable Entity: Bad Request: message thread not found'),
      });
    assert.notEqual(relayed(7).signature, relayed(9).signature);

    // And the card can say which chat and topic it was: the signature already
    // splits by them.
    assert.equal(direct(7).metadata['chatId'], '-100200');
    assert.equal(direct(7).metadata['topicId'], 7);
    assert.equal(relayed(9).metadata['chatId'], '-100200');
    assert.equal(relayed(9).metadata['topicId'], 9);
  });

  it('is its own incident for every broadcast channel post', () => {
    const post = (broadcastId: string) =>
      buildRelayUndeliveredRecord({
        ...base,
        event: 'reiwa.channel.broadcast',
        metadata: { eventId: `broadcast-channel:${broadcastId}`, chatId: '-100123', text: 'x' },
        outcome: { status: 'failed', messageId: null, httpStatus: null, detail: 'fetch failed' },
      });
    assert.notEqual(post('cmf0broadcastA').signature, post('cmf0broadcastB').signature);
    // One post, however many records of its loss — the fallback's miss, then a
    // late-landing job that failed another way — is one card.
    const lateJobMiss = buildRelayUndeliveredRecord({
      ...base,
      event: 'reiwa.channel.broadcast',
      metadata: { eventId: 'broadcast-channel:cmf0broadcastA', chatId: '-100123', text: 'x' },
      outcome: { status: 'timeout', messageId: null, httpStatus: null, detail: 'timed out after 10000ms' },
    });
    assert.equal(lateJobMiss.signature, post('cmf0broadcastA').signature);
    // Named on the card: the sentence and the metadata carry the broadcast.
    assert.match(post('cmf0broadcastA').message, /channel post of broadcast cmf0broadcastA$/);
    assert.equal(post('cmf0broadcastA').metadata['broadcastId'], 'cmf0broadcastA');
    assert.equal(post('cmf0broadcastA').metadata['relayEventId'], 'broadcast-channel:cmf0broadcastA');

    // The operator mirror and system cards on the same route still coalesce.
    const mirror = (eventId: string) =>
      buildRelayUndeliveredRecord({
        ...base,
        event: 'reiwa.channel.broadcast',
        metadata: { eventId, chatId: '-100123', text: 'x' },
        outcome: { status: 'failed', messageId: null, httpStatus: null, detail: 'fetch failed' },
      }).signature;
    assert.equal(mirror('n-1:operator-mirror'), mirror('n-2:operator-mirror'));
  });

  it('reads the system event a panel card is for off the key SystemEventsService mints', async () => {
    // A system card reaches the relay with no type in its metadata; the key
    // is where it survives. Pinned to the REAL key, not to a copy of its
    // format: if SystemEventsService changes it, this is what goes red.
    const relayed: Array<{ event: string; metadata: Record<string, unknown> }> = [];
    const service = new SystemEventsService(
      {
        settings: {
          findFirst: async () => ({
            systemNotifications: {
              telegram: { enabled: false, chatId: null, devChatId: '813364774', errorReports: { mode: 'manual', telegramTxt: false } },
            },
          }),
        },
        adminAuditLog: { create: async () => ({}) },
      } as never,
      { enabled: false, urls: [] } as never,
      { post: () => { throw new Error('no Bot API here'); } } as never,
      {
        get: (token: unknown) => {
          if (token === ReiwaRelayQueueService) {
            return {
              enqueue: async (event: string, metadata: Record<string, unknown>) => {
                relayed.push({ event, metadata });
                return true;
              },
            };
          }
          throw new Error('not registered');
        },
      } as never,
    );
    const savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
    try {
      service.warn('payment.amount_mismatch', 'PAYMENT', 'Оплачена неверная сумма', { paymentId: 'p-1' });
      service.warn('node.connection_lost', 'NODE', 'Нода недоступна', { node: 'de-1' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      if (savedToken !== undefined) process.env.BOT_TOKEN = savedToken;
    }

    assert.equal(relayed.length, 2, `expected two dev relays, got ${JSON.stringify(relayed.map((r) => r.event))}`);
    const records = relayed.map((r) =>
      buildRelayUndeliveredRecord({
        event: r.event as ReiwaRelayEvent,
        metadata: r.metadata,
        outcome: refusal("HTTP 422 Unprocessable Entity: Bad Request: can't parse entities"),
        attemptsMade: 4,
        attempts: 4,
      }),
    );
    assert.deepStrictEqual(
      records.map((r) => r.metadata['sourceEventType']),
      ['payment.amount_mismatch', 'node.connection_lost'],
    );
    assert.notEqual(records[0]?.signature, records[1]?.signature, 'two event cards are two incidents');
  });
});

describe('the recorder the relay module binds', () => {
  it('is the gated one, on the relay queue’s connection', () => {
    const providers = Reflect.getMetadata('providers', ReiwaRelayModule) as Array<Record<string, unknown>>;
    const recorder = providers.find((p) => typeof p === 'object' && p.provide === RELAY_UNDELIVERED_RECORDER);
    assert.ok(recorder, 'ReiwaRelayModule binds no RELAY_UNDELIVERED_RECORDER');
    assert.equal(recorder['useFactory'], buildRelayUndeliveredRecorder);
    assert.deepStrictEqual(recorder['inject'], [SystemEventsService, getQueueToken(REIWA_RELAY_QUEUE)]);

    const direct = (Reflect.getMetadata('providers', TelegramDirectModule) as Array<Record<string, unknown>>).find(
      (p) => typeof p === 'object' && p.provide === TELEGRAM_DIRECT_UNDELIVERED_RECORDER,
    );
    assert.ok(direct, 'TelegramDirectModule binds no TELEGRAM_DIRECT_UNDELIVERED_RECORDER');
    assert.equal(direct['useFactory'], buildTelegramDirectUndeliveredRecorder);
    assert.deepStrictEqual(direct['inject'], [SystemEventsService, getQueueToken(TELEGRAM_DIRECT_QUEUE)]);
  });

  it('turns a template refused for forty subscribers, in two containers, into one alert and a count', async () => {
    const clock: Clock = { now: 10_000_000 };
    const redis = new RedisDouble(clock);
    const emitted: Emitted[] = [];
    const events = eventsSink(emitted);
    // Two processes, one Redis: the API container and the worker both consume.
    const containers = [0, 1].map(() => {
      const recorder = buildRelayUndeliveredRecorder(events, queueOn(redis));
      let offset = 40;
      const processor = new ReiwaRelayProcessor(
        {
          deliverRelayEvent: async () =>
            refusal(`HTTP 422 Unprocessable Entity: Bad Request: can't parse entities: Unsupported start tag "span" at byte offset ${(offset += 3)}`),
        } as never,
        recorder,
        CHANNEL_POST_PRISMA,
      );
      return { processor, recorder };
    });

    const outcomes: Array<{ readonly delivered: boolean }> = [];
    for (let n = 0; n < 40; n += 1) {
      const { processor } = containers[n % 2] as (typeof containers)[number];
      outcomes.push(
        await processor.process(
          relayJob('reiwa.user.notify', { eventId: `notification-${n}`, telegramId: String(7_000 + n), text: '<span>x' }),
        ),
      );
    }

    assert.equal(emitted.length, 1, `forty refusals of one template: ${emitted.length} operator alerts`);
    assert.equal(emitted[0]?.type, 'reiwa.relay_undelivered');
    assert.match(String(emitted[0]?.metadata['detail']), /can't parse entities/);
    assert.deepStrictEqual(
      outcomes.map((o) => o.delivered),
      Array.from({ length: 40 }, () => false),
      'every job completes, undelivered, instead of filling the failed set',
    );

    // The same cause on the producer's direct fallback counts against the
    // same window: it is the same incident on a road with one attempt.
    const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
    queue.goDown();
    const producer = new ReiwaRelayQueueService(
      queue.asQueue(),
      {
        isEnabled: true,
        deliverRelayEvent: async () =>
          refusal('HTTP 422 Unprocessable Entity: Bad Request: can\'t parse entities: Unsupported start tag "span" at byte offset 9'),
      } as never,
      containers[0]?.recorder as never,
      CHANNEL_POST_PRISMA,
    );
    // And it says so: this loss was COUNTED into the card above, not carded.
    assert.equal(await producer.submit('reiwa.user.notify', { eventId: 'notification-40', telegramId: '1' }), 'lost-counted');
    assert.equal(emitted.length, 1);

    // A different reason is a different thing to fix, and says so at once.
    const other = new ReiwaRelayProcessor(
      { deliverRelayEvent: async () => refusal('HTTP 422 Unprocessable Entity: Bad Request: BUTTON_URL_INVALID') } as never,
      containers[1]?.recorder as never,
      CHANNEL_POST_PRISMA,
    );
    await other.process(relayJob('reiwa.user.notify', { eventId: 'notification-41', telegramId: '2' }));
    assert.equal(emitted.length, 2);

    // Still broken a cooldown later: one more alert, carrying the forty.
    clock.now += UNDELIVERED_ALERT_COOLDOWN_MS;
    await containers[1]?.processor.process(relayJob('reiwa.user.notify', { eventId: 'notification-42', telegramId: '3' }));
    assert.equal(emitted.length, 3);
    assert.equal(emitted[2]?.metadata['repeatsSincePreviousAlert'], 40);
    assert.match(String(emitted[2]?.message), /; 40 more like it since the previous alert$/);
  });

  it('cards every lost broadcast channel post by name, on the queued road too', async () => {
    // Two broadcasts post to one channel; the cabinet refuses both the same
    // way. Coalesced, the second post's loss was only counted into the first
    // one's card, and no card ever named broadcast B.
    const redis = new RedisDouble({ now: 20_000_000 });
    const emitted: Emitted[] = [];
    const broadcastWrites: Array<{ where: unknown; data: unknown }> = [];
    const processor = new ReiwaRelayProcessor(
      {
        deliverRelayEvent: async () => refusal('HTTP 422 Unprocessable Entity: Bad Request: chat not found'),
      } as never,
      buildRelayUndeliveredRecorder(eventsSink(emitted), queueOn(redis)),
      {
        broadcast: {
          updateMany: async (args: { where: unknown; data: unknown }) => {
            broadcastWrites.push(args);
            return { count: 1 };
          },
        },
      } as never,
    );

    for (const broadcastId of ['cmf0broadcastA', 'cmf0broadcastB']) {
      await processor.process(
        relayJob('reiwa.channel.broadcast', {
          eventId: `broadcast-channel:${broadcastId}`,
          chatId: '-100123',
          text: 'Анонс',
          parseMode: 'HTML',
        }),
      );
    }

    assert.deepStrictEqual(
      emitted.map((alert) => alert.metadata['broadcastId']),
      ['cmf0broadcastA', 'cmf0broadcastB'],
      'one card per lost post, each naming its broadcast',
    );
    // And neither is left reading as a public copy on the broadcast page.
    assert.deepStrictEqual(broadcastWrites, [
      { where: { id: 'cmf0broadcastA', channelMessageId: null }, data: { channelChatId: '-100123' } },
      { where: { id: 'cmf0broadcastB', channelMessageId: null }, data: { channelChatId: '-100123' } },
    ]);
  });

  it('still alerts on a link failure, and still fails the job for it', async () => {
    const redis = new RedisDouble({ now: 0 });
    const emitted: Emitted[] = [];
    const processor = new ReiwaRelayProcessor(
      {
        deliverRelayEvent: async (): Promise<NotifyDeliveryResult> => ({
          status: 'rejected',
          messageId: null,
          httpStatus: 401,
          detail: 'HTTP 401 Unauthorized',
        }),
      } as never,
      buildRelayUndeliveredRecorder(eventsSink(emitted), queueOn(redis)),
      CHANNEL_POST_PRISMA,
    );

    for (let n = 0; n < 5; n += 1) {
      await assert.rejects(
        () => processor.process(relayJob('reiwa.user.notify', { eventId: `n-${n}`, telegramId: '5' })),
        (err: unknown) => err instanceof Error && err.name === 'UnrecoverableError',
      );
    }
    assert.equal(emitted.length, 1, 'a secret mismatch refuses everything: one card');
  });
});

describe('the recorder the Telegram module binds', () => {
  const CARD: TelegramDirectJobData = {
    kind: 'message',
    chatId: '-1002000000000',
    topicId: null,
    text: '<b>card</b>',
    parseMode: 'HTML',
    sourceEventType: 'payment.completed',
  };
  const REVOKED: TelegramDirectResult = {
    status: 'unauthorized',
    httpStatus: 401,
    detail: 'Unauthorized',
    retryAfterSeconds: null,
    migrateToChatId: null,
  };

  it('turns a revoked token under a burst of cards into one alert, across both roads', async () => {
    const redis = new RedisDouble({ now: 0 });
    const emitted: Emitted[] = [];
    const recorder = buildTelegramDirectUndeliveredRecorder(eventsSink(emitted), queueOn(redis));
    const client = { send: async () => REVOKED } as unknown as TelegramDirectClient;
    const processor = new TelegramDirectProcessor(client, recorder);

    for (let n = 0; n < 12; n += 1) {
      await assert.rejects(() =>
        processor.process({ id: `card-${n}`, data: CARD, attemptsMade: 0, opts: { attempts: 4 } } as never),
      );
    }
    const queue = new OfflineBullMqQueue<TelegramDirectJobData>(TELEGRAM_DIRECT_QUEUE);
    queue.goDown();
    const producer = new TelegramDirectQueueService(queue.asQueue(), client, recorder);
    assert.equal(await producer.enqueue(CARD, 'sysevt:payment.completed:2026-09-14T10:00:00.000Z:direct-1'), false);

    assert.equal(emitted.length, 1, `a revoked token and thirteen cards: ${emitted.length} alerts`);
    assert.equal(emitted[0]?.type, 'telegram.direct_undelivered');
  });
});
