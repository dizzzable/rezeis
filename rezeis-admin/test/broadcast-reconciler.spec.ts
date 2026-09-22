import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastReconcilerService } from '../src/modules/broadcast/services/broadcast-reconciler.service';
import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * The reconciler puts stranded broadcasts back in the queue.
 *
 * It had no tests at all, and the one guard that stops it fighting a healthy
 * send — "is a start job already pending?" — was dead for a release because the
 * producer never assigned the id the guard looks up. So the class that exists
 * to rescue a broadcast could instead pile a second full set of batch jobs onto
 * one that was working. Every test below is about NOT doing that.
 */

function build(options: {
  readonly scheduled?: ReadonlyArray<{ id: string; scheduledAt: Date }>;
  readonly processing?: ReadonlyArray<{ id: string }>;
  readonly pendingCount?: number;
  /** Rows of ANY status. Defaults to the pending count — i.e. staging ran. */
  readonly totalCount?: number;
  readonly pendingStart?: ReadonlySet<string>;
  /** A real event bus instead of the recording stub, for what the cards say. */
  readonly systemEvents?: SystemEventsService;
}) {
  const enqueued: string[] = [];
  const events: Array<{ severity: string; type: string; message: string }> = [];
  const statusWrites: Array<Record<string, unknown>> = [];
  const finalized: string[] = [];
  const prisma = {
    broadcast: {
      findMany: async ({ where }: { where: { status: BroadcastStatus } }) =>
        where.status === BroadcastStatus.SCHEDULED
          ? [...(options.scheduled ?? [])]
          : [...(options.processing ?? [])],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        statusWrites.push(data);
        return { count: 1 };
      },
    },
    broadcastMessage: {
      // OBEYS which question it is asked. A fake that answered the same number
      // for "how many are pending" and "how many rows exist at all" would make
      // the two dead ends indistinguishable — and telling them apart is the
      // whole of the fix.
      count: async (args?: { where?: { status?: string } }) =>
        args?.where?.status === undefined
          ? (options.totalCount ?? options.pendingCount ?? 0)
          : (options.pendingCount ?? 0),
    },
  };
  const queue = {
    hasPendingStart: async (id: string) => (options.pendingStart ?? new Set<string>()).has(id),
    enqueueStart: async (data: { broadcastId: string }) => {
      enqueued.push(data.broadcastId);
      return 'job';
    },
  };
  const systemEvents = {
    info: (type: string, _s: string, message = '') => events.push({ severity: 'info', type, message }),
    warn: (type: string, _s: string, message = '') => events.push({ severity: 'warn', type, message }),
    error: (type: string, _s: string, message = '') => events.push({ severity: 'error', type, message }),
  };
  const delivery = {
    checkAndFinalize: async (id: string) => {
      finalized.push(id);
    },
  };
  return {
    enqueued,
    events,
    statusWrites,
    finalized,
    service: new BroadcastReconcilerService(
      prisma as never,
      queue as never,
      (options.systemEvents ?? systemEvents) as never,
      delivery as never,
    ),
  };
}

/**
 * The real `SystemEventsService` on the dev-fallback road, keeping every card
 * it renders: an incident card rides as the caption of its `.txt`, any other
 * card as plain text.
 */
function cardCapturingEvents(): { readonly events: SystemEventsService; readonly cards: string[] } {
  const cards: string[] = [];
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') cards.push(String(meta['text']));
    else if (event === 'reiwa.dev.notify.document') cards.push(String(meta['caption']));
  };
  const events = new SystemEventsService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: { telegram: { enabled: false, chatId: null, devChatId: null } },
        }),
      },
      adminAuditLog: { create: async () => ({}) },
    } as never,
    { enabled: false, urls: [] } as never,
    {
      post: () => {
        throw new Error('Bot API must not be called without a token');
      },
    } as never,
    {
      get: (token: unknown) => {
        if (token === ReiwaRelayQueueService) {
          return {
            enqueue: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return true;
            },
          };
        }
        throw new Error('not registered');
      },
    } as never,
  );
  return { events, cards };
}

const longAgo = new Date(Date.now() - 24 * 60 * 60_000);

describe('the reconciler leaves healthy sends alone', () => {
  it('does not revive an overdue schedule whose job is still queued', async () => {
    // The job may simply be late — a worker that was down comes back and the
    // queue promotes it. Only a schedule with NO job behind it is lost.
    const { service, enqueued } = build({
      scheduled: [{ id: 'b-1', scheduledAt: longAgo }],
      pendingStart: new Set(['b-1']),
    });

    await service.reconcile();

    assert.deepStrictEqual(enqueued, [], 'queued a second start job on top of a live one');
  });

  it('does not revive a broadcast whose recipients are all settled', async () => {
    // Nothing left to send: it is waiting for its finaliser, not for a job.
    const { service, enqueued, finalized } = build({
      processing: [{ id: 'b-2' }],
      pendingCount: 0,
      totalCount: 400,
    });

    await service.reconcile();

    assert.deepStrictEqual(enqueued, []);
    // And it ASKS for the finalise instead of walking away. Left as a bare
    // `continue`, a broadcast whose last batch settled without finalising sat
    // at 0/400 PROCESSING for ever with no work anywhere left to move it.
    assert.deepStrictEqual(finalized, ['b-2']);
  });
});

describe('a broadcast that was claimed but never staged is not left in limbo', () => {
  it('fails it loudly instead of skipping it for ever', async () => {
    // THE DEAD END. Staging claims DRAFT -> PROCESSING before it resolves the
    // audience, so a container killed in that window leaves PROCESSING with no
    // recipient rows at all — not a throw, so nothing caught it. The start
    // job's retry then resumes, finds nothing pending, and completes green.
    // This loop skipped it as "waiting for its finaliser": nobody was ever
    // messaged, and no alert existed anywhere.
    const { service, statusWrites, events, enqueued, finalized } = build({
      processing: [{ id: 'b-7' }],
      pendingCount: 0,
      totalCount: 0,
    });

    await service.reconcile();

    assert.equal(statusWrites[0]?.status, BroadcastStatus.FAILED);
    assert.equal(enqueued.length, 0, 'a claimed broadcast cannot be staged again');
    assert.deepStrictEqual(finalized, [], 'there is nothing to finalise');
    const reported = events.find((event) => event.severity === 'error');
    assert.ok(reported, 'it failed silently, which is what made it invisible');
    assert.ok(
      /channel/i.test(reported.message),
      'the operator is not warned that the public channel may already carry it',
    );
  });
});

describe('the reconciler rescues what is genuinely stranded', () => {
  it('re-enqueues an overdue schedule with no job behind it', async () => {
    const { service, enqueued } = build({ scheduled: [{ id: 'b-3', scheduledAt: longAgo }] });

    await service.reconcile();

    assert.deepStrictEqual(enqueued, ['b-3']);
  });

  it('re-enqueues a long-stalled send that still owes recipients', async () => {
    const { service, enqueued } = build({ processing: [{ id: 'b-4' }], pendingCount: 42 });

    await service.reconcile();

    assert.deepStrictEqual(enqueued, ['b-4']);
  });

  it('gives up loudly rather than reviving for ever', async () => {
    const { service, enqueued, events } = build({
      scheduled: [{ id: 'b-5', scheduledAt: longAgo }],
    });

    for (let i = 0; i < 5; i += 1) await service.reconcile();

    assert.equal(enqueued.length, 3, 'the revival cap did not hold');
    assert.equal(events[events.length - 1]?.severity, 'error');
  });

  it('gives up ONCE — not again on every pass after', async () => {
    // The give-up card says «Автоматически её больше не перезапустят» and the
    // broadcast keeps its status, so every later pass finds it stranded again.
    // The counter just kept counting, and the card went out again every ten
    // minutes for as long as nobody touched the broadcast. Both rescues.
    const stranded = [
      build({ scheduled: [{ id: 'b-12', scheduledAt: longAgo }] }),
      build({ processing: [{ id: 'b-13' }], pendingCount: 12, totalCount: 400 }),
    ];
    for (const { service, enqueued, events } of stranded) {
      for (let i = 0; i < 6; i += 1) await service.reconcile();

      assert.equal(
        events.filter((event) => event.severity === 'error').length,
        1,
        `the give-up card was repeated: ${events.map((event) => event.severity).join(', ')}`,
      );
      assert.equal(enqueued.length, 3, 'revived again after giving up');
    }
  });
});

describe('the reconciler does not speak in the finaliser voice', () => {
  it('never raises the broadcast-sent card for a rescue', async () => {
    // That type renders as 📢 «Рассылка отправлена» and fires the broadcast-sent
    // webhook — so a rescue notice reached the operator titled as a successful
    // send, mid-flight.
    const { service, events } = build({ scheduled: [{ id: 'b-6', scheduledAt: longAgo }] });

    // Five passes, so BOTH voices are exercised: the warning on each revival and
    // the error once the cap is reached. The error path had the wrong type and
    // a single pass never reached it.
    for (let i = 0; i < 5; i += 1) await service.reconcile();

    assert.ok(events.length > 0, 'the rescue was silent');
    assert.ok(
      events.some((event) => event.severity === 'error'),
      'the give-up path was never exercised',
    );
    for (const event of events) {
      assert.notEqual(
        event.type,
        EVENT_TYPES.SYSTEM_BROADCAST_SENT,
        'a rescue was announced as a completed send',
      );
    }
  });
});

const NEWLINE = String.fromCharCode(10);
const WHY_LINE = '💡 Почему:';

describe('what the reconciler’s cards say', () => {
  it('gives the stuck count as a detail, not as the explanation the incident card prints', async () => {
    // The give-up event used to carry the reason as `why`, and the incident
    // card prints `why` under «Почему это важно» — so the one section written
    // to say what is at stake said «12 recipients still undispatched». Through
    // the real event bus, so what is asserted is the card, not a metadata key.
    const { events, cards } = cardCapturingEvents();
    const { service } = build({
      processing: [{ id: 'b-9' }],
      pendingCount: 12,
      totalCount: 400,
      systemEvents: events,
    });

    // Three revivals (WARNING each), then the give-up (ERROR).
    for (let i = 0; i < 4; i += 1) await service.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const incident = cards.find((card) => card.includes('<b>Почему это важно:</b>'));
    assert.ok(incident !== undefined, `no incident card among ${cards.length}`);
    const lines = incident.split('\n');
    const why = lines[lines.indexOf('❗ <b>Почему это важно:</b>') + 1] ?? '';
    assert.ok(!why.includes('recipients still undispatched'), `a count as the explanation: ${why}`);
    assert.ok(why.includes('Рассылку'), `no explanation under «Почему это важно»: ${why}`);
    // The count is still on the card — in the error message it belongs to.
    assert.ok(incident.includes('12 recipients still undispatched'), incident);

    const revival = cards.find((card) => card.includes('🔁 Попытка возобновления: 1'));
    assert.ok(revival !== undefined, `no revival card among ${cards.length}`);
    // The invariant is that the COUNT is not the explanation, not that the card
    // has none: «Проблема с рассылкой» over an attempt number left an operator
    // unable to tell whether this one was theirs to fix. It is not.
    const revivalWhy = revival.split(NEWLINE).find((line) => line.startsWith(WHY_LINE)) ?? '';
    assert.ok(
      !revivalWhy.includes('recipients still undispatched'),
      `a count as the explanation: ${revivalWhy}`,
    );
    assert.ok(
      revivalWhy.includes('доставка продолжится'),
      `no explanation on a revival card: ${revival}`,
    );
    assert.equal(
      revival.split('12 recipients still undispatched').length - 1,
      1,
      `the reason is printed twice:\n${revival}`,
    );
  });

  it('tells a lost schedule it never started — not that it stopped halfway', async () => {
    // `revive` serves two rescues. A schedule whose job vanished never sent a
    // thing, and «остановилась на полпути» — true of a stalled delivery, the
    // case above — told the operator about messages that were never sent.
    const { events, cards } = cardCapturingEvents();
    const { service } = build({
      scheduled: [{ id: 'b-10', scheduledAt: longAgo }],
      systemEvents: events,
    });

    for (let i = 0; i < 4; i += 1) await service.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const revival = cards.find((card) => card.includes('🔁 Попытка возобновления: 1'));
    assert.ok(revival !== undefined, `no revival card among ${cards.length}`);
    const revivalWhy = revival.split(NEWLINE).find((line) => line.startsWith(WHY_LINE)) ?? '';
    assert.ok(revivalWhy.includes('не стартовала в срок'), revival);
    assert.ok(!revival.includes('на полпути'), revival);

    const incident = cards.find((card) => card.includes('<b>Почему это важно:</b>'));
    assert.ok(incident !== undefined, `no incident card among ${cards.length}`);
    assert.ok(incident.includes('так и не стартовала'), incident);
    assert.ok(!incident.includes('снова останавливалась'), incident);
  });
});
