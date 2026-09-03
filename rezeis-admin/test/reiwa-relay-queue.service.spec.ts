import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Queue } from 'bullmq';

import {
  BULLMQ_RETAINED_COMPLETED_JOBS,
  BULLMQ_RETAINED_FAILED_JOBS,
} from '../src/common/queue/bullmq-enqueue-options';
import {
  REIWA_RELAY_EVENTS,
  REIWA_RELAY_JOB,
  type ReiwaRelayJobData,
} from '../src/modules/notifications/reiwa-relay.constants';
import { RELAY_EVENT_POLICY } from '../src/modules/notifications/reiwa-relay.policy';
import type {
  BotNotifierClient,
  NotifyDeliveryResult,
} from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

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
 */

interface AddCall {
  readonly name: string;
  readonly data: ReiwaRelayJobData;
  readonly opts: Record<string, unknown>;
}

interface DirectCall {
  readonly event: string;
  readonly metadata: Record<string, unknown>;
}

interface Harness {
  readonly service: ReiwaRelayQueueService;
  readonly added: AddCall[];
  readonly direct: DirectCall[];
}

function buildQueueService(
  opts: {
    readonly enabled?: boolean;
    /** Redis is unreachable — `queue.add` rejects. */
    readonly addRejects?: boolean;
    /** The direct fallback attempt itself throws. */
    readonly directRejects?: boolean;
  } = {},
): Harness {
  const added: AddCall[] = [];
  const direct: DirectCall[] = [];

  const queue = {
    add: async (
      name: string,
      data: ReiwaRelayJobData,
      jobOpts: Record<string, unknown>,
    ): Promise<{ id: string }> => {
      if (opts.addRejects === true) throw new Error('MaxRetriesPerRequestError: Redis is down');
      added.push({ name, data, opts: jobOpts });
      return { id: 'job-1' };
    },
  };

  const botNotifier = {
    isEnabled: opts.enabled !== false,
    deliverRelayEvent: async (
      event: string,
      metadata: Record<string, unknown>,
    ): Promise<NotifyDeliveryResult> => {
      direct.push({ event, metadata });
      if (opts.directRejects === true) throw new Error('fetch failed');
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };

  const service = new ReiwaRelayQueueService(
    queue as unknown as Queue<ReiwaRelayJobData>,
    botNotifier as unknown as BotNotifierClient,
  );
  return { service, added, direct };
}

describe('the relay queue producer puts the policy on the job, not just in a constant', () => {
  it('hands BullMQ the attempts and the backoff its policy earned, for every event', async () => {
    // Anti-emptiness anchor: a loop over an empty event list proves nothing,
    // and would be the silent way for this whole test to stop working.
    assert.equal(REIWA_RELAY_EVENTS.length, 10, 'the ten events this queue owns');

    for (const event of REIWA_RELAY_EVENTS) {
      const { service, added } = buildQueueService();
      const metadata = { eventId: `id-${event}` };

      assert.equal(await service.enqueue(event, metadata), true, event);
      assert.equal(added.length, 1, `${event}: exactly one job`);

      const call = added[0] as AddCall;
      const policy = RELAY_EVENT_POLICY[event];

      assert.equal(call.name, REIWA_RELAY_JOB, event);
      assert.deepStrictEqual(call.data, { event, metadata }, `${event}: payload reaches the job`);

      // The two assertions the missing coverage was about. `attempts: 1` with
      // no `backoff` is the exact mutation that survived the old suite.
      assert.equal(
        call.opts['attempts'],
        policy.attempts,
        `${event}: the policy grants ${policy.attempts} attempts; the job asks for ` +
          `${String(call.opts['attempts'])}. A retry policy that never reaches queue.add is a comment.`,
      );
      assert.deepStrictEqual(
        call.opts['backoff'],
        { type: policy.backoff.type, delay: policy.backoff.delay },
        `${event}: without a backoff BullMQ retries immediately, so all ${policy.attempts} ` +
          'attempts hit the same dead cabinet inside a second and the "~105s window" is fiction',
      );
      // An event that BullMQ would only ever try once is not on a retry queue.
      assert.ok(policy.attempts > 1, `${event}: policy grants a single attempt`);

      // Failed jobs are the durable evidence of an exhausted relay; completed
      // ones are bounded so the queue cannot grow without limit.
      assert.equal(call.opts['removeOnComplete'], BULLMQ_RETAINED_COMPLETED_JOBS, event);
      assert.equal(call.opts['removeOnFail'], BULLMQ_RETAINED_FAILED_JOBS, event);
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

    const durableOpts = (durable.added[0] as AddCall).opts;
    const boundedOpts = (bounded.added[0] as AddCall).opts;

    assert.equal(durableOpts['attempts'], 4);
    assert.deepStrictEqual(durableOpts['backoff'], { type: 'exponential', delay: 15_000 });
    assert.equal(boundedOpts['attempts'], 2);
    assert.deepStrictEqual(boundedOpts['backoff'], { type: 'fixed', delay: 10_000 });
    assert.notDeepStrictEqual(
      durableOpts['backoff'],
      boundedOpts['backoff'],
      'a cache bust and a subscriber notification are not worth the same retry window',
    );
  });

  it('collapses an accidental double-enqueue of one logical event', async () => {
    const { service, added } = buildQueueService();
    const eventId = 'sysevt:reiwa.error:2026-08-18T09:00:00.000Z:dev-0123456789abcdef';

    await service.enqueue('reiwa.dev.notify', { eventId, text: 'card' });
    await service.enqueue('reiwa.dev.notify', { eventId, text: 'card' });

    assert.equal(added.length, 2, 'the double-enqueue really was attempted twice');
    for (const call of added) {
      assert.equal(
        call.opts['jobId'],
        `reiwa.dev.notify:${eventId}`,
        'BullMQ collapses on jobId, so both calls must name the same job',
      );
    }
  });

  it('keys the job on the event kind as well, so two relays of one id stay apart', async () => {
    // `reiwa.dev.notify` and `reiwa.dev.notify.document` are different cabinet
    // endpoints. Keying on the bare id would let one swallow the other.
    const { service, added } = buildQueueService();
    await service.enqueue('reiwa.dev.notify', { eventId: 'shared' });
    await service.enqueue('reiwa.dev.notify.document', { eventId: 'shared' });

    assert.equal((added[0] as AddCall).opts['jobId'], 'reiwa.dev.notify:shared');
    assert.equal((added[1] as AddCall).opts['jobId'], 'reiwa.dev.notify.document:shared');
  });

  it('sets no jobId when the metadata carries no id to key on', async () => {
    const { service, added } = buildQueueService();
    await service.enqueue('reiwa.bot.invalidate', { reason: 'texts' });
    // Absent, not `undefined`: BullMQ reads `opts.jobId` and an explicit
    // `undefined` would be the same thing here, but inventing a key would not.
    assert.equal(
      'jobId' in (added[0] as AddCall).opts,
      false,
      'a job id keyed on nothing collapses unrelated events',
    );
  });

  it('ignores a non-string id rather than keying on "[object Object]"', async () => {
    const { service, added } = buildQueueService();
    await service.enqueue('reiwa.landing.invalidate', { eventId: 42 });
    assert.equal('jobId' in (added[0] as AddCall).opts, false);
  });

  it('short-circuits when the relay was never configured', async () => {
    // `disabled` is not transient: no number of attempts sets REIWA_URL. A
    // queued job could only fail, four times, and then alert an operator about
    // a link that was never asked to exist.
    const { service, added, direct } = buildQueueService({ enabled: false });

    assert.equal(await service.enqueue('reiwa.dev.notify', { eventId: 'evt-1' }), false);
    assert.deepStrictEqual(added, [], 'nothing banked on the queue');
    assert.deepStrictEqual(direct, [], 'and no direct attempt either');
  });

  it('falls back to exactly one direct attempt when Redis refuses the enqueue', async () => {
    const { service, added, direct } = buildQueueService({ addRejects: true });
    const metadata = { eventId: 'evt-1', text: 'card', parseMode: 'HTML' };

    const accepted = await service.enqueue('reiwa.dev.notify', metadata);

    assert.equal(accepted, false, 'false means "not durable", never "delivered"');
    assert.deepStrictEqual(added, []);
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
    const { service, added, direct } = buildQueueService({
      addRejects: true,
      directRejects: true,
    });

    assert.equal(await service.enqueue('reiwa.dev.notify.document', { eventId: 'evt-1' }), false);
    assert.deepStrictEqual(added, []);
    assert.equal(direct.length, 1);
  });

  it('reports the relay as enabled exactly when the client is', () => {
    assert.equal(buildQueueService().service.isEnabled, true);
    assert.equal(buildQueueService({ enabled: false }).service.isEnabled, false);
  });
});
