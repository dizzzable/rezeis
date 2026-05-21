import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { redisConfig } from '../../common/config/redis.config';
import { AuthModule } from '../auth/auth.module';
import { AutomationActionRegistry } from './actions/action-registry';
import { AutomationEventBridgeService } from './automation-event-bridge.service';
import { AutomationExecutorService } from './automation-executor.service';
import { AutomationProcessor } from './automation.processor';
import { AutomationQueueService } from './automation-queue.service';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { AUTOMATION_QUEUE } from './automations.constants';

/**
 * Automations module — IFTTT-style rule engine.
 *
 * Two trigger sources funnel into one BullMQ queue:
 *   - Realtime events emitted by `SystemEventsService` (via the bridge
 *     hook installed on `AutomationEventBridgeService.onModuleInit`).
 *   - Cron rules dispatched every minute by the same bridge service.
 *
 * Manual runs bypass the queue and call the executor synchronously so
 * the operator gets an immediate per-action result on the UI.
 */
@Module({
  imports: [
    AuthModule,
    HttpModule,
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (configuration: ConfigType<typeof redisConfig>) => ({
        connection: { url: configuration.url },
      }),
    }),
    BullModule.registerQueue({ name: AUTOMATION_QUEUE }),
  ],
  controllers: [AutomationsController],
  providers: [
    AutomationsService,
    AutomationActionRegistry,
    AutomationExecutorService,
    AutomationQueueService,
    AutomationProcessor,
    AutomationEventBridgeService,
  ],
  exports: [AutomationsService, AutomationQueueService],
})
export class AutomationsModule {}
