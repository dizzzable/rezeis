import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { REIWA_RELAY_QUEUE } from './reiwa-relay.constants';
import { ReiwaRelayProcessor } from './reiwa-relay.processor';
import { BotNotifierClient } from './services/bot-notifier.client';
import { ReiwaRelayQueueService } from './services/reiwa-relay-queue.service';

/**
 * ReiwaRelayModule
 * ════════════════
 * Durable delivery for the panel → cabinet webhooks. Small and dependency-free
 * on purpose: both `NotificationsModule` and `BotConfigModule` need to enqueue,
 * and folding the queue into either would make the other import a module full
 * of controllers to reach one producer — or force a cycle.
 *
 * `BotNotifierClient` is provided here rather than imported for the same
 * reason `BackupModule` provides its own: it is a stateless client that reads
 * two env vars in its constructor, so a second instance costs nothing and buys
 * a module with no inbound edges.
 */
@Module({
  imports: [BullModule.registerQueue({ name: REIWA_RELAY_QUEUE })],
  providers: [BotNotifierClient, ReiwaRelayQueueService, ReiwaRelayProcessor],
  exports: [ReiwaRelayQueueService],
})
export class ReiwaRelayModule {}
