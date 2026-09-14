import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { SystemEventsService } from '../../common/services/system-events.service';
import { TELEGRAM_DIRECT_QUEUE } from './telegram-direct.constants';
import { emitTelegramDirectUndelivered, TelegramDirectProcessor } from './telegram-direct.processor';
import { TelegramDirectClient } from './services/telegram-direct.client';
import { TelegramDirectQueueService } from './services/telegram-direct-queue.service';
import { createUndeliveredRecorder, UndeliveredAlertGate } from './undelivered-alert-gate';
import {
  describeTelegramDirectRepeats,
  TELEGRAM_DIRECT_UNDELIVERED_RECORDER,
  type UndeliveredRecorder,
} from './undelivered-record';

/**
 * The recorder both Telegram roads write through: the alert gate, then the
 * `telegram.direct_undelivered` emit. The sibling of
 * `buildRelayUndeliveredRecorder`, on this queue's own connection.
 */
export function buildTelegramDirectUndeliveredRecorder(
  events: Pick<SystemEventsService, 'warn'>,
  queue: Pick<Queue, 'client'>,
): UndeliveredRecorder {
  return createUndeliveredRecorder({
    gate: new UndeliveredAlertGate(() => queue.client),
    emit: (record) => emitTelegramDirectUndelivered(events, record),
    describeRepeats: describeTelegramDirectRepeats,
  });
}

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
 *
 * The recorder token is bound here for the reason `ReiwaRelayModule` gives for
 * its own: the producer must not import `SystemEventsService`, which imports it.
 * The processor takes the same token, so both roads share one alert window.
 */
@Module({
  imports: [BullModule.registerQueue({ name: TELEGRAM_DIRECT_QUEUE })],
  providers: [
    TelegramDirectClient,
    TelegramDirectQueueService,
    TelegramDirectProcessor,
    {
      provide: TELEGRAM_DIRECT_UNDELIVERED_RECORDER,
      inject: [SystemEventsService, getQueueToken(TELEGRAM_DIRECT_QUEUE)],
      useFactory: buildTelegramDirectUndeliveredRecorder,
    },
  ],
  exports: [TelegramDirectQueueService, TelegramDirectClient],
})
export class TelegramDirectModule {}
