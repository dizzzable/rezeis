import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import { BROADCAST_MENU_CALLBACK } from '../src/modules/broadcast/broadcast.constants';

/**
 * «Кнопка «Меню» под постом» (the owner, 15.10.2026): a «🏠 Главное меню» button
 * under the post, opening the bot's menu as a NEW message (`menu:new`) so the
 * post stays — `menu:main` would draw the menu in its place.
 *
 * It is an ordinary Telegram callback button, so unlike the promo button it
 * rides every route: the relay for a text post, the Bot API itself for a photo
 * or a video, and every edit — an edit without `reply_markup` takes the
 * keyboard off. Driven through `deliverBatch` and `editBatch`, where the wire
 * bodies are made.
 */

interface Sent {
  readonly endpoint: string;
  readonly body: Record<string, unknown>;
}

const TEXT = { title: null, text: 'Новости', mediaType: 'none', mediaFileId: null, parseMode: 'HTML' };
const PHOTO = { title: null, text: 'Скидка', mediaType: 'photo', mediaFileId: 'file-1', parseMode: 'HTML' };
const VIDEO = { title: null, text: 'Ролик', mediaType: 'video', mediaFileId: 'file-2', parseMode: 'HTML' };

function harness(payload: Record<string, unknown>, promoCode: string | null = null) {
  const relayCalls: Array<{ buttons?: ReadonlyArray<Record<string, unknown>> }> = [];
  const prisma = {
    userNotificationEvent: { findMany: async () => [] },
    broadcast: {
      findUnique: async () => ({
        id: 'b-1',
        status: BroadcastStatus.PROCESSING,
        payload,
        promoCode,
        channelChatId: null,
        channelMessageId: null,
      }),
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    broadcastMessage: {
      findMany: async (args: { readonly where: { readonly status?: unknown } }) =>
        args.where.status === 'SENT'
          ? [{ id: 'm-1', userId: 'u-1', telegramMessageId: 5n }]
          : [{ id: 'm-1', userId: 'u-1' }],
      findUnique: async () => ({ status: BroadcastMessageStatus.PENDING }),
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
      count: async () => 0,
    },
    user: { findUnique: async () => ({ telegramId: 77n, email: null, webAccount: null, isBotBlocked: false }) },
  };
  const noop = (): undefined => undefined;
  const service = new BroadcastDeliveryService(
    prisma as never,
    { get: () => null } as never,
    { info: noop, warn: noop, error: noop } as never,
    { create: async () => 'evt-1' } as never,
    { getDecryptedBotToken: async () => 'token' } as never,
    {
      isEnabled: true,
      notifyUser: async (call: { buttons?: ReadonlyArray<Record<string, unknown>> }) => {
        relayCalls.push(call);
        return { status: 'confirmed', messageId: 9, httpStatus: 200, detail: null };
      },
    } as never,
    {
      isEnabled: true,
      enqueue: async (event: string) => {
        throw new Error(`deliverBatch must not enqueue relay events (got ${event})`);
      },
    } as never,
    { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
  );
  return { service, relayCalls };
}

async function capture<T>(run: () => Promise<T>): Promise<{ sent: Sent[]; result: T }> {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    sent.push({
      endpoint: url.slice(url.lastIndexOf('/') + 1),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      ok: true,
      json: async () => ({ result: { message_id: 1 } }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const result = await run();
    return { sent, result };
  } finally {
    globalThis.fetch = original;
  }
}

/** The callback data of every button of a Bot API `reply_markup`, row by row. */
function callbacksOf(body: Record<string, unknown> | undefined): unknown {
  const markup = body?.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> } | undefined;
  return markup?.inline_keyboard.map((row) => row.map((button) => button.callback_data));
}

describe('a text post, through the relay', () => {
  it('carries «🏠 Главное меню» with `menu:new` when the operator asked for it', async () => {
    const h = harness({ ...TEXT, menuButton: true });
    await h.service.deliverBatch('b-1', ['m-1']);

    assert.deepEqual(h.relayCalls[0]?.buttons, [{ text: '🏠 Главное меню', callbackData: BROADCAST_MENU_CALLBACK }]);
    assert.equal(BROADCAST_MENU_CALLBACK, 'menu:new');
  });

  it('puts it below the promo button, which keeps its place', async () => {
    const h = harness({ ...TEXT, menuButton: true }, 'SALE30');
    await h.service.deliverBatch('b-1', ['m-1']);

    const buttons = h.relayCalls[0]?.buttons ?? [];
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0]?.webAppPath, '/promo?code=SALE30');
    assert.equal(buttons[1]?.callbackData, 'menu:new');
  });

  it('carries no button at all when the operator did not ask — a broadcast from before the box included', async () => {
    for (const payload of [{ ...TEXT, menuButton: false }, TEXT]) {
      const h = harness(payload);
      await h.service.deliverBatch('b-1', ['m-1']);
      assert.equal(h.relayCalls[0]?.buttons, undefined);
    }
  });
});

describe('a photo or a video, straight to the Bot API', () => {
  for (const [name, payload, endpoint] of [
    ['photo', PHOTO, 'sendPhoto'],
    ['video', VIDEO, 'sendVideo'],
  ] as const) {
    it(`a ${name} carries the button as a real inline keyboard`, async () => {
      const h = harness({ ...payload, menuButton: true });
      const { sent } = await capture(() => h.service.deliverBatch('b-1', ['m-1']));

      assert.equal(sent[0]?.endpoint, endpoint);
      assert.deepEqual(callbacksOf(sent[0]?.body), [['menu:new']]);
    });
  }

  it('a photo without the box goes out with no keyboard, as before', async () => {
    const h = harness(PHOTO);
    const { sent } = await capture(() => h.service.deliverBatch('b-1', ['m-1']));

    assert.equal(sent[0]?.endpoint, 'sendPhoto');
    assert.equal(sent[0]?.body.reply_markup, undefined);
  });

  it('a promo-tagged photo still gets no promo button: only the bot can build one', async () => {
    const h = harness({ ...PHOTO, menuButton: true }, 'SALE30');
    const { sent } = await capture(() => h.service.deliverBatch('b-1', ['m-1']));

    assert.deepEqual(callbacksOf(sent[0]?.body), [['menu:new']]);
    assert.equal(JSON.stringify(sent[0]?.body).includes('promo'), false);
  });
});

describe('an edit keeps the button on the post', () => {
  for (const [name, payload, endpoint] of [
    ['text', TEXT, 'editMessageText'],
    ['photo', PHOTO, 'editMessageCaption'],
  ] as const) {
    it(`a ${name} post edited keeps «🏠 Главное меню»`, async () => {
      const h = harness({ ...payload, menuButton: true });
      const { sent } = await capture(() => h.service.editBatch('b-1', ['m-1'], 'новый текст', null));

      assert.equal(sent[0]?.endpoint, endpoint);
      assert.deepEqual(callbacksOf(sent[0]?.body), [['menu:new']]);
    });
  }

  it('a post without the box is edited with no keyboard, as before', async () => {
    const h = harness(TEXT);
    const { sent } = await capture(() => h.service.editBatch('b-1', ['m-1'], 'новый текст', null));

    assert.equal(sent[0]?.endpoint, 'editMessageText');
    assert.equal(sent[0]?.body.reply_markup, undefined);
  });
});
