import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';

/**
 * A scheduled broadcast is a record, not just a delayed job in Redis.
 *
 * Everything the operator could not do — see that a send was pending, learn
 * when it would fire, cancel it, correct its time — came from the same absence:
 * the intent was never written down. These pin that it is.
 */

function serviceWith() {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    broadcast: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return {};
      },
    },
  };
  return { updates, service: new BroadcastService(prisma as never) };
}

describe('recording a schedule', () => {
  it('writes the status, the due time and the job id together', async () => {
    // All three in one write, in the same request that enqueues the job. A
    // schedule that exists only in Redis cannot be shown or cancelled.
    const { service, updates } = serviceWith();
    const due = new Date('2026-09-01T20:00:00.000Z');

    await service.recordSchedule('b-1', due, 'broadcast-start:b-1');

    assert.equal(updates.length, 1);
    assert.deepStrictEqual(updates[0]?.data, {
      status: BroadcastStatus.SCHEDULED,
      scheduledAt: due,
      queueJobId: 'broadcast-start:b-1',
    });
  });

  it('leaves an immediate send as a draft, with no due time', async () => {
    // Nothing to remember: the job is already on its way, and marking it
    // SCHEDULED would show a pending send that is not pending.
    const { service, updates } = serviceWith();

    await service.recordSchedule('b-1', null, 'broadcast-start:b-1');

    assert.deepStrictEqual(updates[0]?.data, {
      queueJobId: 'broadcast-start:b-1',
      scheduledAt: null,
    });
    assert.equal(
      (updates[0]?.data as Record<string, unknown>)['status'],
      undefined,
      'an immediate send was marked scheduled',
    );
  });

  it('clears a stale due time when a scheduled broadcast is sent now', async () => {
    // Reschedule-to-immediate: the row must stop claiming a future time it no
    // longer has.
    const { service, updates } = serviceWith();

    await service.recordSchedule('b-1', null, 'broadcast-start:b-1');

    assert.equal(updates[0]?.data.scheduledAt, null);
  });
});
