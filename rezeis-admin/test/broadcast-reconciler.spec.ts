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
  /** Rows of ANY status. Defaults to the pending count — i.e. staging ran. */
  readonly totalCount?: number;
  readonly pendingStart?: ReadonlySet<string>;
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
      systemEvents as never,
      delivery as never,
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
