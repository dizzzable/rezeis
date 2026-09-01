import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastReconcilerService } from '../src/modules/broadcast/services/broadcast-reconciler.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';

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
  readonly pendingStart?: ReadonlySet<string>;
}) {
  const enqueued: string[] = [];
  const events: Array<{ severity: string; type: string }> = [];
  const prisma = {
    broadcast: {
      findMany: async ({ where }: { where: { status: BroadcastStatus } }) =>
        where.status === BroadcastStatus.SCHEDULED
          ? [...(options.scheduled ?? [])]
          : [...(options.processing ?? [])],
    },
    broadcastMessage: {
      count: async () => options.pendingCount ?? 0,
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
    info: (type: string) => events.push({ severity: 'info', type }),
    warn: (type: string) => events.push({ severity: 'warn', type }),
    error: (type: string) => events.push({ severity: 'error', type }),
  };
  return {
    enqueued,
    events,
    service: new BroadcastReconcilerService(
      prisma as never,
      queue as never,
      systemEvents as never,
    ),
  };
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
    const { service, enqueued } = build({
      processing: [{ id: 'b-2' }],
      pendingCount: 0,
    });

    await service.reconcile();

    assert.deepStrictEqual(enqueued, []);
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
