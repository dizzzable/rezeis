import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { of, throwError } from 'rxjs';
import { ServiceUnavailableException } from '@nestjs/common';

import {
  AdminBroadcastDeliveryException,
  AdminBroadcastDeliveryService,
} from '../src/modules/broadcast/services/admin-broadcast-delivery.service';

describe('AdminBroadcastDeliveryService', () => {
  it('sends Telegram messages through the configured bot token', async () => {
    const posts: unknown[] = [];
    const service = new AdminBroadcastDeliveryService(
      {
        post: (url: string, body: unknown) => {
          posts.push({ url, body });
          return of({ data: { result: { message_id: 42 } } });
        },
      } as never,
      { botToken: 'bot-token' } as never,
    );

    const result = await service.sendTelegramMessage({ telegramId: '12345', text: 'Hello' });

    assert.deepStrictEqual(posts, [
      {
        url: 'https://api.telegram.org/botbot-token/sendMessage',
        body: {
          chat_id: '12345',
          text: 'Hello',
          disable_web_page_preview: true,
        },
      },
    ]);
    assert.deepStrictEqual(result, { deliveryState: 'delivered', telegramMessageId: 42 });
  });

  it('adds Telegram inline button markup when broadcast payload provides button fields', async () => {
    const posts: unknown[] = [];
    const service = new AdminBroadcastDeliveryService(
      { post: (url: string, body: unknown) => { posts.push({ url, body }); return of({ data: { result: { message_id: 43 } } }); } } as never,
      { botToken: 'bot-token' } as never,
    );

    await service.sendTelegramMessage({ telegramId: '12345', text: 'Hello', buttonText: 'Open app', buttonUrl: 'https://example.com' });

    assert.deepStrictEqual((posts[0] as { readonly body: { readonly reply_markup: unknown } }).body.reply_markup, {
      inline_keyboard: [[{ text: 'Open app', url: 'https://example.com' }]],
    });
  });

  it('sends Telegram photo messages when broadcast payload provides media URL', async () => {
    const posts: unknown[] = [];
    const service = new AdminBroadcastDeliveryService(
      { post: (url: string, body: unknown) => { posts.push({ url, body }); return of({ data: { result: { message_id: 44 } } }); } } as never,
      { botToken: 'bot-token' } as never,
    );

    await service.sendTelegramMessage({ telegramId: '12345', text: 'Photo caption', mediaUrl: 'https://example.com/image.jpg', buttonText: 'Open app', buttonUrl: 'https://example.com' });

    assert.deepStrictEqual(posts[0], {
      url: 'https://api.telegram.org/botbot-token/sendPhoto',
      body: {
        chat_id: '12345',
        photo: 'https://example.com/image.jpg',
        caption: 'Photo caption',
        reply_markup: { inline_keyboard: [[{ text: 'Open app', url: 'https://example.com' }]] },
      },
    });
  });

  it('requires bot token before attempting delivery', async () => {
    const service = new AdminBroadcastDeliveryService({ post: () => of({ data: {} }) } as never, { botToken: null } as never);

    await assert.rejects(
      () => service.sendTelegramMessage({ telegramId: '12345', text: 'Hello' }),
      ServiceUnavailableException,
    );
  });

  it('classifies terminal Telegram delivery failures', async () => {
    const warnings: string[] = [];
    const rawTelegramError = new Error(
      'telegram forbidden bot-token chat 12345 https://api.telegram.org/botsecret/sendMessage',
    );
    Object.assign(rawTelegramError, { response: { status: 403 } });
    const service = new AdminBroadcastDeliveryService(
      { post: () => throwError(() => rawTelegramError) } as never,
      { botToken: 'bot-token' } as never,
    );
    (service as unknown as { readonly logger: { warn: (message: string) => void } }).logger.warn = (message: string): void => {
      warnings.push(message);
    };

    await assert.rejects(
      () => service.sendTelegramMessage({ telegramId: '12345', text: 'Hello' }),
      (error: unknown) => error instanceof AdminBroadcastDeliveryException
        && error.deliveryState === 'definitely-not-delivered',
    );
    assert.deepStrictEqual(warnings, [
      'Unable to send broadcast message to Telegram: TELEGRAM_RECIPIENT_UNAVAILABLE (status 403)',
    ]);
    const serializedWarnings = JSON.stringify(warnings);
    assert.equal(serializedWarnings.includes('bot-token'), false);
    assert.equal(serializedWarnings.includes('12345'), false);
    assert.equal(serializedWarnings.includes('api.telegram.org'), false);
  });

  it('deletes Telegram messages through the configured bot token', async () => {
    const posts: unknown[] = [];
    const service = new AdminBroadcastDeliveryService(
      {
        post: (url: string, body: unknown) => {
          posts.push({ url, body });
          return of({ data: { ok: true } });
        },
      } as never,
      { botToken: 'bot-token' } as never,
    );

    const result = await service.deleteTelegramMessage({ telegramId: '12345', telegramMessageId: 42 });

    assert.deepStrictEqual(posts, [
      {
        url: 'https://api.telegram.org/botbot-token/deleteMessage',
        body: {
          chat_id: '12345',
          message_id: 42,
        },
      },
    ]);
    assert.deepStrictEqual(result, { deleted: true });
  });

  it('sanitizes Telegram delete failures', async () => {
    const warnings: string[] = [];
    const rawTelegramError = new Error(
      'telegram delete failed bot-token chat 12345 https://api.telegram.org/botsecret/deleteMessage payload secret',
    );
    Object.assign(rawTelegramError, { response: { status: 500 } });
    const service = new AdminBroadcastDeliveryService(
      { post: () => throwError(() => rawTelegramError) } as never,
      { botToken: 'bot-token' } as never,
    );
    (service as unknown as { readonly logger: { warn: (message: string) => void } }).logger.warn = (message: string): void => {
      warnings.push(message);
    };

    await assert.rejects(
      () => service.deleteTelegramMessage({ telegramId: '12345', telegramMessageId: 42 }),
      ServiceUnavailableException,
    );

    assert.deepStrictEqual(warnings, [
      'Unable to delete broadcast message from Telegram: TELEGRAM_DELIVERY_FAILED (status 500)',
    ]);
    const serialized = JSON.stringify(warnings);
    assert.equal(serialized.includes('bot-token'), false);
    assert.equal(serialized.includes('12345'), false);
    assert.equal(serialized.includes('api.telegram.org'), false);
    assert.equal(serialized.includes('payload secret'), false);
  });
});
