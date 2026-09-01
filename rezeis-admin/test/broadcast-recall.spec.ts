import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';

/**
 * Taking a sent broadcast back out of recipients' chats.
 *
 * The endpoint existed from the first release and had NO tests and no caller —
 * nothing in the panel invoked it. So the recall path was reachable only by
 * hand-crafting a request, and every claim it made about itself was unchecked.
 * These are the claims that matter: what the recall leaves behind, and whether
 * it tells the truth about the one public copy.
 */

type Update = { where: Record<string, unknown>; data: Record<string, unknown> };

function build(options: {
  readonly channelChatId?: string | null;
  readonly channelMessageId?: bigint | null;
  readonly configuredChannel?: string | null;
  readonly botToken?: string | null;
  readonly telegramOk?: boolean;
}) {
  const messageUpdates: Update[] = [];
  const broadcastUpdates: Update[] = [];
  const events: Array<{ severity: string; message: string }> = [];
  const payload: Record<string, unknown> = {
    text: 'hi',
    mediaType: 'none',
    telegramChannelChatId: options.configuredChannel ?? null,
  };
  const client = {
    broadcast: {
      findUnique: async () => ({
        id: 'b-1',
        status: BroadcastStatus.COMPLETED,
        payload,
        promoCode: null,
        channelChatId: options.channelChatId ?? null,
        channelMessageId: options.channelMessageId ?? null,
      }),
      update: async (args: Update) => {
        broadcastUpdates.push(args);
        return {};
      },
      updateMany: async () => ({ count: 1 }),
    },
    broadcastMessage: {
      findMany: async () => [
        { id: 'm-1', userId: 'u-1', telegramMessageId: 4242n },
      ],
      update: async (args: Update) => {
        messageUpdates.push(args);
        return {};
      },
      count: async () => 0,
    },
    user: { findUnique: async () => ({ telegramId: 777n }) },
  };
  const noop = () => undefined;
  const service = new BroadcastDeliveryService(
    client as never,
    { get: () => options.botToken ?? null } as never,
    {
      info: (_t: string, _s: string, message: string) => events.push({ severity: 'info', message }),
      warn: (_t: string, _s: string, message: string) => events.push({ severity: 'warn', message }),
      error: (_t: string, _s: string, message: string) => events.push({ severity: 'error', message }),
    } as never,
    // 4 user notifications, 5 settings (the bot token lives here), 6 bot
    // notifier, 7 relay queue.
    { create: noop } as never,
    { getDecryptedBotToken: async () => options.botToken ?? null } as never,
    {} as never,
    { isEnabled: false } as never,
    { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
  );
  return { service, messageUpdates, broadcastUpdates, events };
}

async function withFetch<T>(
  handler: () => Promise<{ ok: boolean }>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const result = await handler();
    return {
      ok: result.ok,
      json: async () => ({ result: { message_id: 1 } }),
      text: async () => '{"ok":false,"error_code":400}',
    } as unknown as Response;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe('what a recall leaves on the recipient row', () => {
  it('keeps the Telegram message id', async () => {
    // The id is the ONLY thing separating "was delivered, then withdrawn" from
    // "was cancelled before it ever went out" — the two share a status. Clearing
    // it made the finaliser recount the broadcast as having reached fewer
    // people than it did: recall 400, then retry the 20 stragglers, and
    // `successCount` was rewritten from 400 to 20 with nothing on screen to
    // explain the change.
    const fake = build({ botToken: 'token' });

    await withFetch(
      async () => ({ ok: true }),
      () => fake.service.deleteBatch('b-1', ['m-1']),
    );

    const write = fake.messageUpdates[0]?.data;
    assert.equal(write?.status, BroadcastMessageStatus.CANCELED);
    assert.equal(
      'telegramMessageId' in (write ?? {}),
      false,
      'the recall cleared the id that tells a withdrawal apart from a cancellation',
    );
  });

  it('does not rewrite how many people the broadcast reached', async () => {
    // `successCount` answers "it reached N people", and it did. Decrementing it
    // also broke the panel's arithmetic for "still delivering", which was
    // `total - success - failed`: every recalled message silently added one to
    // that, permanently, on a broadcast that had finished.
    const fake = build({ botToken: 'token' });

    await withFetch(
      async () => ({ ok: true }),
      () => fake.service.deleteBatch('b-1', ['m-1']),
    );

    for (const update of fake.broadcastUpdates) {
      assert.equal(
        'successCount' in update.data,
        false,
        'the recall rewrote the delivered count',
      );
    }
  });
});

describe('the recall tells the truth about the public copy', () => {
  it('reports a channel post it cannot address, instead of calling it a success', async () => {
    // The likeliest shape of this on a live system: the post went out, but an
    // older reiwa bot answered a bodiless 204, so no message id was ever
    // recorded. Folded into "there was no post", the operator was told the
    // recall had started while the copy anyone can read stayed up.
    const fake = build({ botToken: 'token', configuredChannel: '@ops', channelMessageId: null });

    assert.equal(await fake.service.deleteChannelPost('b-1'), 'unaddressable');
  });

  it('still says "no post" when no channel was ever configured', async () => {
    // The negative control. Treating every missing id as a problem would put a
    // warning on every ordinary recall.
    const fake = build({ botToken: 'token', configuredChannel: null });

    assert.equal(await fake.service.deleteChannelPost('b-1'), 'no-post');
  });

  it('deletes the post and forgets its address when it can reach it', async () => {
    const fake = build({
      botToken: 'token',
      configuredChannel: '@ops',
      channelChatId: '@ops',
      channelMessageId: 99n,
    });

    const outcome = await withFetch(
      async () => ({ ok: true }),
      () => fake.service.deleteChannelPost('b-1'),
    );

    assert.equal(outcome, 'deleted');
    assert.equal(
      fake.broadcastUpdates[0]?.data.channelMessageId,
      null,
      'a second recall would report a failure for a post that is already gone',
    );
  });

  it('reports a refusal from Telegram as a failure', async () => {
    const fake = build({
      botToken: 'token',
      configuredChannel: '@ops',
      channelChatId: '@ops',
      channelMessageId: 99n,
    });

    const outcome = await withFetch(
      async () => ({ ok: false }),
      () => fake.service.deleteChannelPost('b-1'),
    );

    assert.equal(outcome, 'failed');
  });
});

describe('a recall that removes nothing says so', () => {
  it('reports the deployment that has no bot token at all', async () => {
    // A no-BOT_TOKEN deployment is supported — text broadcasts go out through
    // the reiwa bot — but a recall cannot run there: every message stays in
    // every chat and every row stays SENT, so the button stays lit and the
    // panel's toast still said the messages were being removed. The early
    // return for a missing token sat in FRONT of the report at the end of the
    // method, so the one configuration where a recall can do nothing was the
    // one that said nothing.
    const fake = build({ botToken: null });

    const outcome = await fake.service.deleteBatch('b-1', ['m-1']);

    assert.deepStrictEqual(outcome, { deleted: 0, failed: 1 });
    const reported = fake.events.find((event) => event.severity === 'error');
    assert.ok(reported, 'a recall that could not run reported nothing');
    assert.ok(/bot token/i.test(reported.message), 'the report does not name the cause');
  });

  it('reports a Telegram refusal', async () => {
    const fake = build({ botToken: 'token' });

    await withFetch(
      async () => ({ ok: false }),
      () => fake.service.deleteBatch('b-1', ['m-1']),
    );

    const reported = fake.events.find((event) => event.severity === 'error');
    assert.ok(reported && /removed nothing in this batch/.test(reported.message));
  });

  it('stays quiet when every deletion succeeded', async () => {
    // Mutation check: reporting unconditionally would put an error card on
    // every successful recall.
    const fake = build({ botToken: 'token' });

    await withFetch(
      async () => ({ ok: true }),
      () => fake.service.deleteBatch('b-1', ['m-1']),
    );

    assert.deepStrictEqual(
      fake.events.filter((event) => event.severity !== 'info'),
      [],
      'a clean recall raised an alert',
    );
  });
});

describe('a channel post stays reachable when no recipient message is', () => {
  it('is still reported when every recipient row has been recalled', async () => {
    // The recall route refused outright whenever `getSentMessageIds` was empty,
    // and that took the PUBLIC copy down with it. Two ordinary broadcasts land
    // there: one already recalled, and one delivered only to web-only users,
    // whose rows are SENT with no Telegram message id at all. In both the copy
    // anyone can read was still up, with no route left in the panel.
    const fake = build({
      botToken: 'token',
      configuredChannel: '@ops',
      channelChatId: '@ops',
      channelMessageId: 99n,
    });

    assert.equal(await fake.service.channelPostState('b-1'), 'addressable');
  });

  it('answers "no-post" when there is genuinely nothing public', async () => {
    // Mutation check: answering "addressable" always would make the recall
    // route accept a broadcast with nothing at all to remove.
    const fake = build({ botToken: 'token' });

    assert.equal(await fake.service.channelPostState('b-1'), 'no-post');
  });
});
