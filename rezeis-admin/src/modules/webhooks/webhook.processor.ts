import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { WebhookDeliveryJobInterface } from './interfaces/webhook-job.interface';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { WEBHOOK_DELIVERY_QUEUE } from './webhooks.constants';

/**
 * BullMQ worker for the webhook delivery queue. Each job is a single
 * `(deliveryId)` tuple; the dispatcher reads the row from DB and performs
 * the HTTP attempt. We deliberately keep the processor thin — all retry
 * scheduling lives in the dispatcher so unit tests don't need a Redis
 * instance.
 */
@Processor(WEBHOOK_DELIVERY_QUEUE, { concurrency: 5 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  public constructor(private readonly dispatcher: WebhookDispatcherService) {
    super();
  }

  public async process(job: Job<WebhookDeliveryJobInterface>): Promise<void> {
    try {
      await this.dispatcher.processDelivery(job.data.deliveryId);
    } catch (err) {
      // The dispatcher itself catches transport-level errors and persists
      // them as `errorMessage`. Anything bubbling up here is a programming
      // bug — log and rethrow so BullMQ records the job failure.
      this.logger.error(
        `Webhook processor crashed on delivery ${job.data.deliveryId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
