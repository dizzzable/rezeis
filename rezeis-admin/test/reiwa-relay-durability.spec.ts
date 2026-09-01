import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnrecoverableError } from 'bullmq';

import {
  REIWA_RELAY_EVENTS,
  type ReiwaRelayEvent,
} from '../src/modules/notifications/reiwa-relay.constants';
import {
  RELAY_EVENT_POLICY,
  isRelayDelivered,
  isRelayLoopGuardedEvent,
  shouldAlertOperator,
} from '../src/modules/notifications/reiwa-relay.policy';
import { ReiwaRelayProcessor } from '../src/modules/notifications/reiwa-relay.processor';
import type { NotifyDeliveryResult } from '../src/modules/notifications/services/bot-notifier.client';

/**
 * Durable panel -> cabinet relay
 * ══════════════════════════════
 * Nine event kinds used to go out on a single `fetch` whose result every caller
 * dropped. The queue replaces that, and the two decisions that make it work
 * are both easy to get wrong in ways nothing would notice:
 *
 *  1. WHAT COUNTS AS DELIVERED. The backup relay — the one path that already
 *     did this properly — demands `status === 'confirmed'`. Copying that rule
 *     onto these nine would hang eight of them forever, because the cabinet
 *     answers `200 { messageId }` for `reiwa.user.notify` alone and a bodiless
 *     `204` for the rest (`api/routes/webhooks.ts`, "Response contract"), and
 *     `deliver()` maps a 204 to `unconfirmed`. `confirmed` is unreachable for
 *     those eight by construction, so "retry until confirmed" is "retry until
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
  it('accepts a bare 2xx for the eight events the cabinet answers with 204', async () => {
    const ackOnly = REIWA_RELAY_EVENTS.filter((e) => e !== 'reiwa.user.notify');
    assert.equal(ackOnly.length, 8);
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
    // The four cache hints self-heal at a 60s (policy/legal) or 5-minute
    // (bot-config) TTL. A third attempt lands after the TTL already fixed it,
    // so it busts a cache that is no longer stale.
    for (const event of [
      'reiwa.bot.invalidate',
      'reiwa.platform.policy_invalidated',
      'reiwa.branding.invalidate',
      'reiwa.landing.invalidate',
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
    {
      warn: (type: string, _category: string, message: string, metadata?: Record<string, unknown>) => {
        emitted.push({ type, message, metadata });
      },
    } as never,
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
    // if the outcome is one `shouldAlertOperator` would card. Anything else
    // sharing that bin is something an operator has to scroll past to reach
    // the incident, and on a platform with churn there is far more of it.
    const cases: ReadonlyArray<{
      readonly event: ReiwaRelayEvent;
      readonly result: NotifyDeliveryResult;
    }> = [
      { event: 'reiwa.user.notify', result: outcome('unconfirmed', { httpStatus: 204 }) },
      { event: 'reiwa.user.notify', result: outcome('timeout') },
      { event: 'reiwa.user.notify', result: outcome('failed') },
      { event: 'reiwa.user.notify', result: outcome('rejected', { httpStatus: 401 }) },
      { event: 'reiwa.user.notify', result: outcome('disabled') },
      { event: 'reiwa.dev.notify', result: outcome('rejected', { httpStatus: 400 }) },
      { event: 'reiwa.branding.invalidate', result: outcome('failed') },
    ];

    for (const { event, result } of cases) {
      const { processor } = buildProcessor(result);
      const label = `${event} / ${result.status}`;
      // Last attempt, so nothing is being retried and every case has reached
      // its terminal decision.
      if (shouldAlertOperator(event, result)) {
        await assert.rejects(
          () => processor.process(job(event, 3, 4)),
          `${label}: an alertable failure must land in the retained failed set`,
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
