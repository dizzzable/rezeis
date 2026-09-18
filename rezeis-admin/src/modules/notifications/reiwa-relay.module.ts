import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { SystemEventsService } from '../../common/services/system-events.service';
import { REIWA_RELAY_QUEUE } from './reiwa-relay.constants';
import { emitRelayUndelivered, ReiwaRelayProcessor } from './reiwa-relay.processor';
import { BotNotifierClient } from './services/bot-notifier.client';
import { ReiwaRelayQueueService } from './services/reiwa-relay-queue.service';
import { createUndeliveredRecorder, gateRedisOf, UndeliveredAlertGate } from './undelivered-alert-gate';
import {
  describeRelayRepeats,
  RELAY_UNDELIVERED_RECORDER,
  type UndeliveredRecorder,
} from './undelivered-record';

/**
 * The recorder both relay roads write through: the alert gate, then the
 * `reiwa.relay_undelivered` emit. Exported so the wiring can be exercised as
 * the module builds it, not as a spec imagines it.
 *
 * The gate keeps its windows on the relay queue's own Redis connection, which
 * the API container and the worker share; see `undelivered-alert-gate.ts` for
 * why a window in memory would not do, and what happens when Redis is away.
 * `gateRedisOf` hands it the ioredis client under that connection, which is
 * what its commands need, rather than the BullMQ-typed one.
 */
export function buildRelayUndeliveredRecorder(
  events: Pick<SystemEventsService, 'warn'>,
  queue: Pick<Queue, 'client'>,
): UndeliveredRecorder {
  return createUndeliveredRecorder({
    gate: new UndeliveredAlertGate(() => gateRedisOf(queue)),
    emit: (record) => emitRelayUndelivered(events, record),
    describeRepeats: describeRelayRepeats,
  });
}

/**
 * ReiwaRelayModule
 *
 * Owns the durable `reiwa-relay` queue: the producer every caller injects and
 * the processor that performs the signed HTTP relay.
 *
 * Declares its own `BotNotifierClient` rather than importing
 * `NotificationsModule` — that module drags in web-push and settings, and the
 * reason `BackupModule` provides its own: it is a stateless client that reads
 * two env vars in its constructor, so a second instance costs nothing and buys
 * a module with no inbound edges.
 *
 * `RELAY_UNDELIVERED_RECORDER` is bound HERE, and not by the producer injecting
 * `SystemEventsService` itself, because that service imports the producer —
 * see `undelivered-record.ts` for the cycle this keeps out of the file graph.
 * `SystemEventsService` comes from the global `SystemEventsModule`. The
 * processor takes the same token, so both roads share one alert window.
 */
@Module({
  imports: [BullModule.registerQueue({ name: REIWA_RELAY_QUEUE })],
  providers: [
    BotNotifierClient,
    ReiwaRelayQueueService,
    ReiwaRelayProcessor,
    {
      provide: RELAY_UNDELIVERED_RECORDER,
      inject: [SystemEventsService, getQueueToken(REIWA_RELAY_QUEUE)],
      useFactory: buildRelayUndeliveredRecorder,
    },
  ],
  exports: [ReiwaRelayQueueService],
})
export class ReiwaRelayModule {}
