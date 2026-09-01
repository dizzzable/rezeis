import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';

/**
 * "Retry failed" moves a settled broadcast back into flight, and that is a
 * claim, not a status write.
 *
 * Every guarantee below was broken at some point by a change that looked local:
 * the claim written after the enqueue stranded the broadcast in PROCESSING; the
 * rows flipped without the broadcast's clock made the reconciler treat the
 * retry as stalled and queue a second delivery on top of it; the rollback that
 * restored the status but not the rows left recipients PENDING under a
 * finished broadcast, where nothing can ever reach them again.
 */

type Update = { where: Record<string, unknown>; data: Record<string, unknown> };

function serviceWith(currentStatus: BroadcastStatus) {
  const broadcastUpdates: Update[] = [];
  const messageUpdates: Update[] = [];
  const prisma = {
    broadcast: {
      findUnique: async () => ({ status: currentStatus }),
      updateMany: async (args: Update) => {
        broadcastUpdates.push(args);
        const allowed = (args.where.status as { in?: BroadcastStatus[] } | undefined)?.in;
        if (allowed !== undefined) return { count: allowed.includes(currentStatus) ? 1 : 0 };
        return { count: args.where.status === currentStatus ? 1 : 0 };
      },
    },
    broadcastMessage: {
      updateMany: async (args: Update) => {
        messageUpdates.push(args);
        return { count: 2 };
      },
    },
  };
  return { broadcastUpdates, messageUpdates, service: new BroadcastService(prisma as never) };
}

describe('claiming a settled broadcast for a retry', () => {
  it('answers the status it had, so a rollback can restore it', async () => {
    const { service } = serviceWith(BroadcastStatus.FAILED);

    assert.equal(await service.beginRetry('b-1'), BroadcastStatus.FAILED);
  });

  it('restarts the staleness clock', async () => {
    // The reconciler calls a broadcast stalled when it has been PROCESSING
    // since before `now - 3h`, and failures are usually noticed the next day.
    // Leaving `startedAt` at the original send time made every retry of an
    // older broadcast stale the instant it began: the next cron tick queued a
    // START job on top of it, whose resume re-batched every row the retry had
    // just put back to PENDING — the photo arrives twice, and a text message
    // collects the bot's deduplicated `unconfirmed`, which overwrites SENT
    // with FAILED.
    const { service, broadcastUpdates } = serviceWith(BroadcastStatus.COMPLETED);

    await service.beginRetry('b-1');

    assert.ok(
      broadcastUpdates[0]?.data.startedAt instanceof Date,
      'the retry inherited the original send time and is stale before it starts',
    );
  });

  it('refuses a broadcast that is already running', async () => {
    const { service } = serviceWith(BroadcastStatus.PROCESSING);

    assert.equal(await service.beginRetry('b-1'), null);
  });

  it('never answers a status that is not settled', async () => {
    // `abortRetry(id, PROCESSING)` would write PROCESSING over PROCESSING and
    // strand the broadcast in the exact state this claim exists to avoid.
    for (const status of [BroadcastStatus.PROCESSING, BroadcastStatus.DRAFT, BroadcastStatus.SCHEDULED]) {
      const { service } = serviceWith(status);
      assert.equal(await service.beginRetry('b-1'), null, `claimed a ${status} broadcast`);
    }
  });
});

describe('the rows a retry will touch', () => {
  it('all go back to PENDING before any batch runs', async () => {
    // Left to the batches, a retry of more than fifty recipients is several
    // jobs, and the finaliser's guard counts PENDING rows without counting the
    // FAILED ones still waiting their turn. If batch 1 settled in the gap, the
    // broadcast was written COMPLETED — with interim counters and a "sent"
    // card — while most of the retry had not started, re-opening Recall and
    // Edit on a send that was still going out.
    const { service, messageUpdates } = serviceWith(BroadcastStatus.FAILED);

    await service.markForRetry('b-1', ['m-1', 'm-2']);

    assert.deepStrictEqual(messageUpdates[0]?.where.id, { in: ['m-1', 'm-2'] });
    assert.equal(messageUpdates[0]?.where.status, BroadcastMessageStatus.FAILED);
    assert.equal(messageUpdates[0]?.data.status, BroadcastMessageStatus.PENDING);
  });

  it('are put BACK when the enqueue never happened', async () => {
    // A PENDING row under a settled broadcast is reachable by nothing: the
    // reconciler looks only at PROCESSING, "retry failed" finds no FAILED rows
    // to offer, and the panel counts them for ever as still delivering.
    const { service, messageUpdates, broadcastUpdates } = serviceWith(BroadcastStatus.PROCESSING);

    await service.abortRetry('b-1', BroadcastStatus.FAILED, ['m-1', 'm-2']);

    assert.equal(messageUpdates[0]?.data.status, BroadcastMessageStatus.FAILED);
    assert.equal(messageUpdates[0]?.where.status, BroadcastMessageStatus.PENDING);
    assert.equal(broadcastUpdates[0]?.data.status, BroadcastStatus.FAILED);
  });

  it('are left alone when the rollback names none', async () => {
    // Mutation check: an unconditional reset would flip rows a running retry
    // owns back to FAILED underneath it.
    const { service, messageUpdates } = serviceWith(BroadcastStatus.PROCESSING);

    await service.abortRetry('b-1', BroadcastStatus.COMPLETED);

    assert.deepStrictEqual(messageUpdates, []);
  });
});
