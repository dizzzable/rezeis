import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { SystemEventsService } from '../../common/services/system-events.service';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';

/**
 * Wires the SystemEvents pipeline into the webhook dispatcher.
 *
 * Why a dedicated bridge?
 *   The dispatcher needs Prisma + BullMQ; SystemEventsService is wired
 *   in `SystemEventsModule` which sits in the common/ tree and must not
 *   know about feature modules. A thin bridge lets us keep the
 *   dependency graph one-way: WebhooksModule depends on
 *   SystemEventsModule, never the other way around.
 *
 * Hook semantics
 *   `SystemEventsService.registerHook()` invokes us asynchronously and
 *   swallows any throws. We just hand the event off to the dispatcher,
 *   which itself never throws on dispatch failure (logged + counted).
 */
@Injectable()
export class WebhookEventBridgeService implements OnModuleInit {
  private readonly logger = new Logger(WebhookEventBridgeService.name);

  public constructor(
    private readonly systemEventsService: SystemEventsService,
    private readonly dispatcherService: WebhookDispatcherService,
  ) {}

  public onModuleInit(): void {
    this.systemEventsService.registerHook(async (event) => {
      try {
        await this.dispatcherService.dispatch({
          type: event.type,
          category: event.category,
          severity: event.severity,
          message: event.message,
          metadata: event.metadata,
          timestamp: event.timestamp,
        });
      } catch (err) {
        this.logger.warn(`Webhook bridge failed for ${event.type}: ${(err as Error).message}`);
      }
    });
    this.logger.log('Webhook event bridge installed');
  }
}
