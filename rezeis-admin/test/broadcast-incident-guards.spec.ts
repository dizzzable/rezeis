import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import { isRelayDelivered } from '../src/modules/notifications/reiwa-relay.policy';

/**
 * The four things that went wrong in the broadcast incident, pinned.
 *
 * A scheduled broadcast reached 40 of ~400 people, its email arrived without
 * formatting, its channel post never appeared, and the panel reported all of it
 * as completed. Each test below fails if one of those becomes possible again.
 */

function prismaFake(options: {
  readonly status?: BroadcastStatus;
  readonly pending?: readonly string[];
  readonly sent?: number;
  readonly failed?: number;
  readonly pendingCount?: number;
}) {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    client: {
      broadcast: {
        findUnique: async () => ({
          id: 'b-1',
          status: options.status ?? BroadcastStatus.PROCESSING,
          audience: 'ALL',
          audienceFilter: null,
          payload: { text: 'hi', mediaType: 'none', emailEnabled: false, telegramChannelChatId: null },
          promoCode: null,
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return {};
        },
        updateMany: async () => ({ count: 0 }),
      },
      broadcastMessage: {
        findMany: async () => (options.pending ?? []).map((id) => ({ id })),
        // OBEYS the status it is handed. Answering the same number for every
        // query would make the finaliser's PENDING guard untestable — and
        // that guard is what decides whether a broadcast can finish at all.
        count: async ({ where }: { where: { status: string } }) => {
          if (where.status === 'SENT') return options.sent ?? 0;
          if (where.status === 'FAILED') return options.failed ?? 0;
          return options.pendingCount ?? 0;
        },
      },
    },
  };
}

/** `Array.prototype.at` is past this project's lib target. */
const lastOf = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const noop = () => undefined;
const events: Array<{ severity: string; type: string; message: string }> = [];
const systemEvents = {
  info: (type: string, _s: string, message: string) => {
    events.push({ severity: 'info', type, message });
  },
  warn: (type: string, _s: string, message: string) => {
    events.push({ severity: 'warn', type, message });
  },
  error: (type: string, _s: string, message: string) => {
    events.push({ severity: 'error', type, message });
  },
};

function service(prisma: unknown): BroadcastDeliveryService {
  return new BroadcastDeliveryService(
    prisma as never,
    { get: () => undefined } as never,
    systemEvents as never,
    { create: noop } as never,
    { getSettings: async () => ({}) } as never,
    { isEnabled: false } as never,
    { isEnabled: false } as never,
      // Promo gate dependency (position 8). Answers "usable" so these tests
      // exercise what they are about; the gate itself is covered separately.
      { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
  );
}

describe('a retry RESUMES the fan-out instead of reporting an empty success', () => {
  it('hands back the recipients no batch ever reached', async () => {
    // THE INCIDENT. Staging is claim-once so a retry cannot double-post the
    // channel or create a second set of rows — correct. But the loop that
    // enqueues the batches lives outside that claim, so a throw partway through
    // it used to end with the retry finding PROCESSING, returning nothing, and
    // the start job reporting success while every unenqueued batch was lost.
    const prisma = prismaFake({
      status: BroadcastStatus.PROCESSING,
      pending: ['m-51', 'm-52', 'm-53'],
    });

    const outstanding = await service(prisma.client).stageRecipients('b-1');

    assert.deepStrictEqual(
      outstanding,
      ['m-51', 'm-52', 'm-53'],
      'a retry answered "nothing to send" while recipients were still undispatched',
    );
  });

  it('still refuses a broadcast that is finished or cancelled', async () => {
    // Resuming is only right for one that is mid-flight. A COMPLETED broadcast
    // has nothing outstanding and must not be re-entered.
    for (const status of [BroadcastStatus.COMPLETED, BroadcastStatus.CANCELED, BroadcastStatus.FAILED]) {
      const prisma = prismaFake({ status, pending: ['m-1'] });
      assert.deepStrictEqual(
        await service(prisma.client).stageRecipients('b-1'),
        [],
        `resumed a ${status} broadcast`,
      );
    }
  });
});

describe('the finished status follows the outcome', () => {
  it('marks a broadcast that reached NOBODY as failed, loudly', async () => {
    events.length = 0;
    const prisma = prismaFake({ sent: 0, failed: 400 });

    await service(prisma.client).checkAndFinalize('b-1');

    const status = lastOf(prisma.updates)?.status;
    assert.equal(status, BroadcastStatus.FAILED, '0 of 400 was recorded as completed');
    assert.equal(lastOf(events)?.severity, 'error', 'total failure announced as news, not as an alarm');
  });

  it('warns on a partial delivery instead of calling it a success', async () => {
    // 40 of 400 — the reported incident — used to raise an INFO card titled
    // "Рассылка отправлена", which is why nobody was told.
    events.length = 0;
    const prisma = prismaFake({ sent: 40, failed: 360 });

    await service(prisma.client).checkAndFinalize('b-1');

    assert.equal(lastOf(prisma.updates)?.status, BroadcastStatus.COMPLETED);
    assert.equal(lastOf(events)?.severity, 'warn', '40 of 400 was announced as an ordinary success');
    assert.match(String(lastOf(events)?.message), /partially/i);
  });

  it('refuses to finish at all while recipients are still undispatched', async () => {
    // The other half of the incident: 350 rows left PENDING mean the broadcast
    // can never finalize, so it sits in PROCESSING with counters never written
    // and the panel shows 0/400 forever.
    events.length = 0;
    const prisma = prismaFake({ sent: 40, failed: 0, pendingCount: 360 });

    await service(prisma.client).checkAndFinalize('b-1');

    assert.deepStrictEqual(prisma.updates, [], 'finalised a broadcast that was still mid-flight');
  });

  it('stays quiet and green only when nothing failed', async () => {
    events.length = 0;
    const prisma = prismaFake({ sent: 400, failed: 0 });

    await service(prisma.client).checkAndFinalize('b-1');

    assert.equal(lastOf(prisma.updates)?.status, BroadcastStatus.COMPLETED);
    assert.equal(lastOf(events)?.severity, 'info');
  });
});

describe('a refused channel post is not a delivered one', () => {
  it('does not count a REJECTED relay as delivered', () => {
    // This is the incident. The bot used to answer 204 on Telegram's refusal —
    // chat not found, bot not an admin — and a 204 means `unconfirmed`, which
    // counts as delivered. The bot now answers 422, which is a non-2xx and so
    // classifies as `rejected`: undelivered, terminal, and alerted.
    assert.equal(
      isRelayDelivered('reiwa.channel.broadcast', {
        status: 'rejected',
        messageId: null,
        httpStatus: 422,
        detail: 'chat not found',
      }),
      false,
      "Telegram's refusal still counts as a delivered channel post",
    );
  });

  it('counts a post the bot proved with Telegram own message id', () => {
    assert.equal(
      isRelayDelivered('reiwa.channel.broadcast', {
        status: 'confirmed',
        messageId: 4242,
        httpStatus: 200,
        detail: null,
      }),
      true,
    );
  });

  it('still accepts a bodiless ack, because an older bot can only give that', () => {
    // The panel and the bot ship as separate images. Demanding a message id
    // here would make every channel post fail against a bot that has not been
    // updated yet — the fix belongs on the side that knows what happened.
    assert.equal(
      isRelayDelivered('reiwa.channel.broadcast', {
        status: 'unconfirmed',
        messageId: null,
        httpStatus: 204,
        detail: null,
      }),
      true,
    );
  });
});
