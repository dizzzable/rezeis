import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { WebhookDeliveryJobInterface } from '../interfaces/webhook-job.interface';
import { WEBHOOK_DELIVERY_QUEUE } from '../webhooks.constants';

/**
 * Thin BullMQ wrapper around the webhook delivery queue. Centralises job
 * options (jobId, removeOnComplete) so producers don't have to know about
 * the queue's invariants.
 */
@Injectable()
export class WebhookQueueService {
  public constructor(
    @InjectQueue(WEBHOOK_DELIVERY_QUEUE)
    private readonly queue: Queue<WebhookDeliveryJobInterface>,
  ) {}

  /**
   * Enqueues an immediate delivery attempt. The processor reads the row
   * from DB so we don't push large payloads through Redis.
   */
  public async enqueueImmediate(deliveryId: string): Promise<void> {
    await this.queue.add(
      'deliver',
      { deliveryId },
      {
        // Idempotency: if a job with the same id is already queued we
        // skip (BullMQ throws — we ignore on caller side via try/catch).
        // BullMQ rejects `:` in custom job ids so we use `__` instead.
        jobId: `deliver__${deliveryId}`,
        removeOnComplete: { count: 200, age: 3_600 },
        removeOnFail: { count: 500, age: 86_400 },
      },
    );
  }

  /**
   * Enqueues a delayed delivery (used for retries with backoff).
   */
  public async enqueueDelayed(deliveryId: string, delaySec: number): Promise<void> {
    await this.queue.add(
      'deliver',
      { deliveryId },
      {
        jobId: `deliver__${deliveryId}__${Date.now()}`,
        delay: delaySec * 1_000,
        removeOnComplete: { count: 200, age: 3_600 },
        removeOnFail: { count: 500, age: 86_400 },
      },
    );
  }
}
