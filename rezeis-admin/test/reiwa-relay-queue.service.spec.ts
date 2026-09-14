import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Backoffs, type BackoffOptions } from 'bullmq';

import {
  BULLMQ_RETAINED_COMPLETED_JOBS,
  BULLMQ_RETAINED_FAILED_JOBS,
} from '../src/common/queue/bullmq-enqueue-options';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { toBullMqJobId } from '../src/common/queue/bullmq-job-id';
import { BROADCAST_CHANNEL_EVENT_PREFIX } from '../src/modules/broadcast/broadcast.constants';
import {
  REIWA_RELAY_EVENTS,
  REIWA_RELAY_JOB,
  REIWA_RELAY_QUEUE,
  type ReiwaRelayJobData,
} from '../src/modules/notifications/reiwa-relay.constants';
import {
  RELAY_BACKOFF_TYPE,
  RELAY_EVENT_POLICY,
  type RelayEventPolicy,
} from '../src/modules/notifications/reiwa-relay.policy';
import {
  ReiwaRelayProcessor,
  relayBackoffStrategy,
} from '../src/modules/notifications/reiwa-relay.processor';
import type {
  BotNotifierClient,
  NotifyDeliveryResult,
} from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import type { UndeliveredRecord } from '../src/modules/notifications/undelivered-record';
import { OfflineBullMqQueue, type AdmittedAdd } from './helpers/bullmq-offline-queue';
import { ReconnectingBullMqQueue } from './helpers/bullmq-reconnecting-queue';

/**
 * The producer half, tested where it actually decides things
 * ═════════════════════════════════════════════════════════
 * `ReiwaRelayQueueService` was never constructed in a spec. The retry policy
 * WAS covered — as constants: `RELAY_EVENT_POLICY['reiwa.user.notify'].attempts
 * === 4`, asserted against the object it was read from. Nothing asked whether
 * those numbers ever reach `queue.add`, which is the only place they mean
 * anything, so the entire retry feature could be deleted at the call site and
 * the suite stayed green. It was: replacing `attempts: policy.attempts` with
 * `attempts: 1` and dropping `backoff` altogether left twenty passing tests.
 *
 * So every assertion below reads the object handed to BullMQ, not the object
 * the policy was written into. Four behaviours live here, and each one is a
 * separate way for a relay to be quietly lost:
 *
 *  - the retry policy reaching the job (without it a `durable` event gets one
 *    attempt, which is the pre-queue behaviour the queue exists to replace);
 *  - `jobId` collapsing a double-enqueue of one logical event;
 *  - the short circuit when the relay was never configured, so a permanently
 *    `disabled` outcome is not banked as a retryable job;
 *  - the single direct attempt when Redis refuses, which keeps the floor at
 *    the pre-queue behaviour instead of dropping the notification outright.
 *
 * ── The queue here says no when BullMQ says no ─────────────────────────────
 *
 * This file's double used to accept every job. The job ids it accepted —
 * `reiwa.user.notify:<cuid>`, `reiwa.dev.notify:sysevt:…` — are ids BullMQ
 * refuses, so these tests were green while every one of those events took the
 * direct fallback in production. `OfflineBullMqQueue` runs BullMQ's own
 * admission code; a producer that mints an id the library rejects fails here.
 */

interface DirectCall {
  readonly event: string;
  readonly metadata: Record<string, unknown>;
}

interface Harness {
  readonly service: ReiwaRelayQueueService;
  readonly queue: OfflineBullMqQueue<ReiwaRelayJobData>;
  readonly direct: DirectCall[];
  readonly recorded: UndeliveredRecord[];
  /** `broadcast.updateMany` calls — the channel post address being stored. */
  readonly broadcastUpdates: Array<{ where: unknown; data: unknown }>;
}

/** Prisma, as far as the channel-post bookkeeping reaches. Records every write. */
function channelPostPrisma(broadcastUpdates: Array<{ where: unknown; data: unknown }>) {
  return {
    broadcast: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        broadcastUpdates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
}

const CONFIRMED: NotifyDeliveryResult = { status: 'confirmed', messageId: 77, httpStatus: 200, detail: null };
const UNCONFIRMED: NotifyDeliveryResult = { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
const TIMED_OUT: NotifyDeliveryResult = { status: 'timeout', messageId: null, httpStatus: null, detail: 'timed out after 10000ms' };

function buildQueueService(
  opts: {
    readonly enabled?: boolean;
    /** Redis is unreachable — `queue.add` rejects. */
    readonly redisDown?: boolean;
    /** The direct fallback attempt itself throws. */
    readonly directRejects?: boolean;
    /** What the direct fallback attempt reports. Default: `unconfirmed`. */
    readonly directOutcome?: NotifyDeliveryResult;
  } = {},
): Harness {
  const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
  if (opts.redisDown === true) queue.goDown(new Error('MaxRetriesPerRequestError: Redis is down'));
  const direct: DirectCall[] = [];
  const recorded: UndeliveredRecord[] = [];
  const broadcastUpdates: Array<{ where: unknown; data: unknown }> = [];

  const botNotifier = {
    isEnabled: opts.enabled !== false,
    deliverRelayEvent: async (
      event: string,
      metadata: Record<string, unknown>,
    ): Promise<NotifyDeliveryResult> => {
      direct.push({ event, metadata });
      if (opts.directRejects === true) throw new Error('fetch failed');
      return opts.directOutcome ?? UNCONFIRMED;
    },
  };

  const service = new ReiwaRelayQueueService(
    queue.asQueue(),
    botNotifier as unknown as BotNotifierClient,
    (record) => void recorded.push(record),
    channelPostPrisma(broadcastUpdates),
  );
  return { service, queue, direct, recorded, broadcastUpdates };
}

/**
 * The delays BullMQ would schedule for this job's first `retries` retries.
 *
 * Its real `Backoffs.calculate`, fed the options the producer handed it and
 * the strategy the worker registers — the two inputs `Job.shouldRetryJob`
 * combines (it passes `attemptsMade + 1`, so the first retry is 1). Reading
 * `opts.backoff` alone would prove the options were set, not what BullMQ does
 * with them.
 */
async function scheduleBullMqWouldRun(
  call: AdmittedAdd<ReiwaRelayJobData>,
  retries: number,
): Promise<number[]> {
  const job = { data: call.data, opts: call.opts };
  const delays: number[] = [];
  for (let attemptsMade = 1; attemptsMade <= retries; attemptsMade += 1) {
    delays.push(
      Number(
        await Backoffs.calculate(
          call.opts.backoff as BackoffOptions,
          attemptsMade,
          new Error('attempt failed'),
          job as never,
          relayBackoffStrategy,
        ),
      ),
    );
  }
  return delays;
}

/** What BullMQ's BUILT-IN strategy for the policy's own type schedules. */
async function expectedSchedule(policy: RelayEventPolicy): Promise<number[]> {
  const builtin = Backoffs.builtinStrategies[policy.backoff.type](policy.backoff.delay);
  const delays: number[] = [];
  for (let attemptsMade = 1; attemptsMade < policy.attempts; attemptsMade += 1) {
    delays.push(Number(await builtin(attemptsMade)));
  }
  return delays;
}

describe('the relay queue producer puts the policy on the job, not just in a constant', () => {
  it('hands BullMQ the attempts and the backoff its policy earned, for every event', async () => {
    // Anti-emptiness anchor: a loop over an empty event list proves nothing,
    // and would be the silent way for this whole test to stop working.
    assert.equal(REIWA_RELAY_EVENTS.length, 10, 'the ten events this queue owns');

    for (const event of REIWA_RELAY_EVENTS) {
      const { service, queue, direct } = buildQueueService();
      const metadata = { eventId: `id-${event}` };

      assert.equal(await service.enqueue(event, metadata), true, event);
      assert.deepStrictEqual(queue.refused, [], `${event}: BullMQ refused the job`);
      assert.equal(queue.admitted.length, 1, `${event}: exactly one job`);
      assert.deepStrictEqual(direct, [], `${event}: a queued event makes no direct attempt`);

      const call = queue.admitted[0] as AdmittedAdd<ReiwaRelayJobData>;
      const policy = RELAY_EVENT_POLICY[event];

      assert.equal(call.name, REIWA_RELAY_JOB, event);
      assert.deepStrictEqual(call.data, { event, metadata }, `${event}: payload reaches the job`);

      // The two assertions the missing coverage was about. `attempts: 1` with
      // no `backoff` is the exact mutation that survived the old suite.
      assert.equal(
        call.opts.attempts,
        policy.attempts,
        `${event}: the policy grants ${policy.attempts} attempts; the job asks for ` +
          `${String(call.opts.attempts)}. A retry policy that never reaches queue.add is a comment.`,
      );
      assert.deepStrictEqual(
        await scheduleBullMqWouldRun(call, policy.attempts - 1),
        await expectedSchedule(policy),
        `${event}: without a backoff BullMQ retries immediately, so all ${policy.attempts} ` +
          'attempts hit the same dead cabinet inside a second and the "~105s window" is fiction',
      );
      // An event that BullMQ would only ever try once is not on a retry queue.
      assert.ok(policy.attempts > 1, `${event}: policy grants a single attempt`);

      // Failed jobs are the durable evidence of an exhausted relay; completed
      // ones are bounded so the queue cannot grow without limit.
      assert.equal(call.opts.removeOnComplete, BULLMQ_RETAINED_COMPLETED_JOBS, event);
      assert.equal(call.opts.removeOnFail, BULLMQ_RETAINED_FAILED_JOBS, event);
    }
  });

  it('separates the two shapes rather than giving every event one number', async () => {
    // Read off the job, not off the policy: if both shapes collapsed to the
    // same value the loop above would still pass, because it compares each
    // event with its own policy entry.
    const durable = buildQueueService();
    await durable.service.enqueue('reiwa.user.notify', { eventId: 'evt-1' });
    const bounded = buildQueueService();
    await bounded.service.enqueue('reiwa.branding.invalidate', { reason: 'theme' });

    const durableCall = durable.queue.admitted[0] as AdmittedAdd<ReiwaRelayJobData>;
    const boundedCall = bounded.queue.admitted[0] as AdmittedAdd<ReiwaRelayJobData>;

    assert.equal(durableCall.opts.attempts, 4);
    assert.deepStrictEqual(await scheduleBullMqWouldRun(durableCall, 3), [15_000, 30_000, 60_000]);
    assert.equal(boundedCall.opts.attempts, 2);
    assert.deepStrictEqual(await scheduleBullMqWouldRun(boundedCall, 1), [10_000]);
    assert.notDeepStrictEqual(
      await scheduleBullMqWouldRun(durableCall, 1),
      await scheduleBullMqWouldRun(boundedCall, 1),
      'a cache bust and a subscriber notification are not worth the same retry window',
    );
  });

  it('puts relay jobs on the custom backoff the worker registers', async () => {
    // A built-in type is resolved from BullMQ's own table before any custom
    // strategy is consulted, and that table never sees the error — so a
    // `Retry-After` could not reach the schedule. The worker must also be the
    // one registering the strategy the jobs name, or BullMQ throws "Unknown
    // backoff strategy" at the first retry.
    const { service, queue } = buildQueueService();
    await service.enqueue('reiwa.user.notify', { eventId: 'evt-1' });

    const backoff = (queue.admitted[0] as AdmittedAdd<ReiwaRelayJobData>).opts.backoff as { type: string };
    assert.equal(backoff.type, RELAY_BACKOFF_TYPE);
    assert.equal(backoff.type in Backoffs.builtinStrategies, false);
    // `@Processor(queue, workerOptions)` stores the options under this key
    // (`WORKER_METADATA` in `@nestjs/bullmq`), and the worker is built from it.
    const workerSettings = Reflect.getMetadata('bullmq:worker_metadata', ReiwaRelayProcessor) as
      | { readonly settings?: { readonly backoffStrategy?: unknown } }
      | undefined;
    assert.equal(workerSettings?.settings?.backoffStrategy, relayBackoffStrategy);
  });

  it('queues a subscriber notification keyed on its CUID instead of refusing it', async () => {
    // THE defect. `reiwa.user.notify:<cuid>` is two colon parts, BullMQ said
    // "Custom Id cannot contain :", and every subscriber message took the one
    // direct attempt — no retries, no record when it failed.
    const { service, queue, direct } = buildQueueService();

    const accepted = await service.enqueue('reiwa.user.notify', {
      eventId: 'cmf0notificationrow000001',
      telegramId: '12345',
      text: 'hi',
    });

    assert.deepStrictEqual(queue.refused, [], 'BullMQ refused the job id');
    assert.equal(accepted, true);
    assert.equal(queue.admitted.length, 1);
    assert.deepStrictEqual(direct, [], 'a job BullMQ took needs no direct attempt');
  });

  it('collapses an accidental double-enqueue of one logical event', async () => {
    const { service, queue, direct } = buildQueueService();
    const eventId = 'sysevt:reiwa.error:2026-08-18T09:00:00.000Z:dev-0123456789abcdef';

    await service.enqueue('reiwa.dev.notify', { eventId, text: 'card' });
    await service.enqueue('reiwa.dev.notify', { eventId, text: 'card' });

    assert.equal(queue.admitted.length, 2, 'the double-enqueue really was attempted twice');
    for (const call of queue.admitted) {
      assert.equal(
        call.jobId,
        toBullMqJobId('reiwa.dev.notify', eventId),
        'BullMQ collapses on jobId, so both calls must name the same job',
      );
    }
    assert.deepStrictEqual(
      queue.admitted.map((call) => call.collapsed),
      [false, true],
      'the second add must land on the job the first one made',
    );
    assert.equal(queue.heldIds().length, 1);
    assert.deepStrictEqual(direct, []);
  });

  it('keeps the original key in the payload, where the cabinet dedups on it', async () => {
    // The job id is the queue's name for the job and nothing more. The bot
    // claims `metadata.eventId`; a digest there would dedup on nothing.
    const { service, queue } = buildQueueService();
    const eventId = 'sysevt:payment.completed:2026-09-14T10:00:00.000Z:relay-0123456789abcdef';

    await service.enqueue('reiwa.channel.broadcast', { eventId, chatId: '-100', text: 'card' });

    const call = queue.admitted[0] as AdmittedAdd<ReiwaRelayJobData>;
    assert.equal(call.data.metadata['eventId'], eventId);
    assert.notEqual(call.jobId, eventId);
  });

  it('keys the job on the event kind as well, so two relays of one id stay apart', async () => {
    // `reiwa.dev.notify` and `reiwa.dev.notify.document` are different cabinet
    // endpoints. Keying on the bare id would let one swallow the other.
    const { service, queue } = buildQueueService();
    await service.enqueue('reiwa.dev.notify', { eventId: 'shared' });
    await service.enqueue('reiwa.dev.notify.document', { eventId: 'shared' });

    assert.equal(queue.admitted[0]?.jobId, toBullMqJobId('reiwa.dev.notify', 'shared'));
    assert.equal(queue.admitted[1]?.jobId, toBullMqJobId('reiwa.dev.notify.document', 'shared'));
    assert.deepStrictEqual(queue.admitted.map((call) => call.collapsed), [false, false]);
  });

  it('sets no jobId when the metadata carries no id to key on', async () => {
    const { service, queue } = buildQueueService();
    await service.enqueue('reiwa.bot.invalidate', { reason: 'texts' });
    // Absent, not `undefined`: BullMQ reads `opts.jobId` and an explicit
    // `undefined` would be the same thing here, but inventing a key would not.
    assert.equal(
      'jobId' in (queue.admitted[0] as AdmittedAdd<ReiwaRelayJobData>).opts,
      false,
      'a job id keyed on nothing collapses unrelated events',
    );
  });

  it('ignores a non-string id rather than keying on "[object Object]"', async () => {
    const { service, queue } = buildQueueService();
    await service.enqueue('reiwa.landing.invalidate', { eventId: 42 });
    assert.equal('jobId' in (queue.admitted[0] as AdmittedAdd<ReiwaRelayJobData>).opts, false);
  });

  it('short-circuits when the relay was never configured', async () => {
    // `disabled` is not transient: no number of attempts sets REIWA_URL. A
    // queued job could only fail, four times, and then alert an operator about
    // a link that was never asked to exist.
    const { service, queue, direct, recorded } = buildQueueService({ enabled: false });

    assert.equal(await service.enqueue('reiwa.dev.notify', { eventId: 'evt-1' }), false);
    assert.deepStrictEqual(queue.admitted, [], 'nothing banked on the queue');
    assert.deepStrictEqual(direct, [], 'and no direct attempt either');
    assert.deepStrictEqual(recorded, [], 'nothing was attempted, so nothing was lost');
  });

  it('falls back to exactly one direct attempt when Redis refuses the enqueue', async () => {
    const { service, queue, direct } = buildQueueService({ redisDown: true });
    const metadata = { eventId: 'evt-1', text: 'card', parseMode: 'HTML' };

    await service.enqueue('reiwa.dev.notify', metadata);

    assert.deepStrictEqual(queue.admitted, []);
    assert.equal(
      direct.length,
      1,
      'one attempt: the floor is the pre-queue behaviour, not a retry loop ' +
        'the producer runs itself while the caller waits',
    );
    assert.equal((direct[0] as DirectCall).event, 'reiwa.dev.notify');
    assert.deepStrictEqual(
      (direct[0] as DirectCall).metadata,
      metadata,
      'the fallback must send the same payload the job would have carried',
    );
  });

  it('never throws at the caller, even when Redis is down AND the cabinet is unreachable', async () => {
    // Every caller is a `void`-ed fanout, a post-response tap or an
    // interceptor. None of them can absorb a rejection.
    const { service, queue, direct } = buildQueueService({
      redisDown: true,
      directRejects: true,
    });

    assert.equal(await service.enqueue('reiwa.dev.notify.document', { eventId: 'evt-1' }), false);
    assert.deepStrictEqual(queue.admitted, []);
    assert.equal(direct.length, 1);
  });

  it('reports the relay as enabled exactly when the client is', () => {
    assert.equal(buildQueueService().service.isEnabled, true);
    assert.equal(buildQueueService({ enabled: false }).service.isEnabled, false);
  });
});

/**
 * What the one direct attempt proves, and what is left when it proves nothing
 * ═══════════════════════════════════════════════════════════════════════════
 * The fallback used to be read by nobody. It returned `false` whatever
 * happened — so a message the cabinet had just delivered was reported to the
 * operator as not sent, and pressing "send" again delivered it twice — and
 * when it did fail, the only trace was a log line, where an exhausted job
 * would have written `reiwa.relay_undelivered`.
 */
describe('the direct fallback is judged and recorded like a queued attempt', () => {
  it('answers true when the fallback delivered, because the message was sent', async () => {
    const { service, recorded } = buildQueueService({ redisDown: true, directOutcome: CONFIRMED });

    const inHand = await service.enqueue('reiwa.user.notify', { eventId: 'evt-1', telegramId: '1', text: 'hi' });

    assert.equal(inHand, true, 'a delivered message reported as a failure invites a duplicate');
    assert.deepStrictEqual(recorded, [], 'a delivery is not an incident');
  });

  it('judges delivery by the processor’s rule: a bodiless 204 is not a subscriber message', async () => {
    // `isRelayDelivered` demands a Telegram message id for `reiwa.user.notify`.
    // An `unconfirmed` there is overwhelmingly a blocked bot — not delivered,
    // and not an alert either (`shouldAlertOperator`), exactly as on the queue.
    const { service, recorded } = buildQueueService({ redisDown: true, directOutcome: UNCONFIRMED });

    assert.equal(await service.enqueue('reiwa.user.notify', { eventId: 'evt-1' }), false);
    assert.deepStrictEqual(recorded, [], 'per-recipient bot state is not an operator alert');
  });

  it('counts a 2xx as delivered for the events that can prove nothing more', async () => {
    const { service, recorded } = buildQueueService({ redisDown: true, directOutcome: UNCONFIRMED });

    assert.equal(await service.enqueue('reiwa.channel.broadcast', { eventId: 'evt-1' }), true);
    assert.deepStrictEqual(recorded, []);
  });

  it('records an undelivered fallback as reiwa.relay_undelivered would be recorded', async () => {
    const { service, recorded } = buildQueueService({ redisDown: true, directOutcome: TIMED_OUT });
    const metadata = { eventId: 'evt-1', text: 'card', automationChainDepth: 2 };

    const inHand = await service.enqueue('reiwa.dev.notify', metadata);

    assert.equal(inHand, false);
    assert.equal(recorded.length, 1, 'one lost relay, one record');
    const record = recorded[0] as UndeliveredRecord;
    assert.equal(record.message, 'Reiwa relay did not deliver reiwa.dev.notify (timeout)');
    assert.equal(record.metadata['relayEvent'], 'reiwa.dev.notify');
    assert.equal(record.metadata['relayStatus'], 'timeout');
    assert.equal(record.metadata['relayEventId'], 'evt-1');
    assert.equal(record.metadata['attemptsMade'], 1);
    assert.equal(record.metadata['attempts'], 1);
    // The fact that tells the operator it was Redis, and what Redis said.
    assert.match(String(record.metadata['enqueueError']), /Redis is down/);
    // And the automation hop count, handed back as the processor hands it.
    assert.equal(record.metadata['automationChainDepth'], 2);
  });

  it('records a fallback that threw instead of throwing at the caller', async () => {
    const { service, recorded } = buildQueueService({ redisDown: true, directRejects: true });

    assert.equal(await service.enqueue('reiwa.dev.notify', { eventId: 'evt-1' }), false);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.metadata['relayStatus'], 'failed');
  });

  it('still answers the caller when writing the record itself fails', async () => {
    const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
    queue.goDown();
    const service = new ReiwaRelayQueueService(
      queue.asQueue(),
      { isEnabled: true, deliverRelayEvent: async () => TIMED_OUT } as unknown as BotNotifierClient,
      () => {
        throw new Error('audit log unavailable');
      },
      channelPostPrisma([]),
    );

    assert.equal(await service.enqueue('reiwa.dev.notify', { eventId: 'evt-1' }), false);
  });

  it('stores the address of a channel post the fallback delivered, as a delivered job does', async () => {
    // The cabinet echoes the channel post's Telegram message id, and that id
    // exists only in this reply. The processor stores it; the fallback did
    // not, so a broadcast posted while Redis was down could never be edited
    // or recalled.
    const { service, broadcastUpdates } = buildQueueService({
      redisDown: true,
      directOutcome: { status: 'confirmed', messageId: 314, httpStatus: 200, detail: null },
    });

    const inHand = await service.enqueue('reiwa.channel.broadcast', {
      eventId: `${BROADCAST_CHANNEL_EVENT_PREFIX}cmf0broadcast000000000001`,
      chatId: '-1001234567890',
      text: 'Анонс',
    });

    assert.equal(inHand, true);
    assert.deepStrictEqual(broadcastUpdates, [
      {
        where: { id: 'cmf0broadcast000000000001' },
        data: { channelChatId: '-1001234567890', channelMessageId: 314n },
      },
    ]);
  });

  it('stores nothing for a fallback delivery that is not a broadcast channel post', async () => {
    const { service, broadcastUpdates } = buildQueueService({
      redisDown: true,
      directOutcome: CONFIRMED,
    });

    await service.enqueue('reiwa.user.notify', { eventId: 'evt-1', telegramId: '1', text: 'hi' });
    await service.enqueue('reiwa.channel.broadcast', { eventId: 'cmf0mirror:operator-mirror', chatId: '-100' });

    assert.deepStrictEqual(broadcastUpdates, []);
  });
});

/**
 * A Redis blip: the add timed out, and landed anyway
 * ══════════════════════════════════════════════════
 * The enqueue gives up waiting after a second, but ioredis replays the add once
 * the connection is back — so the job can land after the direct fallback ran.
 * On this relay that produced two defects: a relay delivered twice (fallback,
 * then job), and a fallback answered 503 by the cabinet — "a send with this
 * key is in flight", i.e. the job delivering — recorded as undelivered and
 * reported to the operator as a failure.
 */
describe('an enqueue that timed out and landed after all', () => {
  const METADATA = { eventId: 'cmf0notificationrow000001', telegramId: '12345', text: 'hi' };
  const JOB_ID = toBullMqJobId('reiwa.user.notify', METADATA.eventId);

  function build(cabinet: () => Promise<NotifyDeliveryResult>) {
    const queue = new ReconnectingBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
    const direct: DirectCall[] = [];
    const recorded: UndeliveredRecord[] = [];
    const service = new ReiwaRelayQueueService(
      queue.asQueue(),
      {
        isEnabled: true,
        deliverRelayEvent: async (event: string, metadata: Record<string, unknown>) => {
          direct.push({ event, metadata });
          return cabinet();
        },
      } as unknown as BotNotifierClient,
      (record) => void recorded.push(record),
      channelPostPrisma([]),
    );
    return { queue, service, direct, recorded };
  }

  it('makes no direct attempt when the job is there by the time it looks', async () => {
    const { queue, service, direct, recorded } = build(async () => CONFIRMED);
    queue.goAway();
    // Redis answers again while the producer asks for the job: the add, issued
    // first, runs first.
    queue.reconnectWhen('getJob');

    assert.equal(await service.submit('reiwa.user.notify', METADATA), 'queued');

    assert.deepStrictEqual(direct, [], 'the queue has the relay; a direct attempt would be a second one');
    assert.deepStrictEqual(queue.inner.heldIds(), [JOB_ID]);
    assert.deepStrictEqual(recorded, []);
  });

  it('withdraws the job when the direct attempt delivered and the add lands later', async () => {
    const { queue, service, direct } = build(async () => CONFIRMED);
    queue.goAway();

    assert.equal(await service.submit('reiwa.user.notify', METADATA), 'delivered');
    assert.equal(direct.length, 1);

    await queue.reconnect();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      queue.inner.heldIds(),
      [],
      'the job landed after the relay was delivered, and would have delivered it again',
    );
    assert.equal(queue.executed[0], 'add');
    assert.ok(
      queue.executed.indexOf('remove') > queue.executed.indexOf('add'),
      `the removal is queued behind the add: ${queue.executed.join(', ')}`,
    );
  });

  it('says so when a worker took the job before it could be withdrawn', async () => {
    // Redis merely slow: the add landed during the direct attempt, and a worker
    // picked the job up at once. `Queue.remove` does not throw for that — it
    // answers 0 — so the duplicate its docstring promises to log went by in
    // silence, and the job delivered the relay a second time.
    const { queue, service } = build(async () => {
      await queue.reconnect();
      queue.inner.setState(JOB_ID, 'active');
      return CONFIRMED;
    });
    const warnings: string[] = [];
    (service as unknown as { logger: { warn: (message: string) => void } }).logger.warn = (message) =>
      void warnings.push(message);
    queue.goAway();

    assert.equal(await service.submit('reiwa.user.notify', METADATA), 'delivered');
    await new Promise((resolve) => setImmediate(resolve));

    const duplicate = warnings.filter((line) => line.includes(JOB_ID));
    assert.equal(duplicate.length, 1, `one line for one duplicate: ${JSON.stringify(warnings)}`);
    assert.match(duplicate[0] as string, /held by a worker .* delivered twice/);
  });

  it('does not call a 503 undelivered when the job it collided with is there', async () => {
    const { queue, service, recorded } = build(async () => {
      // The cabinet answers while the job — replayed, picked up — holds the key.
      await queue.reconnect();
      return {
        status: 'rejected',
        messageId: null,
        httpStatus: 503,
        detail: 'HTTP 503 Service Unavailable',
        retryAfterSeconds: 2,
      };
    });
    queue.goAway();

    const submission = await service.submit('reiwa.user.notify', METADATA);

    assert.equal(submission, 'queued', 'the job owns the relay; the operator must not hear "failed"');
    assert.deepStrictEqual(recorded, [], 'no false reiwa.relay_undelivered');
  });

  it('still records a miss when the job never landed', async () => {
    const { queue, service, recorded } = build(async () => TIMED_OUT);
    queue.goAway();

    assert.equal(await service.submit('reiwa.user.notify', METADATA), 'lost-alerted');
    assert.equal(recorded.length, 1);
    assert.match(String(recorded[0]?.metadata['enqueueError']), /timed out/);
  });
});

/**
 * A broadcast's channel post the fallback lost
 * ════════════════════════════════════════════
 * Two things are owed for it: a card that names it, and a broadcast page that
 * does not present it as a public copy. "Recorded" promised the first and was
 * not always true — a record the alert gate only counted produced no card — and
 * the second was never done: the page read a lost post as "published, cannot
 * address it" and told the operator to delete by hand a post nobody made.
 */
describe('a channel post the direct fallback could not deliver', () => {
  const postOf = (broadcastId: string) => ({
    eventId: `${BROADCAST_CHANNEL_EVENT_PREFIX}${broadcastId}`,
    chatId: '-1001234567890',
    text: 'Анонс',
    parseMode: 'HTML',
  });
  const UNREACHABLE: NotifyDeliveryResult = { status: 'failed', messageId: null, httpStatus: null, detail: 'fetch failed' };

  function build(outcome: NotifyDeliveryResult, recorder: (record: UndeliveredRecord) => 'alerted' | 'counted') {
    const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
    queue.goDown();
    const broadcastUpdates: Array<{ where: unknown; data: unknown }> = [];
    const service = new ReiwaRelayQueueService(
      queue.asQueue(),
      { isEnabled: true, deliverRelayEvent: async () => outcome } as unknown as BotNotifierClient,
      recorder,
      channelPostPrisma(broadcastUpdates),
    );
    return { service, broadcastUpdates };
  }

  it('says whether the card went out or the loss was only counted', async () => {
    // The caller — the broadcast pipeline — raises its own card exactly when
    // none named the post. It cannot do that from "recorded".
    const alerted = build(UNREACHABLE, () => 'alerted');
    assert.equal(await alerted.service.submit('reiwa.channel.broadcast', postOf('cmf0broadcastA')), 'lost-alerted');

    const counted = build(UNREACHABLE, () => 'counted');
    assert.equal(await counted.service.submit('reiwa.channel.broadcast', postOf('cmf0broadcastB')), 'lost-counted');
  });

  it('records a post that certainly never went up as no post at all', async () => {
    for (const outcome of [
      UNREACHABLE,
      { status: 'rejected', messageId: null, httpStatus: 422, detail: 'HTTP 422 Unprocessable Entity: Bad Request: chat not found' },
      { status: 'rejected', messageId: null, httpStatus: 401, detail: 'HTTP 401 Unauthorized' },
    ] as const) {
      const { service, broadcastUpdates } = build(outcome, () => 'alerted');

      await service.submit('reiwa.channel.broadcast', postOf('cmf0broadcastA'));

      assert.deepStrictEqual(
        broadcastUpdates,
        [{ where: { id: 'cmf0broadcastA', channelMessageId: null }, data: { channelChatId: '-1001234567890' } }],
        `${outcome.status} ${outcome.httpStatus ?? ''}: the chat alone reads "no post" on the broadcast page`,
      );
    }
  });

  it('leaves a post that may have gone up as it was', async () => {
    // After a timeout or a 5xx the cabinet or the bot may have posted it after
    // the panel stopped waiting: "cannot be addressed, check the channel" is
    // still the honest answer, and "no post" would hide a public copy.
    for (const outcome of [
      TIMED_OUT,
      { status: 'rejected', messageId: null, httpStatus: 502, detail: 'HTTP 502 Bad Gateway' },
    ] as const) {
      const { service, broadcastUpdates } = build(outcome, () => 'alerted');

      await service.submit('reiwa.channel.broadcast', postOf('cmf0broadcastA'));

      assert.deepStrictEqual(broadcastUpdates, [], `${outcome.status}`);
    }
  });

  it('writes nothing for a relay that is not a broadcast channel post', async () => {
    const { service, broadcastUpdates } = build(UNREACHABLE, () => 'alerted');

    await service.submit('reiwa.channel.broadcast', { ...postOf('x'), eventId: 'cmf0mirror:operator-mirror' });
    await service.submit('reiwa.user.notify', { eventId: 'cmf0notification', telegramId: '1', text: 'hi' });

    assert.deepStrictEqual(broadcastUpdates, []);
  });
});

/**
 * The Users page "send message" button, end to end through the real producer
 * ═════════════════════════════════════════════════════════════════════════
 * The operator's view of the two defects above. With the id refused, the
 * message went out on the fallback, the fallback delivered it, and the page
 * still said «Очередь Telegram недоступна» — so the operator pressed again.
 */
describe('the operator hears what happened to a Telegram message', () => {
  function buildUsersPage(relay: Harness) {
    const prisma = {
      userNotificationEvent: { create: async () => ({ id: 'cmf0operatormessage000001' }) },
      user: {
        findUnique: async () => ({
          telegramId: 12345n,
          isBotBlocked: false,
          name: 'Nina',
          username: null,
        }),
      },
      settings: { findUnique: async () => ({ systemNotifications: {} }) },
    };
    return new UserNotificationsService(
      prisma as never,
      { getByType: async () => null } as never,
      { notifyUser: async () => undefined } as never,
      { isConfigured: async () => false, countSubscriptions: async () => 0 } as never,
      { substituteTelegramHtml: async (t: string) => t, substituteFallbacks: async (t: string) => t } as never,
      relay.service,
    );
  }

  it('reports delivered when the message is queued', async () => {
    const relay = buildQueueService();
    const page = buildUsersPage(relay);

    const result = await page.sendOperatorMessage({ userId: 'user-1', text: 'Привет', channels: ['telegram'] });

    assert.equal(result.outcomes.find((o) => o.channel === 'telegram')?.status, 'delivered');
    assert.deepStrictEqual(relay.queue.refused, [], 'BullMQ refused the subscriber message');
    assert.deepStrictEqual(relay.direct, []);
  });

  it('reports delivered when Redis refused it but the direct attempt delivered it', async () => {
    const relay = buildQueueService({ redisDown: true, directOutcome: CONFIRMED });
    const page = buildUsersPage(relay);

    const result = await page.sendOperatorMessage({ userId: 'user-1', text: 'Привет', channels: ['telegram'] });

    assert.equal(relay.direct.length, 1);
    assert.equal(
      result.outcomes.find((o) => o.channel === 'telegram')?.status,
      'delivered',
      'the message reached the subscriber; «failed» here is what made operators send it twice',
    );
  });

  it('reports failed, and records it, when neither road delivered', async () => {
    const relay = buildQueueService({ redisDown: true, directOutcome: TIMED_OUT });
    const page = buildUsersPage(relay);

    const result = await page.sendOperatorMessage({ userId: 'user-1', text: 'Привет', channels: ['telegram'] });

    const telegram = result.outcomes.find((o) => o.channel === 'telegram');
    assert.equal(telegram?.status, 'failed');
    assert.equal(telegram?.reason, 'relayUnavailable');
    assert.equal(relay.recorded.length, 1);
  });
});
