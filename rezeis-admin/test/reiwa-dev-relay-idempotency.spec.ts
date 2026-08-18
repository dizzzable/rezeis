import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { RELAY_EVENT_POLICY } from '../src/modules/notifications/reiwa-relay.policy';
import { ReiwaRelayProcessor } from '../src/modules/notifications/reiwa-relay.processor';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * The dev firehose can finally tell a retry from a new alert
 * ══════════════════════════════════════════════════════════
 * `reiwa.dev.notify` and `reiwa.dev.notify.document` are `durable`: four
 * attempts, because the operator error firehose going quiet during an incident
 * is the worst outcome on the queue. Retrying an unconfirmed delivery is only
 * safe if the far end can recognise the replay — and the cabinet could, all
 * along. `claimDevEvent(scope, eventId)` in the bot's internal HTTP listener
 * dedups both routes, scoped per endpoint, and the cabinet's zod schema has
 * carried an optional `eventId` for them for a while.
 *
 * The panel simply never sent one, so the dedup keyed on `undefined` and did
 * nothing. Every retry of a dev alert produced a second card. This pins the
 * producer side of that contract, and the two properties that make it work:
 *
 *  1. THE KEY IS MINTED ONCE, and every BullMQ attempt carries that same value.
 *     A key recomputed per attempt is a key the cabinet claims as new each
 *     time, which is the same as having none.
 *
 *  2. TWO DIFFERENT EVENTS DO NOT COLLIDE. The key is also the BullMQ `jobId`
 *     (`ReiwaRelayQueueService.enqueue`), so a collision does not merely
 *     duplicate — it makes the second card vanish before it is ever queued.
 *     The firehose's characteristic traffic is a burst of same-type errors out
 *     of one failing loop, which really can share a millisecond.
 */

interface Relayed {
  readonly event: string;
  readonly metadata: Record<string, unknown>;
}

function buildService(
  telegram: Record<string, unknown>,
): { service: SystemEventsService; queued: Relayed[]; direct: Relayed[] } {
  const queued: Relayed[] = [];
  const direct: Relayed[] = [];

  const notifier = {
    deliverRelayEvent: async (event: string, metadata: Record<string, unknown>) => {
      direct.push({ event, metadata });
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string, metadata: Record<string, unknown>) => {
      queued.push({ event, metadata });
      return true;
    },
  };
  const prisma = {
    settings: {
      findFirst: async () => ({ systemNotifications: { telegram } }),
    },
    adminAuditLog: { create: async () => ({}) },
  };
  const httpService = {
    post: () => {
      throw new Error('Bot API must not be called without a token');
    },
  };
  const moduleRef = {
    get: (token: unknown) => {
      if (token === BotNotifierClient) return notifier;
      if (token === ReiwaRelayQueueService) return relayQueue;
      throw new Error('not registered');
    },
  };

  const service = new SystemEventsService(
    prisma as never,
    { enabled: false, urls: [] } as never,
    httpService as never,
    moduleRef as never,
  );
  return { service, queued, direct };
}

/** Delivery is unconditionally fire-and-forget; let the microtasks settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Dev fallback with the `.txt` attachment on — the document route. */
const DEV_WITH_TXT = {
  enabled: false,
  chatId: null,
  devChatId: '813364774',
  errorReports: { mode: 'manual', telegramTxt: true },
};

/** Dev fallback with the attachment off — the inline-card route. */
const DEV_CARD_ONLY = {
  enabled: false,
  chatId: null,
  devChatId: '813364774',
  errorReports: { mode: 'manual', telegramTxt: false },
};

function eventIdOf(relayed: Relayed | undefined): string {
  const value = relayed?.metadata['eventId'];
  assert.equal(typeof value, 'string', `expected an eventId on ${relayed?.event ?? '(nothing)'}`);
  return value as string;
}

describe('the panel stamps a dedup key on both dev relays', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('stamps one on the inline card', async () => {
    const { service, queued } = buildService(DEV_CARD_ONLY);
    service.info('system.heartbeat', 'SYSTEM', 'tick');
    await flush();

    assert.deepStrictEqual(
      queued.map((q) => q.event),
      ['reiwa.dev.notify'],
    );
    const id = eventIdOf(queued[0]);
    assert.ok(id.startsWith('sysevt:system.heartbeat:'), id);
  });

  it('stamps one on the document', async () => {
    const { service, queued } = buildService(DEV_WITH_TXT);
    service.error('reiwa.error', 'SYSTEM', '[reiwa:bot] boom', { source: 'bot', stack: 'at x' });
    await flush();

    assert.deepStrictEqual(
      queued.map((q) => q.event),
      ['reiwa.dev.notify.document'],
    );
    const id = eventIdOf(queued[0]);
    assert.ok(id.startsWith('sysevt:reiwa.error:'), id);
    // The document still carries everything it carried before the key.
    assert.equal(queued[0]?.metadata['parseMode'], 'HTML');
    assert.ok(String(queued[0]?.metadata['filename']).startsWith('error_'));
  });

  it('keeps the flag in the retry policy honest about it', () => {
    // The policy said `botDedupKeyed: false` for these two and named the fix as
    // cabinet-side. It was producer-side. This is the pair of facts moving
    // together, which is the whole point of recording the flag.
    assert.equal(RELAY_EVENT_POLICY['reiwa.dev.notify'].botDedupKeyed, true);
    assert.equal(RELAY_EVENT_POLICY['reiwa.dev.notify.document'].botDedupKeyed, true);
  });

  it('is born from the event, not from the clock at send time', async () => {
    // Two independent emits of the SAME event — same type, same emit
    // timestamp, same payload — separated by real wall-clock time. Anything
    // that read `Date.now()` while building the key would differ here, and a
    // key that differs per send is a key the cabinet claims as new every time.
    const timestamp = '2026-08-18T09:00:00.000Z';
    const payload = {
      type: 'reiwa.error',
      category: 'SYSTEM',
      severity: 'ERROR',
      message: '[reiwa:bot] boom',
      metadata: { source: 'bot' },
      timestamp,
    } as const;

    const first = buildService(DEV_CARD_ONLY);
    first.service.emit({ ...payload });
    await flush();

    const second = buildService(DEV_CARD_ONLY);
    second.service.emit({ ...payload });
    await flush();

    assert.equal(
      eventIdOf(first.queued[0]),
      eventIdOf(second.queued[0]),
      'the same event has to produce the same key, or a retry is indistinguishable from news',
    );
    assert.ok(eventIdOf(first.queued[0]).includes(timestamp), 'the emit timestamp, not the send');
  });

  it('hands every BullMQ attempt the identical key', async () => {
    // The property that actually matters, checked through the real consumer:
    // the queue freezes the metadata into the job payload, and each attempt
    // replays that payload. Attempt two must present the cabinet with the same
    // key attempt one did, or the dedup has nothing to match.
    const { service, queued } = buildService(DEV_WITH_TXT);
    service.error('reiwa.error', 'SYSTEM', '[reiwa:api] kaput', { source: 'api' });
    await flush();

    const job = queued[0] as Relayed;
    const seen: Array<Record<string, unknown>> = [];
    const processor = new ReiwaRelayProcessor(
      {
        deliverRelayEvent: async (_event: string, metadata: Record<string, unknown>) => {
          seen.push(metadata);
          return { status: 'timeout', messageId: null, httpStatus: null, detail: null };
        },
      } as never,
      { warn: () => undefined } as never,
    );

    // BullMQ re-runs the processor over the SAME `job.data` on every attempt.
    const jobData = { event: job.event, metadata: job.metadata };
    for (const attemptsMade of [0, 1, 2, 3]) {
      await assert.rejects(() =>
        processor.process({
          id: 'job-1',
          data: jobData,
          attemptsMade,
          opts: { attempts: RELAY_EVENT_POLICY['reiwa.dev.notify.document'].attempts },
        } as never),
      );
    }

    assert.equal(seen.length, 4, 'four attempts, as the durable policy grants');
    const keys = new Set(seen.map((m) => m['eventId']));
    assert.equal(
      keys.size,
      1,
      `every attempt must carry one key; saw ${[...keys].map(String).join(', ')}`,
    );
    assert.equal([...keys][0], eventIdOf(job), 'and it is the key the producer minted');
  });

  it('does not collapse two different events that share a millisecond', async () => {
    // A burst out of one failing loop really can emit inside a single
    // millisecond, and `sysevt:${type}:${timestamp}` alone cannot tell those
    // two apart. `enqueue` turns the key into the BullMQ `jobId`, so a
    // collision does not duplicate the card — it deletes the second one.
    const timestamp = '2026-08-18T09:00:00.000Z';
    const { service, queued } = buildService(DEV_CARD_ONLY);

    service.emit({
      type: 'reiwa.error',
      category: 'SYSTEM',
      severity: 'ERROR',
      message: 'node 1 unreachable',
      metadata: { node: 1 },
      timestamp,
    });
    service.emit({
      type: 'reiwa.error',
      category: 'SYSTEM',
      severity: 'ERROR',
      message: 'node 2 unreachable',
      metadata: { node: 2 },
      timestamp,
    });
    await flush();

    assert.equal(queued.length, 2);
    assert.notEqual(
      eventIdOf(queued[0]),
      eventIdOf(queued[1]),
      'two distinct alerts in one millisecond must not share a job id',
    );
  });

  it('does collapse a genuinely identical card', async () => {
    // The other half of the same decision: when the event really is the same
    // event, one card is the right answer.
    const timestamp = '2026-08-18T09:00:00.000Z';
    const { service, queued } = buildService(DEV_CARD_ONLY);
    const payload = {
      type: 'reiwa.error',
      category: 'SYSTEM',
      severity: 'ERROR',
      message: 'node 1 unreachable',
      metadata: { node: 1 },
      timestamp,
    } as const;

    service.emit({ ...payload });
    service.emit({ ...payload });
    await flush();

    assert.equal(queued.length, 2);
    assert.equal(eventIdOf(queued[0]), eventIdOf(queued[1]));
  });

  it('keys the card route apart from the document route', async () => {
    const timestamp = '2026-08-18T09:00:00.000Z';
    const payload = {
      type: 'reiwa.error',
      category: 'SYSTEM',
      severity: 'ERROR',
      message: '[reiwa:bot] boom',
      metadata: { source: 'bot' },
      timestamp,
    } as const;

    const card = buildService(DEV_CARD_ONLY);
    card.service.emit({ ...payload });
    const document = buildService(DEV_WITH_TXT);
    document.service.emit({ ...payload });
    await flush();

    assert.equal(card.queued[0]?.event, 'reiwa.dev.notify');
    assert.equal(document.queued[0]?.event, 'reiwa.dev.notify.document');
    assert.notEqual(eventIdOf(card.queued[0]), eventIdOf(document.queued[0]));
  });

  it('stays inside the 128 characters the cabinet will accept', async () => {
    // `eventIdSchema` is `z.string().trim().min(1).max(128)` and the dev routes
    // apply it as `.optional().catch(undefined)`. An over-long key therefore
    // fails SILENTLY: the cabinet drops the field and the event degrades to
    // exactly the undeduped state this change exists to end. Event types are
    // caller-supplied — automation rules and the reiwa ingest both mint them at
    // runtime — so the bound has to survive a hostile one.
    const { service, queued } = buildService(DEV_CARD_ONLY);
    service.emit({
      type: `reiwa.ingest.${'x'.repeat(400)}`,
      category: 'SYSTEM',
      severity: 'ERROR',
      message: 'y'.repeat(2_000),
      metadata: { blob: 'z'.repeat(5_000) },
      timestamp: '2026-08-18T09:00:00.000Z',
    });
    await flush();

    const id = eventIdOf(queued[0]);
    assert.ok(id.length >= 1 && id.length <= 128, `eventId is ${id.length} chars: ${id}`);
    assert.equal(id.trim(), id, 'the cabinet trims before it measures');
  });

  it('leaves the loop-guarded alert on the direct road, key and all', async () => {
    // `reiwa.relay_undelivered` must not re-enter the queue it reports on. It
    // still gets a key: the direct client is one attempt, but the bot's cache
    // is what stops a duplicate if the same alert is emitted twice.
    const { service, queued, direct } = buildService(DEV_CARD_ONLY);
    service.warn('reiwa.relay_undelivered', 'SYSTEM', 'Reiwa relay did not deliver', {
      relayEvent: 'reiwa.user.notify',
      relayStatus: 'timeout',
    });
    await flush();

    assert.deepStrictEqual(queued, []);
    assert.deepStrictEqual(
      direct.map((d) => d.event),
      ['reiwa.dev.notify'],
    );
    assert.ok(eventIdOf(direct[0]).startsWith('sysevt:reiwa.relay_undelivered:'));
  });
});
