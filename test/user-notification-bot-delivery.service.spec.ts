import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { of, throwError } from 'rxjs';

import { UserNotificationBotDeliveryService } from '../src/modules/user-activity/services/user-notification-bot-delivery.service';

describe('UserNotificationBotDeliveryService', () => {
  it('delivers the next pending notification event through Telegram Bot API', async () => {
    const updates: unknown[] = [];
    const requests: unknown[] = [];
    const service = new UserNotificationBotDeliveryService(
      {
        userNotificationEvent: {
          findFirst: async () => ({ id: 'event-1', renderedText: 'Payment completed', user: { telegramId: BigInt(12345), isBotBlocked: false } }),
          update: async (input: unknown) => { updates.push(input); },
        },
      } as never,
      { post: (url: string, body: unknown) => { requests.push({ url, body }); return of({ data: { ok: true, result: { message_id: 77 } } }); } } as never,
      { botToken: 'bot-token' } as never,
    );

    const result = await service.processNextPendingEvent();

    assert.equal(result.status, 'DELIVERED');
    assert.equal(result.eventId, null);
    assert.deepStrictEqual(requests, [{ url: 'https://api.telegram.org/botbot-token/sendMessage', body: { chat_id: '12345', text: 'Payment completed' } }]);
    assert.equal((updates[0] as { readonly data: { readonly botDeliveryStatus: string } }).data.botDeliveryStatus, 'DELIVERED');
  });

  it('blocks delivery when rendered text is missing', async () => {
    const updates: unknown[] = [];
    const service = new UserNotificationBotDeliveryService(
      { userNotificationEvent: { findFirst: async () => ({ id: 'event-1', renderedText: null, user: { telegramId: BigInt(12345), isBotBlocked: false } }), update: async (input: unknown) => { updates.push(input); } } } as never,
      { post: () => { throw new Error('should not send'); } } as never,
      { botToken: 'bot-token' } as never,
    );

    const result = await service.processNextPendingEvent();

    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.eventId, null);
    assert.equal(result.reason, 'Rendered text is missing');
    assert.equal(JSON.stringify(updates).includes('BLOCKED'), true);
  });

  it('marks delivery as failed when Telegram rejects the request', async () => {
    const updates: unknown[] = [];
    const rawTelegramError = new Error('telegram outage bot-token chat 12345 payload secret');
    const service = new UserNotificationBotDeliveryService(
      { userNotificationEvent: { findFirst: async () => ({ id: 'event-1', renderedText: 'Hello', user: { telegramId: BigInt(12345), isBotBlocked: false } }), update: async (input: unknown) => { updates.push(input); } } } as never,
      { post: () => throwError(() => rawTelegramError) } as never,
      { botToken: 'bot-token' } as never,
    );

    const result = await service.processNextPendingEvent();

    assert.equal(result.status, 'FAILED');
    assert.equal(result.eventId, null);
    assert.equal(result.reason, 'TELEGRAM_DELIVERY_FAILED');
    assert.equal(JSON.stringify(updates).includes('FAILED'), true);
    const serialized = JSON.stringify({ result, updates });
    assert.equal(serialized.includes('telegram outage'), false);
    assert.equal(serialized.includes('bot-token'), false);
    assert.equal(serialized.includes('payload secret'), false);
  });

  it('does not classify post-delivery database failures as Telegram delivery failures', async () => {
    const updates: unknown[] = [];
    const requests: unknown[] = [];
    const service = new UserNotificationBotDeliveryService(
      {
        userNotificationEvent: {
          findFirst: async () => ({ id: 'event-1', renderedText: 'Payment completed', user: { telegramId: BigInt(12345), isBotBlocked: false } }),
          update: async (input: unknown) => {
            updates.push(input);
            throw new Error('database write failed after Telegram delivered bot-token secret payload');
          },
        },
      } as never,
      { post: (url: string, body: unknown) => { requests.push({ url, body }); return of({ data: { ok: true, result: { message_id: 88 } } }); } } as never,
      { botToken: 'bot-token' } as never,
    );

    await assert.rejects(service.processNextPendingEvent(), /database write failed/);

    assert.deepStrictEqual(requests, [{ url: 'https://api.telegram.org/botbot-token/sendMessage', body: { chat_id: '12345', text: 'Payment completed' } }]);
    assert.equal(updates.length, 1);
    assert.equal((updates[0] as { readonly data: { readonly botDeliveryStatus: string; readonly botMessageId: bigint } }).data.botDeliveryStatus, 'DELIVERED');
    assert.equal((updates[0] as { readonly data: { readonly botMessageId: bigint } }).data.botMessageId, BigInt(88));
    assert.equal(updates.some((update) => (update as { readonly data?: { readonly botDeliveryStatus?: string } }).data?.botDeliveryStatus === 'FAILED'), false);
    assert.equal(updates.some((update) => (update as { readonly data?: { readonly botDeliveryError?: string | null } }).data?.botDeliveryError === 'TELEGRAM_DELIVERY_FAILED'), false);
  });

  it('hides notification event identifiers in direct processing responses while preserving internal lookup', async () => {
    const lookedUpIds: string[] = [];
    const updates: unknown[] = [];
    const service = new UserNotificationBotDeliveryService(
      {
        userNotificationEvent: {
          findUnique: async (input: { readonly where: { readonly id: string } }) => {
            lookedUpIds.push(input.where.id);
            return { id: input.where.id, renderedText: 'Manual notification', botDeliveryStatus: 'PENDING', user: { telegramId: BigInt(12345), isBotBlocked: false } };
          },
          update: async (input: unknown) => { updates.push(input); },
        },
      } as never,
      { post: () => of({ data: { ok: true, result: { message_id: 99 } } }) } as never,
      { botToken: 'bot-token' } as never,
    );

    const result = await service.processEventById('event-secret-123');

    assert.deepStrictEqual(lookedUpIds, ['event-secret-123']);
    assert.equal(result.status, 'DELIVERED');
    assert.equal(result.eventId, null);
    assert.equal(JSON.stringify(result).includes('event-secret-123'), false);
    assert.equal((updates[0] as { readonly where: { readonly id: string } }).where.id, 'event-secret-123');
  });
});
