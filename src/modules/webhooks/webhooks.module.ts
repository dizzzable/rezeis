import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { redisConfig } from '../../common/config/redis.config';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminWebhooksController } from './controllers/admin-webhooks.controller';
import { WebhookDeliveriesService } from './services/webhook-deliveries.service';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { WebhookQueueService } from './services/webhook-queue.service';
import { WebhookSubscriptionsService } from './services/webhook-subscriptions.service';
import { WebhookEventBridgeService } from './webhook-event-bridge.service';
import { WebhookProcessor } from './webhook.processor';
import { WEBHOOK_DELIVERY_QUEUE } from './webhooks.constants';

/**
 * Phase 6 — Webhook Subscriptions + Delivery History.
 *
 * Surfaces
 *   - `WebhookSubscriptionsService`: CRUD for outgoing webhook endpoints.
 *   - `WebhookDeliveriesService`: read-side for the per-attempt history.
 *   - `WebhookDispatcherService`: fan-out + actual HTTP delivery with
 *     HMAC signing, retry, and auto-disable.
 *   - `WebhookEventBridgeService`: hooks into `SystemEventsService` so
 *     every emitted event is offered to the dispatcher.
 *
 * The `BullMQ` queue (`webhook-delivery`) decouples the HTTP attempt
 * from the originating request; retries with exponential backoff live
 * in the dispatcher (the queue is just the transport).
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    HttpModule,
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (configuration: ConfigType<typeof redisConfig>) => ({
        connection: { url: configuration.url },
      }),
    }),
    BullModule.registerQueue({ name: WEBHOOK_DELIVERY_QUEUE }),
  ],
  controllers: [AdminWebhooksController],
  providers: [
    WebhookSubscriptionsService,
    WebhookDeliveriesService,
    WebhookDispatcherService,
    WebhookQueueService,
    WebhookEventBridgeService,
    WebhookProcessor,
  ],
  exports: [
    WebhookSubscriptionsService,
    WebhookDispatcherService,
  ],
})
export class WebhooksModule {}
