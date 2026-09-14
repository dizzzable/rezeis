import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Backoffs, UnrecoverableError, type BackoffOptions } from 'bullmq';

import {
  REIWA_RELAY_EVENTS,
  REIWA_RELAY_QUEUE,
  type ReiwaRelayEvent,
  type ReiwaRelayJobData,
} from '../src/modules/notifications/reiwa-relay.constants';
import {
  RELAY_EVENT_POLICY,
  RELAY_RETRY_AFTER_CEILING_SECONDS,
  isDevRelayDeadEnd,
  isRecipientRefusal,
  isRelayDelivered,
  isRelayLoopGuardedEvent,
  shouldAlertOperator,
  shouldFailRelayJob,
} from '../src/modules/notifications/reiwa-relay.policy';
import {
  emitRelayUndelivered,
  ReiwaRelayProcessor,
  ReiwaRelayRetryError,
  relayBackoffStrategy,
} from '../src/modules/notifications/reiwa-relay.processor';
import {
  BotNotifierClient,
  REFUSAL_DETAIL_LIMIT,
  type NotifyDeliveryResult,
} from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * Durable panel -> cabinet relay
 * ══════════════════════════════
 * Nine event kinds used to go out on a single `fetch` whose result every caller
 * dropped. The queue replaces that, and the two decisions that make it work
 * are both easy to get wrong in ways nothing would notice:
 *
 *  1. WHAT COUNTS AS DELIVERED. The backup relay — the one path that already
 *     did this properly — demands `status === 'confirmed'`. Copying that rule
 *     onto these ten would hang nine of them forever, because the cabinet
 *     answers `200 { messageId }` for `reiwa.user.notify` alone and a bodiless
 *     `204` for the rest (`api/routes/webhooks.ts`, "Response contract"), and
 *     `deliver()` maps a 204 to `unconfirmed`. `confirmed` is unreachable for
 *     those nine by construction, so "retry until confirmed" is "retry until
 *     the attempts run out", every time, for every event, forever. It would
 *     look like a working queue: jobs enqueue, jobs retry, alerts fire.
 *
 *  2. THE LOOP. The processor reports an exhausted job by emitting a system
 *     event, and `SystemEventsService.emit` fans every event out to Telegram
 *     through this same queue. Nothing stops that eating itself while the
 *     cabinet is down except the guard.
 */

function outcome(
  status: NotifyDeliveryResult['status'],
  extra: Partial<NotifyDeliveryResult> = {},
): NotifyDeliveryResult {
  return { status, messageId: null, httpStatus: null, detail: null, ...extra };
}

describe('what the relay queue treats as delivered', () => {
  it('accepts a bare 2xx for the nine events the cabinet answers with 204', async () => {
    const ackOnly = REIWA_RELAY_EVENTS.filter((e) => e !== 'reiwa.user.notify');
    assert.equal(ackOnly.length, 9);
    for (const event of ackOnly) {
      assert.equal(
        isRelayDelivered(event, outcome('unconfirmed', { httpStatus: 204 })),
        true,
        `${event}: a 204 is the whole of what the cabinet promises for this event; ` +
          'demanding a message id would retry every one of them to exhaustion',
      );
    }
  });

  it('demands a Telegram message id for the one event that can produce one', () => {
    assert.equal(isRelayDelivered('reiwa.user.notify', outcome('confirmed', { messageId: 42 })), true);
    // 204 here is a blocked recipient, a non-Telegram id, or a payload the bot
    // refused — every one of them means the subscriber got nothing.
    assert.equal(isRelayDelivered('reiwa.user.notify', outcome('unconfirmed')), false);
  });

  it('gives every event a policy, and retries only what a retry can still fix', () => {
    for (const event of REIWA_RELAY_EVENTS) {
      const policy = RELAY_EVENT_POLICY[event as ReiwaRelayEvent];
      assert.ok(policy, `${event} has no retry policy`);
      assert.ok(policy.attempts >= 1);
    }
    // The five cache hints self-heal at a 60s (policy/legal/connect-page) or
    // 5-minute (bot-config) TTL. A third attempt lands after the TTL already fixed it,
    // so it busts a cache that is no longer stale.
    for (const event of [
      'reiwa.bot.invalidate',
      'reiwa.platform.policy_invalidated',
      'reiwa.branding.invalidate',
      'reiwa.landing.invalidate',
      'reiwa.connect-page.invalidate',
    ] as const) {
      assert.equal(RELAY_EVENT_POLICY[event].durability, 'bounded', event);
      assert.equal(RELAY_EVENT_POLICY[event].attempts, 2, event);
      assert.ok(
        RELAY_EVENT_POLICY[event].backoff.delay < 60_000,
        `${event}: a retry that lands after the 60s TTL cannot be the thing that fixes it`,
      );
    }
    // Nothing else self-heals: a lost user notification is a message nobody
    // ever receives, and a lost dev card is an outage nobody is told about.
    for (const event of [
      'reiwa.user.notify',
      'reiwa.channel.broadcast',
      'reiwa.channel.broadcast.document',
      'reiwa.dev.notify',
      'reiwa.dev.notify.document',
    ] as const) {
      assert.equal(RELAY_EVENT_POLICY[event].durability, 'durable', event);
      assert.ok(RELAY_EVENT_POLICY[event].attempts > 2, event);
    }
  });

  it('lets no retried event go out without a key the bot can dedup on', () => {
    // This used to pin the opposite for the two dev events, and blamed the
    // cabinet's zod schema for `/notify-dev`. That reading was wrong in a way
    // worth keeping visible: the cabinet had accepted an OPTIONAL `eventId`
    // on both dev routes for a while, and dedups on it via `claimDevEvent`.
    // The producer was the half that sent nothing, so the cabinet's cache
    // keyed on `undefined` and every retry posted a second card.
    // `SystemEventsService.deliverToReiwaDev` mints one now — see
    // `test/reiwa-dev-relay-idempotency.spec.ts`, which holds up the claim
    // this flag makes.
    assert.equal(RELAY_EVENT_POLICY['reiwa.dev.notify'].botDedupKeyed, true);
    assert.equal(RELAY_EVENT_POLICY['reiwa.dev.notify.document'].botDedupKeyed, true);
    assert.equal(RELAY_EVENT_POLICY['reiwa.user.notify'].botDedupKeyed, true);
    assert.equal(RELAY_EVENT_POLICY['reiwa.channel.broadcast'].botDedupKeyed, true);

    // Stated as the rule rather than four facts: a `durable` event is one the
    // queue will re-send up to four times, and re-sending a Telegram message
    // the far end cannot recognise is how one lost alert becomes four cards.
    // Every producer of a durable event stamps a key today — the notification
    // CUID, `broadcast-channel:${id}`, `sysevt:...` — so there is no longer an
    // exception to write down.
    const durable = Object.entries(RELAY_EVENT_POLICY).filter(
      ([, policy]) => policy.durability === 'durable',
    );
    assert.equal(durable.length, 5, 'the five events worth retrying');
    for (const [event, policy] of durable) {
      assert.equal(
        policy.botDedupKeyed,
        true,
        `${event}: retried ${policy.attempts} times with nothing for the bot to dedup on`,
      );
    }

    // The cache busts carry no key and need none: replaying a bust drops an
    // already-dropped cache, so there is no duplicate for a key to prevent.
    for (const [event, policy] of Object.entries(RELAY_EVENT_POLICY)) {
      if (policy.durability === 'durable') continue;
      assert.equal(policy.botDedupKeyed, false, event);
    }
  });

  it('holds the operator alert back for routine per-recipient facts only', () => {
    // A blocked recipient is not something an operator can act on, and the bot
    // already reports it out of band by flipping `User.isBotBlocked`.
    assert.equal(shouldAlertOperator('reiwa.user.notify', outcome('unconfirmed')), false);
    // Everything else is a fact about the link between the two hosts, which is
    // exactly what an operator has no way to see today.
    assert.equal(shouldAlertOperator('reiwa.user.notify', outcome('timeout')), true);
    assert.equal(shouldAlertOperator('reiwa.dev.notify', outcome('unconfirmed')), true);
    assert.equal(shouldAlertOperator('reiwa.branding.invalidate', outcome('rejected')), true);
  });

  it('guards exactly the system event that would feed itself', () => {
    assert.equal(isRelayLoopGuardedEvent('reiwa.relay_undelivered'), true);
    assert.equal(isRelayLoopGuardedEvent('reiwa.error'), false);
    assert.equal(isRelayLoopGuardedEvent('system.error'), false);
  });
});

// ── processor ────────────────────────────────────────────────────────────────

interface Emitted {
  readonly type: string;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}

function buildProcessor(result: NotifyDeliveryResult) {
  const emitted: Emitted[] = [];
  const delivered: Array<{ event: string; metadata: Record<string, unknown> }> = [];
  const processor = new ReiwaRelayProcessor(
    {
      deliverRelayEvent: async (event: string, metadata: Record<string, unknown>) => {
        delivered.push({ event, metadata });
        return result;
      },
    } as never,
    // The recorder WITHOUT the alert gate: these cases are about what the
    // processor decides for one job, so every record it hands over is
    // emitted. Coalescing across jobs is `undelivered-alert-gate.spec.ts`.
    (record) =>
      emitRelayUndelivered(
        {
          warn: (type: string, _category: string, message: string, metadata?: Record<string, unknown>) => {
            emitted.push({ type, message, metadata });
          },
        },
        record,
      ),
    // The channel-post recorder's Prisma. These events are never
    // `reiwa.channel.broadcast`, so it returns before touching it — but the
    // dependency is real and `tsc -p tsconfig.test.json` (which CI runs, and
    // `npm test` does not) is what noticed.
    { broadcast: { updateMany: async () => ({ count: 0 }) } } as never,
  );
  return { processor, emitted, delivered };
}

function job(event: ReiwaRelayEvent, attemptsMade: number, attempts: number) {
  return {
    id: 'job-1',
    data: { event, metadata: { eventId: 'evt-1' } },
    attemptsMade,
    opts: { attempts },
  } as never;
}

describe('the relay processor has one exit per thing that can be true', () => {
  it('completes the job when the attempt delivered', async () => {
    const { processor, emitted } = buildProcessor(outcome('confirmed', { messageId: 9 }));

    const out = await processor.process(job('reiwa.user.notify', 0, 4));

    assert.equal(out.delivered, true);
    assert.deepStrictEqual(emitted, [], 'a delivery is not an incident');
  });

  it('throws without alerting while attempts remain, so BullMQ retries', async () => {
    // BullMQ retries a processor that THROWS. Returning a tally is how
    // `backup.deliver-telegram` had `attempts: 3` that never once fired.
    const { processor, emitted } = buildProcessor(outcome('timeout'));

    await assert.rejects(() => processor.process(job('reiwa.user.notify', 0, 4)));
    assert.deepStrictEqual(
      emitted,
      [],
      'attempt two may well deliver; one alert per attempt is three alerts for one loss',
    );
  });

  it('records and alerts once the attempts are spent', async () => {
    // `attemptsMade` counts attempts that have already failed, so 3 of 4 is the
    // last one running.
    const { processor, emitted } = buildProcessor(outcome('timeout'));

    await assert.rejects(() => processor.process(job('reiwa.user.notify', 3, 4)));

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'reiwa.relay_undelivered');
    assert.equal(emitted[0]?.metadata?.['relayEvent'], 'reiwa.user.notify');
    assert.equal(emitted[0]?.metadata?.['relayStatus'], 'timeout');
    // The audit-log row carries the key, so a lost notification can be traced
    // back to the `UserNotificationEvent` it belonged to.
    assert.equal(emitted[0]?.metadata?.['relayEventId'], 'evt-1');
  });

  it('gives up immediately on a permanent failure instead of burning the attempts', async () => {
    // A refused signature or a payload the bot rejects answers identically ten
    // seconds later. `UnrecoverableError` is how BullMQ is told not to bother.
    const { processor, emitted } = buildProcessor(
      outcome('rejected', { httpStatus: 401, detail: 'HTTP 401 Unauthorized' }),
    );

    await assert.rejects(
      () => processor.process(job('reiwa.dev.notify', 0, 4)),
      (err: unknown) => err instanceof UnrecoverableError,
    );
    assert.equal(emitted.length, 1, 'a permanently refused firehose is the operator to fix');
  });

  it('completes without alerting on a recipient who blocked the bot', async () => {
    // Neither an alert nor a slot in the failed set. This outcome is a fact
    // about one subscriber's relationship with the bot, and it is the
    // highest-VOLUME undelivered outcome the queue produces — every blocked
    // subscriber makes one per notification. It used to fail the job, which
    // put it in the bounded `removeOnFail` set and churned that set until the
    // jobs worth reading (a relay that burned its attempts while the cabinet
    // was down) had been pushed out of it.
    const { processor, emitted } = buildProcessor(outcome('unconfirmed', { httpStatus: 204 }));

    const out = await processor.process(job('reiwa.user.notify', 0, 4));

    // Completed, and honest about it: the terminal state answers "is anything
    // more coming?", the return value answers "did it arrive?".
    assert.equal(out.delivered, false, 'completing must not be allowed to claim a delivery');
    assert.equal(out.status, 'unconfirmed');
    assert.deepStrictEqual(emitted, []);
  });

  it('leaves the bounded failed set holding exactly the failures worth reading', async () => {
    // Stated as the invariant rather than as one case, because the value of
    // `removeOnFail` is entirely in what it retains: a job fails if and only
    // if the outcome is a failure of the LINK (`shouldFailRelayJob`). Anything
    // else sharing that bin is something an operator has to scroll past to
    // reach the incident, and on a platform with churn there is far more of it.
    const cases: ReadonlyArray<{
      readonly event: ReiwaRelayEvent;
      readonly result: NotifyDeliveryResult;
      readonly fails: boolean;
    }> = [
      { event: 'reiwa.user.notify', result: outcome('unconfirmed', { httpStatus: 204 }), fails: false },
      { event: 'reiwa.user.notify', result: outcome('timeout'), fails: true },
      { event: 'reiwa.user.notify', result: outcome('failed'), fails: true },
      { event: 'reiwa.user.notify', result: outcome('rejected', { httpStatus: 401 }), fails: true },
      { event: 'reiwa.user.notify', result: outcome('rejected', { httpStatus: 422 }), fails: false },
      { event: 'reiwa.user.notify', result: outcome('disabled'), fails: true },
      { event: 'reiwa.channel.broadcast', result: outcome('rejected', { httpStatus: 422 }), fails: false },
      { event: 'reiwa.dev.notify', result: outcome('rejected', { httpStatus: 400 }), fails: true },
      { event: 'reiwa.dev.notify', result: outcome('rejected', { httpStatus: 422 }), fails: false },
      { event: 'reiwa.branding.invalidate', result: outcome('failed'), fails: true },
    ];

    for (const { event, result, fails } of cases) {
      const { processor } = buildProcessor(result);
      const label = `${event} / ${result.status} ${result.httpStatus ?? ''}`;
      // The expectation is written out, not derived: a predicate asked to
      // agree with itself cannot go red.
      assert.equal(shouldFailRelayJob(event, result), fails, `${label}: shouldFailRelayJob`);
      // Last attempt, so nothing is being retried and every case has reached
      // its terminal decision.
      if (fails) {
        await assert.rejects(
          () => processor.process(job(event, 3, 4)),
          `${label}: a link failure must land in the retained failed set`,
        );
      } else {
        const out = await processor.process(job(event, 3, 4));
        assert.equal(
          out.delivered,
          false,
          `${label}: completing a job the relay did not deliver must still say so`,
        );
      }
    }
  });

  it('completes a message Telegram refused, and still tells the operator why', async () => {
    // A template Telegram will not parse is refused once per subscriber. Each
    // refusal used to fail its job with `UnrecoverableError`, so one broken
    // template pushed every link failure out of a failed set bounded at 100.
    for (const event of ['reiwa.user.notify', 'reiwa.channel.broadcast'] as const) {
      const { processor, emitted } = buildProcessor(
        outcome('rejected', {
          httpStatus: 422,
          detail: "HTTP 422 Unprocessable Entity: Bad Request: can't parse entities",
        }),
      );

      const out = await processor.process(job(event, 0, 4));

      assert.deepStrictEqual(out, { event, status: 'rejected', delivered: false });
      assert.equal(emitted.length, 1, `${event}: a refusal is still something to fix`);
      assert.equal(emitted[0]?.type, 'reiwa.relay_undelivered');
      assert.match(String(emitted[0]?.metadata?.['detail']), /can't parse entities/);
    }
  });

  it('treats a 204 as success for the events the cabinet only ever acks', async () => {
    const { processor, emitted, delivered } = buildProcessor(
      outcome('unconfirmed', { httpStatus: 204 }),
    );

    const out = await processor.process(job('reiwa.branding.invalidate', 0, 2));

    assert.equal(out.delivered, true);
    assert.deepStrictEqual(emitted, []);
    assert.equal(delivered[0]?.event, 'reiwa.branding.invalidate');
  });
});

/**
 * A dev relay that reaches nobody
 * ═══════════════════════════════
 * The dev route is the fallback for an install with no operator chat, and the
 * cabinet answers it two ways that mean nobody is there: 424 when its bot has
 * no `BOT_DEV_ID`, and 422 when Telegram refused the card to that `BOT_DEV_ID`
 * — an account that never started the bot. On such an install EVERY system
 * event gets that answer, and alerting on it wrote a `reiwa.relay_undelivered`
 * per event whose own card took the same route to the same dead end. Quiet and
 * terminal instead; and only on the dev routes.
 */
describe('a dev relay that reaches nobody', () => {
  const NOBODY = outcome('rejected', { httpStatus: 424, detail: 'HTTP 424 Failed Dependency' });
  const NEVER_STARTED = outcome('rejected', {
    httpStatus: 422,
    detail: "HTTP 422 Unprocessable Entity: Forbidden: bot can't initiate conversation with a user",
  });

  it('completes without an alert, for both dev routes and both answers', async () => {
    for (const event of ['reiwa.dev.notify', 'reiwa.dev.notify.document'] as const) {
      for (const answer of [NOBODY, NEVER_STARTED]) {
        const { processor, emitted } = buildProcessor(answer);
        const label = `${event} / ${answer.httpStatus}`;

        const out = await processor.process(job(event, 0, 4));

        assert.equal(out.delivered, false, `${label}: completing must not claim a delivery`);
        assert.equal(out.status, 'rejected');
        assert.deepStrictEqual(emitted, [], `${label}: an alert down the route that is broken`);
        assert.equal(shouldAlertOperator(event, answer), false, label);
      }
    }
  });

  it('stays narrow: a 424 or a 422 on any other route still alerts', async () => {
    const elsewhere = buildProcessor(NOBODY);
    await assert.rejects(() => elsewhere.processor.process(job('reiwa.channel.broadcast', 0, 4)));
    assert.equal(elsewhere.emitted.length, 1, 'a 424 on the operator route is not this case');

    // A subscriber message Telegram refused is a template to fix: alerted,
    // though the job completes (see `shouldFailRelayJob`).
    const refused = buildProcessor(NEVER_STARTED);
    await refused.processor.process(job('reiwa.user.notify', 0, 4));
    assert.equal(refused.emitted.length, 1);

    assert.equal(isDevRelayDeadEnd('reiwa.user.notify', NOBODY), false);
    assert.equal(isDevRelayDeadEnd('reiwa.channel.broadcast', NEVER_STARTED), false);
    assert.equal(isDevRelayDeadEnd('reiwa.dev.notify', outcome('rejected', { httpStatus: 400 })), false);
  });

  it('is quiet on the producer’s direct fallback too', async () => {
    for (const answer of [NOBODY, NEVER_STARTED]) {
      const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
      queue.goDown();
      const recorded: unknown[] = [];
      const service = new ReiwaRelayQueueService(
        queue.asQueue(),
        { isEnabled: true, deliverRelayEvent: async () => answer } as unknown as BotNotifierClient,
        (record) => void recorded.push(record),
        { broadcast: { updateMany: async () => ({ count: 0 }) } } as never,
      );

      assert.equal(await service.submit('reiwa.dev.notify', { eventId: 'evt-1' }), 'lost-unrecorded');
      assert.deepStrictEqual(recorded, [], `${answer.httpStatus}`);
    }
  });

  /**
   * A card Telegram refused to a recipient who takes others is not a dead end.
   * "can't parse entities", "message is too long": on an install whose only
   * channel is the dev DM, the error report is simply gone — and it went with
   * a debug line and no audit row, because every dev-route 422 was read as
   * "nobody there".
   */
  const PAYLOAD_REFUSALS = [
    "HTTP 422 Unprocessable Entity: Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 12",
    'HTTP 422 Unprocessable Entity: Bad Request: message is too long',
    'HTTP 422 Unprocessable Entity: Bad Request: message caption is too long',
    'HTTP 422 Unprocessable Entity: Telegram refused the message',
  ];

  it('records a refusal of the card itself, on both dev routes, and still completes the job', async () => {
    for (const event of ['reiwa.dev.notify', 'reiwa.dev.notify.document'] as const) {
      for (const detail of PAYLOAD_REFUSALS) {
        const answer = outcome('rejected', { httpStatus: 422, detail });
        const { processor, emitted } = buildProcessor(answer);

        const out = await processor.process(job(event, 0, 4));

        assert.equal(emitted.length, 1, `${event} / ${detail}: the lost card leaves a trace`);
        assert.equal(emitted[0]?.metadata?.['detail'], detail);
        assert.equal(out.delivered, false, 'a verdict on one card, not on the link: the job completes');
      }
    }
  });

  it('records it on the producer’s direct fallback too', async () => {
    const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
    queue.goDown();
    const recorded: unknown[] = [];
    const service = new ReiwaRelayQueueService(
      queue.asQueue(),
      {
        isEnabled: true,
        deliverRelayEvent: async () => outcome('rejected', { httpStatus: 422, detail: PAYLOAD_REFUSALS[1] as string }),
      } as unknown as BotNotifierClient,
      (record) => void recorded.push(record),
      { broadcast: { updateMany: async () => ({ count: 0 }) } } as never,
    );

    assert.equal(await service.submit('reiwa.dev.notify', { eventId: 'evt-1' }), 'lost-alerted');
    assert.equal(recorded.length, 1);
  });

  it('tells a refusal of the recipient from a refusal of the payload by Telegram’s words', () => {
    for (const recipient of [
      "Forbidden: bot can't initiate conversation with a user",
      'Forbidden: bot was blocked by the user',
      'Forbidden: user is deactivated',
      'Forbidden: bot was kicked from the supergroup chat',
      'Bad Request: chat not found',
      'Bad Request: user not found',
      'Bad Request: PEER_ID_INVALID',
      'Bad Request: not enough rights to send text messages to the chat',
    ]) {
      assert.equal(isRecipientRefusal(`HTTP 422 Unprocessable Entity: ${recipient}`), true, recipient);
    }
    for (const payload of [...PAYLOAD_REFUSALS, 'Bad Request: BUTTON_URL_INVALID', null]) {
      assert.equal(isRecipientRefusal(payload), false, String(payload));
    }
  });
});

/**
 * A flood-wait the retry used to walk straight into
 * ═════════════════════════════════════════════════
 * When Telegram throttles the bot, the cabinet answers 503 with `Retry-After`.
 * The relay read the 503 as transient and retried on its fixed schedule —
 * 15s, 30s, 60s — so a wait longer than about 105s spent every attempt inside
 * it and ended in an operator alert for a message that only needed patience.
 */
describe('the relay retry honours the cabinet’s Retry-After', () => {
  let savedFetch: typeof globalThis.fetch;
  let savedUrl: string | undefined;
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedUrl = process.env.REIWA_URL;
    savedSecret = process.env.WEBHOOK_SECRET_HEADER;
    process.env.REIWA_URL = 'https://cabinet.invalid';
    process.env.WEBHOOK_SECRET_HEADER = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.REIWA_URL;
    else process.env.REIWA_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.WEBHOOK_SECRET_HEADER;
    else process.env.WEBHOOK_SECRET_HEADER = savedSecret;
  });

  function answer(status: number, headers: Record<string, string> = {}): void {
    globalThis.fetch = (async () =>
      new Response(null, { status, statusText: 'x', headers })) as typeof globalThis.fetch;
  }

  interface RelayJob {
    readonly data: ReiwaRelayJobData;
    readonly opts: { readonly backoff?: unknown };
  }

  /** The job the real producer hands BullMQ for `event`. */
  async function jobFor(event: ReiwaRelayEvent): Promise<RelayJob> {
    const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
    const service = new ReiwaRelayQueueService(
      queue.asQueue(),
      { isEnabled: true } as unknown as BotNotifierClient,
      () => undefined,
      { broadcast: { updateMany: async () => ({ count: 0 }) } } as never,
    );
    await service.enqueue(event, { eventId: 'evt-1' });
    const added = queue.admitted[0];
    assert.ok(added, 'the producer queued nothing');
    return { data: added.data, opts: added.opts };
  }

  /** What BullMQ's own `Backoffs.calculate` schedules after the attempt that threw `err`. */
  async function nextDelay(relayJob: RelayJob, attemptsMade: number, err: Error): Promise<number> {
    return Number(
      await Backoffs.calculate(
        relayJob.opts.backoff as BackoffOptions,
        attemptsMade,
        err,
        relayJob as never,
        relayBackoffStrategy,
      ),
    );
  }

  it('reads the wait off a 503, and names none when the cabinet sent none', async () => {
    answer(503, { 'Retry-After': '120' });
    const throttled = await new BotNotifierClient().deliverRelayEvent('reiwa.user.notify', { eventId: 'e' });
    assert.equal(throttled.status, 'rejected');
    assert.equal(throttled.httpStatus, 503);
    assert.equal(throttled.retryAfterSeconds, 120);

    answer(502);
    const broken = await new BotNotifierClient().deliverRelayEvent('reiwa.user.notify', { eventId: 'e' });
    assert.equal('retryAfterSeconds' in broken, false, 'no header, no field: the old shape');
  });

  it('never lets reading the header turn a refusal into a retried failure', async () => {
    // The read sits inside `deliver()`'s try, whose catch answers `failed` —
    // transient, so retried. A 422 misfiled that way is three more attempts at
    // a message Telegram refuses every time.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      get headers(): never {
        throw new TypeError('no headers on this response');
      },
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;

    const refused = await new BotNotifierClient().deliverRelayEvent('reiwa.channel.broadcast', { eventId: 'e' });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.httpStatus, 422);
  });

  it('carries the wait on the error BullMQ hands to the backoff', async () => {
    const { processor, emitted } = buildProcessor(
      outcome('rejected', { httpStatus: 503, retryAfterSeconds: 120 }),
    );

    await assert.rejects(
      () => processor.process(job('reiwa.user.notify', 0, 4)),
      (err: unknown) => err instanceof ReiwaRelayRetryError && err.retryAfterSeconds === 120,
    );
    assert.deepStrictEqual(emitted, [], 'a wait is not yet a loss');
  });

  it('schedules the next attempt after the wait, not inside it', async () => {
    const relayJob = await jobFor('reiwa.user.notify');
    const flood = new ReiwaRelayRetryError('reiwa relay reiwa.user.notify rejected', 120);

    assert.equal(
      await nextDelay(relayJob, 1, flood),
      121_000,
      'a retry at 15s inside a 120s flood-wait earns another 503; one second of slack past the wait',
    );
  });

  it('changes nothing when no wait was named', async () => {
    const durable = await jobFor('reiwa.user.notify');
    const bounded = await jobFor('reiwa.branding.invalidate');
    const plain = new ReiwaRelayRetryError('reiwa relay timeout', null);

    assert.deepStrictEqual(
      [
        await nextDelay(durable, 1, plain),
        await nextDelay(durable, 2, plain),
        await nextDelay(durable, 3, plain),
      ],
      [15_000, 30_000, 60_000],
    );
    assert.equal(await nextDelay(bounded, 1, plain), 10_000);
    // An error that is not the relay's own (a crash inside the processor)
    // carries no wait either.
    assert.equal(await nextDelay(durable, 1, new Error('boom')), 15_000);
  });

  it('keeps its own backoff when that is already the longer wait', async () => {
    const relayJob = await jobFor('reiwa.user.notify');
    assert.equal(await nextDelay(relayJob, 3, new ReiwaRelayRetryError('x', 5)), 60_000);
  });

  it('caps an absurd wait, so a throttle that never lifts still ends in an alert', async () => {
    const relayJob = await jobFor('reiwa.dev.notify');
    assert.equal(
      await nextDelay(relayJob, 1, new ReiwaRelayRetryError('x', 86_400)),
      (RELAY_RETRY_AFTER_CEILING_SECONDS + 1) * 1_000,
    );
  });
});

/**
 * Why Telegram said no
 * ════════════════════
 * The cabinet answers a refused message `422 { message, detail }`, `detail`
 * being Telegram's own description. The panel read the status and dropped the
 * body, so the operator's card said "HTTP 422" for a broken template, a bad
 * button URL and a chat the bot left alike — and the alert gate, which tells
 * causes apart by their reason, would have had none to go on.
 */
describe('the reason a refusal carries', () => {
  let savedFetch: typeof globalThis.fetch;
  let savedUrl: string | undefined;
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedUrl = process.env.REIWA_URL;
    savedSecret = process.env.WEBHOOK_SECRET_HEADER;
    process.env.REIWA_URL = 'https://cabinet.invalid';
    process.env.WEBHOOK_SECRET_HEADER = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.REIWA_URL;
    else process.env.REIWA_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.WEBHOOK_SECRET_HEADER;
    else process.env.WEBHOOK_SECRET_HEADER = savedSecret;
  });

  function answer(status: number, body: string): void {
    globalThis.fetch = (async () =>
      new Response(body, {
        status,
        statusText: status === 422 ? 'Unprocessable Entity' : 'Bad Gateway',
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })) as typeof globalThis.fetch;
  }

  const deliver = () => new BotNotifierClient().deliverRelayEvent('reiwa.user.notify', { eventId: 'e' });

  it('reads the cabinet’s detail into the outcome, and on into the operator’s record', async () => {
    answer(422, JSON.stringify({ message: 'telegram refused the message', detail: "Bad Request: can't parse entities" }));

    const refused = await deliver();

    assert.equal(refused.status, 'rejected', 'still a permanent refusal');
    assert.equal(refused.httpStatus, 422);
    assert.equal(refused.detail, "HTTP 422 Unprocessable Entity: Bad Request: can't parse entities");

    const { processor, emitted } = buildProcessor(refused);
    await processor.process(job('reiwa.user.notify', 0, 4));
    assert.equal(
      emitted[0]?.metadata?.['detail'],
      "HTTP 422 Unprocessable Entity: Bad Request: can't parse entities",
      'the card shows `detail`: the reason has to be in it',
    );
  });

  it('keeps at most 300 characters of it', async () => {
    answer(422, JSON.stringify({ detail: `Bad Request: ${'x'.repeat(5_000)}` }));

    const refused = await deliver();
    const reason = String(refused.detail).slice('HTTP 422 Unprocessable Entity: '.length);

    assert.equal(REFUSAL_DETAIL_LIMIT, 300);
    assert.equal(reason.length, 300);
    assert.ok(reason.endsWith('…'), 'a clipped reason says it was clipped');
  });

  it('takes a string detail only, and never lets the body cost the refusal', async () => {
    for (const body of [
      JSON.stringify({ detail: { nested: 'object' } }),
      JSON.stringify({ detail: 42 }),
      JSON.stringify({ detail: '   ' }),
      JSON.stringify({ message: 'telegram refused the message' }),
      JSON.stringify(['detail']),
      '<html><body>502 Bad Gateway</body></html>',
      '',
    ]) {
      answer(422, body);
      const refused = await deliver();
      assert.equal(refused.status, 'rejected', body);
      assert.equal(refused.detail, 'HTTP 422 Unprocessable Entity', body);
    }

    // A body that cannot even be read is no reason, not a `failed` attempt:
    // `failed` is transient, and a 422 retried is refused three more times.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: new Headers(),
      text: async () => {
        throw new TypeError('body stream already read');
      },
    })) as unknown as typeof globalThis.fetch;
    const unreadable = await deliver();
    assert.equal(unreadable.status, 'rejected');
    assert.equal(unreadable.detail, 'HTTP 422 Unprocessable Entity');
  });
});
