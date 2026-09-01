import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';

/**
 * A scheduled broadcast is a record, not just a delayed job in Redis.
 *
 * The write is CONDITIONAL, and that is the part worth guarding. Unconditional,
 * it was a way to stamp SCHEDULED over PROCESSING: a send fires at 10:00, the
 * operator reschedules a second later, the claim lands in the gap between the
 * controller reading the status and this write — and the running send becomes
 * invisible while the new job later stages the whole audience a second time.
 */

function serviceWith(currentStatus: BroadcastStatus) {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const prisma = {
    broadcast: {
      // OBEYS the precondition it is handed. A fake that always reported one
      // row updated would make the guard untestable — and the guard is the
      // entire fix.
      updateMany: async ({
        where,
        data,
      }: {
        where: { status?: { in?: BroadcastStatus[] } };
        data: Record<string, unknown>;
      }) => {
        updates.push({ where, data });
        const allowed = where.status?.in ?? [];
        return { count: allowed.includes(currentStatus) ? 1 : 0 };
      },
    },
  };
  return { updates, service: new BroadcastService(prisma as never) };
}

const DUE = new Date('2026-09-01T20:00:00.000Z');

describe('recording a schedule', () => {
  it('writes the status, the due time and the job id together', async () => {
    const { service, updates } = serviceWith(BroadcastStatus.DRAFT);

    const recorded = await service.recordSchedule('b-1', DUE, 'broadcast-start:b-1');

    assert.equal(recorded, true);
    assert.deepStrictEqual(updates[0]?.data, {
      status: BroadcastStatus.SCHEDULED,
      scheduledAt: DUE,
      queueJobId: 'broadcast-start:b-1',
    });
  });

  it('puts an immediate send back to DRAFT and clears the due time', async () => {
    // Re-sending a scheduled broadcast immediately must stop the row claiming a
    // future time it no longer has — and must not leave it SCHEDULED, which the
    // reconciler's `scheduledAt < now` query could then never see again.
    const { service, updates } = serviceWith(BroadcastStatus.SCHEDULED);

    const recorded = await service.recordSchedule('b-1', null, 'broadcast-start:b-1');

    assert.equal(recorded, true);
    assert.deepStrictEqual(updates[0]?.data, {
      queueJobId: 'broadcast-start:b-1',
      scheduledAt: null,
      status: BroadcastStatus.DRAFT,
    });
  });

  it('REFUSES to write over a broadcast that has already started', async () => {
    // The race this exists for. Losing it must mean "did not schedule", not
    // "quietly relabelled a send that is already going out".
    const { service, updates } = serviceWith(BroadcastStatus.PROCESSING);

    const recorded = await service.recordSchedule('b-1', DUE, 'broadcast-start:b-1');

    assert.equal(recorded, false, 'a running broadcast was relabelled as scheduled');
    assert.equal(updates.length, 1, 'the write was not even attempted conditionally');
  });

  it('refuses over a finished or cancelled broadcast too', async () => {
    for (const status of [
      BroadcastStatus.COMPLETED,
      BroadcastStatus.CANCELED,
      BroadcastStatus.FAILED,
    ]) {
      const { service } = serviceWith(status);
      assert.equal(
        await service.recordSchedule('b-1', DUE, 'job'),
        false,
        `a ${status} broadcast was rescheduled`,
      );
    }
  });

  it('names both startable states in its precondition', async () => {
    // Narrowing this to DRAFT alone is what took cancel and edit away from a
    // pending schedule elsewhere; the same narrowing here would make a
    // reschedule silently impossible.
    const { service, updates } = serviceWith(BroadcastStatus.DRAFT);

    await service.recordSchedule('b-1', DUE, 'job');

    assert.deepStrictEqual((updates[0]?.where as { status: { in: string[] } }).status.in, [
      BroadcastStatus.DRAFT,
      BroadcastStatus.SCHEDULED,
    ]);
  });
});
