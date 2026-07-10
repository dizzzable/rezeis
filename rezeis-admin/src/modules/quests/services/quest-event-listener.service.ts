import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QuestType } from '@prisma/client';

import {
  EVENT_TYPES,
  SystemEventsService,
  type SystemEventPayload,
} from '../../../common/services/system-events.service';
import { QuestProgressService } from './quest-progress.service';

/**
 * Subscribes to the system-event bus and advances quest completions when the
 * underlying action happens. This is the FAST path only — the bus is
 * fire-and-forget with no delivery guarantee, so the catch-up reconciler is the
 * correctness backstop. Everything here is idempotent via QuestProgressService.
 *
 * INVITE_FRIENDS keys on `metadata.referrerId` (the earner), NEVER `userId`
 * (the referred user) — the REFERRAL_QUALIFIED event carries both.
 */
@Injectable()
export class QuestEventListenerService implements OnModuleInit {
  private readonly logger = new Logger(QuestEventListenerService.name);

  public constructor(
    private readonly systemEvents: SystemEventsService,
    private readonly progressService: QuestProgressService,
  ) {}

  public onModuleInit(): void {
    this.systemEvents.registerHook((event) => this.handle(event));
  }

  private async handle(event: SystemEventPayload & { timestamp: string }): Promise<void> {
    const metadata = (event.metadata ?? {}) as Record<string, unknown>;
    try {
      switch (event.type) {
        case EVENT_TYPES.USER_TELEGRAM_LINKED: {
          const userId = readString(metadata.userId);
          if (userId) await this.progressService.markCompleted(QuestType.LINK_TELEGRAM, userId);
          break;
        }
        case EVENT_TYPES.USER_EMAIL_LINKED: {
          const userId = readString(metadata.userId);
          if (userId) await this.progressService.markCompleted(QuestType.LINK_EMAIL, userId);
          break;
        }
        case EVENT_TYPES.REFERRAL_QUALIFIED: {
          const referrerId = readString(metadata.referrerId);
          if (referrerId) await this.progressService.advanceInvite(referrerId);
          break;
        }
        default:
          break;
      }
    } catch (err: unknown) {
      // Never let a quest hook disturb the event pipeline; the reconciler
      // repairs anything missed here.
      this.logger.warn(
        `Quest event hook failed for ${event.type}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
