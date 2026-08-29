import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { OutboundHttpModule } from '../../common/http/outbound-http.module';
import { AuthModule } from '../auth/auth.module';
import { UserHintsModule } from '../user-hints/user-hints.module';
import { UsersModule } from '../users/users.module';
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
    OutboundHttpModule,
    // For `UserBlockService`. The `block_user` action wrote `isBlocked = true`
    // and nothing else — no identity capture, no device capture, no IP capture,
    // no sync job and no dropped connections — so a rule firing at 03:00
    // flagged an account whose tunnel kept carrying traffic indefinitely. Of
    // the three writers of that column it is the one that runs unattended,
    // which makes it the worst place for the flag to be the only effect.
    UsersModule,
    // For `UserHintDeliveryService`: the `show_hint` action queues a hint
    // rather than showing one, because a rule fires when its event arrives
    // and the customer is, as a rule, not looking at that moment.
    UserHintsModule,
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
