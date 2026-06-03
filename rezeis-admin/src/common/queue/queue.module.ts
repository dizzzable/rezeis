import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigType } from '@nestjs/config';

import { redisConfig } from '../config/redis.config';
import { BROADCAST_DELIVERY_QUEUE } from '../../modules/broadcast/broadcast.constants';
import { BACKUP_QUEUE } from '../../modules/backup/backup.constants';
import { IMPORT_QUEUE } from '../../modules/imports/imports.constants';
import { QueueMaintenanceService } from './queue-maintenance.service';
import { GracefulShutdownService } from './graceful-shutdown.service';
import { buildBoundedBullMqDefaultJobOptions } from './bullmq-enqueue-options';

/**
 * Global BullMQ connection + maintenance module.
 *
 * Responsibilities:
 *   1. Single `BullModule.forRootAsync()` — all feature modules share one
 *      Redis connection instead of each declaring their own.
 *   2. Registers queues needed by the maintenance service for cleanup.
 *   3. Runs periodic cleanup of stale jobs (every 6h in worker process).
 *
 * Feature modules still call `BullModule.registerQueue({ name })` in their
 * own module — that's fine, BullMQ deduplicates by name.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (configuration: ConfigType<typeof redisConfig>) => ({
        connection: { url: configuration.url },
        defaultJobOptions: buildBoundedBullMqDefaultJobOptions(),
      }),
    }),
    // Register queues for the maintenance service to inject
    BullModule.registerQueue(
      { name: BROADCAST_DELIVERY_QUEUE },
      { name: BACKUP_QUEUE },
      { name: IMPORT_QUEUE },
    ),
  ],
  providers: [QueueMaintenanceService, GracefulShutdownService],
  exports: [QueueMaintenanceService],
})
export class QueueModule {}
