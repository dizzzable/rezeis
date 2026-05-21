import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildNotificationDeliveryQueueId, NOTIFICATION_DELIVERY_JOB } from '../src/modules/user-activity/constants/notification-delivery-queue.constant';
import { NotificationDeliveryProcessor } from '../src/modules/user-activity/processors/notification-delivery.processor';
import { UserNotificationDeliveryQueueService } from '../src/modules/user-activity/services/user-notification-delivery-queue.service';

describe('UserNotificationDeliveryQueueService', () => {
  it('enqueues notification events with deterministic job ids', async () => {
    const additions: unknown[] = [];
    const service = new UserNotificationDeliveryQueueService(
      { userNotificationEvent: { findUnique: async () => ({ id: 'event-1' }) } } as never,
      { getJob: async () => null, add: async (...args: unknown[]) => { additions.push(args); } } as never,
    );

    const result = await service.enqueueEvent('event-1');

    assert.equal(result.enqueued, true);
    assert.equal(result.queueJobId, buildNotificationDeliveryQueueId('event-1'));
    assert.deepStrictEqual(additions, [[NOTIFICATION_DELIVERY_JOB, { eventId: 'event-1' }, { jobId: 'deliver-notification-event:event-1', removeOnComplete: 100, removeOnFail: 100 }]]);
  });

  it('does not enqueue duplicate queue jobs', async () => {
    const service = new UserNotificationDeliveryQueueService(
      { userNotificationEvent: { findUnique: async () => ({ id: 'event-1' }) } } as never,
      { getJob: async () => ({ id: 'notification-delivery:event-1' }), add: async () => { throw new Error('should not enqueue'); } } as never,
    );

    const result = await service.enqueueEvent('event-1');

    assert.equal(result.enqueued, false);
    assert.equal(result.alreadyQueued, true);
  });

  it('continues enqueueing with deterministic options when duplicate inspection fails', async () => {
    const additions: unknown[] = [];
    const service = new UserNotificationDeliveryQueueService(
      { userNotificationEvent: { findUnique: async () => ({ id: 'event-1' }) } } as never,
      {
        getJob: async () => { throw new Error('redis://admin:secret-password@queue.internal telegram payload token_secret'); },
        add: async (...args: unknown[]) => { additions.push(args); },
      } as never,
    );

    const result = await service.enqueueEvent('event-1');

    assert.equal(result.enqueued, true);
    assert.equal(result.alreadyQueued, false);
    assert.deepStrictEqual(additions, [[NOTIFICATION_DELIVERY_JOB, { eventId: 'event-1' }, { jobId: 'deliver-notification-event:event-1', removeOnComplete: 100, removeOnFail: 100 }]]);
  });

  it('sanitizes notification enqueue failures after preserving deterministic add arguments', async () => {
    const additions: unknown[] = [];
    const service = new UserNotificationDeliveryQueueService(
      { userNotificationEvent: { findUnique: async () => ({ id: 'event-1' }) } } as never,
      {
        getJob: async () => null,
        add: async (...args: unknown[]) => {
          additions.push(args);
          throw new Error('redis://admin:secret-password@queue.internal telegram_token=secret payload event-1');
        },
      } as never,
    );

    await assert.rejects(
      service.enqueueEvent('event-1'),
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).name, 'BullMqEnqueueError');
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('telegram_token'), false);
        assert.equal(serialized.includes('redis://'), false);
        return true;
      },
    );
    assert.deepStrictEqual(additions, [[NOTIFICATION_DELIVERY_JOB, { eventId: 'event-1' }, { jobId: 'deliver-notification-event:event-1', removeOnComplete: 100, removeOnFail: 100 }]]);
  });
});

describe('NotificationDeliveryProcessor', () => {
  it('processes queued notification delivery jobs by event id', async () => {
    const calls: string[] = [];
    const processor = new NotificationDeliveryProcessor(
      { processEventById: async (eventId: string) => { calls.push(eventId); return { eventId, status: 'DELIVERED' }; } } as never,
      { observe: async (_job: unknown, _descriptor: unknown, handler: () => Promise<void>) => handler(), recordSkipped: () => undefined } as never,
    );

    await processor.process({ name: NOTIFICATION_DELIVERY_JOB, data: { eventId: 'event-1' } } as never);

    assert.deepStrictEqual(calls, ['event-1']);
  });
});
