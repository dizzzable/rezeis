import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { TELEGRAM_DIRECT_QUEUE } from './telegram-direct.constants';
import { TelegramDirectProcessor } from './telegram-direct.processor';
import { TelegramDirectClient } from './services/telegram-direct.client';
import { TelegramDirectQueueService } from './services/telegram-direct-queue.service';

/**
 * TelegramDirectModule
 * ════════════════════
 * Sibling of `ReiwaRelayModule`, and small for the same reason: the only thing
 * that needs to import it is whoever wants to enqueue, and folding it into
 * `NotificationsModule` would drag a module full of controllers along for one
 * producer.
 *
 * Kept as a SEPARATE module rather than more providers inside the relay module
 * so the two routes stay visibly distinct in the dependency graph. They are
 * alternatives, not layers: an event takes one or the other, never both, and a
 * single module holding both would invite exactly the "just call the other one
 * too" edit that produces duplicate operator cards.
 */
@Module({
  imports: [BullModule.registerQueue({ name: TELEGRAM_DIRECT_QUEUE })],
  providers: [TelegramDirectClient, TelegramDirectQueueService, TelegramDirectProcessor],
  exports: [TelegramDirectQueueService, TelegramDirectClient],
})
export class TelegramDirectModule {}
