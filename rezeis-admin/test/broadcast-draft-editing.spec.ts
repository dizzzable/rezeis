import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';

/**
 * What may still be corrected before it goes out.
 *
 * A pending scheduled send got its own status so the panel could show it and
 * offer to cancel it. That status change silently took editing away: the draft
 * update refuses anything that is not DRAFT, and a schedule used to stay DRAFT
 * for its whole wait — which is exactly the window in which an operator spots
 * a typo. These pin both halves.
 */

function serviceWith(status: BroadcastStatus) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    broadcast: {
      findUnique: async () => ({
        id: 'b-1',
        status,
        payload: { text: 'old', mediaType: 'none' },
        audiencePlanId: null,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {
          id: 'b-1',
          status,
          audience: 'ALL',
          audiencePlanId: null,
          audienceFilter: null,
          promoCode: null,
          payload: { text: 'new', mediaType: 'none' },
          totalCount: 0,
          successCount: 0,
          failedCount: 0,
          createdBy: null,
          scheduledAt: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
  };
  return { updates, service: new BroadcastService(prisma as never) };
}

describe('correcting a broadcast that has not gone out', () => {
  it('accepts an edit to a draft', async () => {
    const { service, updates } = serviceWith(BroadcastStatus.DRAFT);

    await service.updateDraft({ broadcastId: 'b-1', dto: { text: 'new' } as never });

    assert.equal(updates.length, 1);
  });

  it('accepts an edit to a SCHEDULED send, which is the window that matters', async () => {
    // The job re-reads content and audience when it fires, so an edit during
    // the wait takes effect. Refusing it was a regression from giving a pending
    // send its own status.
    const { service, updates } = serviceWith(BroadcastStatus.SCHEDULED);

    await service.updateDraft({ broadcastId: 'b-1', dto: { text: 'new' } as never });

    assert.equal(updates.length, 1, 'a scheduled broadcast could not be corrected before it fired');
  });

  it('refuses an edit to anything already under way or finished', async () => {
    // Not an edit any more: those rows have recipients, and changing the
    // content underneath them would misreport what was actually delivered.
    for (const status of [
      BroadcastStatus.PROCESSING,
      BroadcastStatus.COMPLETED,
      BroadcastStatus.CANCELED,
      BroadcastStatus.FAILED,
    ]) {
      const { service } = serviceWith(status);
      await assert.rejects(
        () => service.updateDraft({ broadcastId: 'b-1', dto: { text: 'new' } as never }),
        `a ${status} broadcast accepted a content edit`,
      );
    }
  });
});
