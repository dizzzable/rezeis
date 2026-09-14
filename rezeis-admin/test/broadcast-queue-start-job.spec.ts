import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BROADCAST_DELIVERY_QUEUE,
  BROADCAST_JOBS,
} from '../src/modules/broadcast/broadcast.constants';
import {
  BroadcastQueueService,
  startJobId,
  type BroadcastStartJobData,
} from '../src/modules/broadcast/services/broadcast-queue.service';
import { OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * Pressing "send" on a broadcast
 * ══════════════════════════════
 * `BroadcastQueueService` had never been constructed in a spec, and the one
 * thing its start path depends on — a job id BullMQ will take — was
 * `broadcast-start:${broadcastId}`. Two colon parts: BullMQ refuses it with
 * "Custom Id cannot contain :", the add is not wrapped, and the refusal went
 * straight up `sendBroadcast` as a 500. No broadcast could be sent or
 * scheduled, and the reconciler's revival threw the same way.
 *
 * The queue below runs BullMQ's own admission code and keeps BullMQ's "one job
 * per id" rule, because the start path is built on that rule: the id is what
 * lets a reschedule replace the pending job, the reconciler ask whether one is
 * pending, and cancel find it.
 */

const BROADCAST_ID = 'cmf0broadcast000000000001';

function build() {
  const queue = new OfflineBullMqQueue<BroadcastStartJobData>(BROADCAST_DELIVERY_QUEUE);
  const service = new BroadcastQueueService(
    queue.asQueue(),
    { broadcastMessage: { updateMany: async () => ({ count: 0 }) } } as never,
  );
  return { queue, service };
}

describe('starting a broadcast', () => {
  it('queues a start job BullMQ will actually take', async () => {
    const { queue, service } = build();

    const jobId = await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: 'admin-1' });

    assert.deepStrictEqual(queue.refused, [], 'BullMQ refused the start job — the 500 on "send"');
    assert.equal(jobId, startJobId(BROADCAST_ID));
    assert.equal(queue.admitted[0]?.name, BROADCAST_JOBS.START);
    assert.deepStrictEqual(
      queue.admitted[0]?.data,
      { broadcastId: BROADCAST_ID, adminId: 'admin-1' },
      'the broadcast id travels in the payload; the job id is only the queue’s name for it',
    );
  });

  it('can be found again by the lookups, because they derive the same id', async () => {
    const { service } = build();
    await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: null }, { delayMs: 60_000 });

    assert.equal(await service.hasPendingStart(BROADCAST_ID), true, 'the reconciler would stack a second start');
    assert.equal(await service.hasPendingStart('cmf0broadcast000000000002'), false);
  });

  it('replaces a pending schedule instead of leaving the old time to fire', async () => {
    const { queue, service } = build();

    await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: 'admin-1' }, { delayMs: 60_000 });
    await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: 'admin-1' }, { delayMs: 120_000 });

    assert.deepStrictEqual(queue.heldIds(), [startJobId(BROADCAST_ID)], 'one start job per broadcast');
    const held = await queue.getJob(startJobId(BROADCAST_ID));
    assert.equal(held?.opts.delay, 120_000, 'the operator’s correction is the time that fires');
  });

  it('hands back the start job already running rather than adding a second', async () => {
    const { queue, service } = build();
    await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: 'admin-1' });
    queue.setState(startJobId(BROADCAST_ID), 'active');

    const jobId = await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: null });

    assert.equal(jobId, startJobId(BROADCAST_ID));
    assert.deepStrictEqual(queue.admitted.map((call) => call.collapsed), [false, true]);
    assert.equal(await service.hasPendingStart(BROADCAST_ID), true);
  });

  it('lets the reconciler put back a broadcast whose start job already finished', async () => {
    // A finished job keeps its id while retained, and BullMQ would hand it
    // back instead of adding — a silent no-op on exactly the broadcast the
    // reconciler exists to rescue. The slot is cleared first.
    const { queue, service } = build();
    await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: 'admin-1' });
    queue.setState(startJobId(BROADCAST_ID), 'completed');

    await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: null });

    assert.deepStrictEqual(queue.admitted.map((call) => call.collapsed), [false, false]);
    assert.equal(await service.hasPendingStart(BROADCAST_ID), true);
  });

  it('is removed by cancel, which looks it up by the same id', async () => {
    const { queue, service } = build();
    await service.enqueueStart({ broadcastId: BROADCAST_ID, adminId: 'admin-1' }, { delayMs: 60_000 });

    await service.cancelBroadcast(BROADCAST_ID);

    assert.deepStrictEqual(queue.heldIds(), []);
    assert.equal(await service.dropPendingStart(BROADCAST_ID), false, 'nothing left to drop');
  });
});
