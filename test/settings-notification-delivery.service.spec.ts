import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SettingsService } from '../src/modules/settings/services/settings.service';

describe('SettingsService notification delivery ops', () => {
  it('projects bounded notification problem events', async () => {
    const service = new SettingsService({
      userNotificationEvent: {
        findMany: async () => [
          { id: 'event-1', userId: 'user-1', type: 'PAYMENT_COMPLETED', botDeliveryStatus: 'FAILED', botDeliveryError: 'telegram failed https://api.telegram.org/botraw-token/sendMessage chat 123456 secret payload', botDeliveryAttemptedAt: null, createdAt: new Date('2026-04-24T12:00:00.000Z'), rawSecret: 'hidden' },
          { id: 'event-2', userId: 'user-2', type: 'PAYMENT_FAILED', botDeliveryStatus: 'FAILED', botDeliveryError: 'TELEGRAM_RECIPIENT_UNAVAILABLE', botDeliveryAttemptedAt: null, createdAt: new Date('2026-04-24T12:01:00.000Z'), rawSecret: 'hidden' },
        ],
      },
    } as never);

    const result = await service.listNotificationDeliveryProblemEvents();

    assert.deepStrictEqual(result.items, [
      { eventId: null, userId: null, type: 'PAYMENT_COMPLETED', status: 'FAILED', error: 'NOTIFICATION_DELIVERY_ERROR', attemptedAt: null, createdAt: '2026-04-24T12:00:00.000Z' },
      { eventId: null, userId: null, type: 'PAYMENT_FAILED', status: 'FAILED', error: 'TELEGRAM_RECIPIENT_UNAVAILABLE', attemptedAt: null, createdAt: '2026-04-24T12:01:00.000Z' },
    ]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('hidden'), false);
    assert.equal(serialized.includes('telegram failed'), false);
    assert.equal(serialized.includes('api.telegram.org'), false);
    assert.equal(serialized.includes('raw-token'), false);
    assert.equal(serialized.includes('123456'), false);
    assert.equal(serialized.includes('secret payload'), false);
    assert.equal(serialized.includes('event-1'), false);
    assert.equal(serialized.includes('event-2'), false);
    assert.equal(serialized.includes('user-1'), false);
    assert.equal(serialized.includes('user-2'), false);
  });

  it('enqueues notification delivery events through the queue service', async () => {
    const service = new SettingsService({} as never, undefined, undefined, {
      enqueueEvent: async (eventId: string) => ({ eventId, queueJobId: `deliver-notification-event:${eventId}`, enqueued: true, alreadyQueued: false }),
    } as never);

    const result = await service.enqueueNotificationDeliveryEvent('event-1');

    assert.deepStrictEqual(result, { eventId: 'event-1', queueJobId: 'deliver-notification-event:event-1', enqueued: true, alreadyQueued: false, reason: null });
  });

  it('marks manually enqueued notification events failed when enqueue fails', async () => {
    const updateCalls: unknown[] = [];
    const rawFailure = new Error('redis://:notification-secret@queue.internal payload telegram-token chat 123456');
    const service = new SettingsService({
      userNotificationEvent: {
        update: async (input: unknown) => {
          updateCalls.push(input);
          return {};
        },
      },
    } as never, undefined, undefined, {
      enqueueEvent: async () => {
        throw rawFailure;
      },
    } as never);

    await service.enqueueNotificationDeliveryEvent('event-failed').then(
      () => assert.fail('Expected enqueue failure'),
      (error) => assert.equal(error, rawFailure),
    );

    assert.equal(updateCalls.length, 1);
    assert.deepStrictEqual(updateCalls[0], {
      where: { id: 'event-failed' },
      data: {
        botDeliveryStatus: 'FAILED',
        botDeliveryAttemptedAt: (updateCalls[0] as { data: { botDeliveryAttemptedAt: Date } }).data.botDeliveryAttemptedAt,
        botDeliveryError: 'NOTIFICATION_DELIVERY_ENQUEUE_FAILED',
      },
    });
    assert.ok((updateCalls[0] as { data: { botDeliveryAttemptedAt: unknown } }).data.botDeliveryAttemptedAt instanceof Date);
    const serializedMarker = JSON.stringify(updateCalls);
    assert.equal(serializedMarker.includes('redis://'), false);
    assert.equal(serializedMarker.includes('notification-secret'), false);
    assert.equal(serializedMarker.includes('telegram-token'), false);
    assert.equal(serializedMarker.includes('123456'), false);
  });

  it('preserves the original manual enqueue failure when failure marker update fails', async () => {
    const rawFailure = new Error('BullMQ add failed with raw provider payload');
    const markerFailure = new Error('marker failed');
    const service = new SettingsService({
      userNotificationEvent: {
        update: async () => {
          throw markerFailure;
        },
      },
    } as never, undefined, undefined, {
      enqueueEvent: async () => {
        throw rawFailure;
      },
    } as never);

    await service.enqueueNotificationDeliveryEvent('event-failed').then(
      () => assert.fail('Expected enqueue failure'),
      (error) => assert.equal(error, rawFailure),
    );
  });
});
