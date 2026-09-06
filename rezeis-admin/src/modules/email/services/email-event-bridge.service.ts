import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  SystemEventsService,
  type SystemEventPayload,
} from '../../../common/services/system-events.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EmailDeliveryService } from './email-delivery.service';
import { coerceNotificationLocale } from '../../notifications/utils/notification-template-locale.util';

/**
 * Bridges SystemEventsService → Email delivery.
 *
 * Listens to system events via `registerHook()` and sends emails
 * for events that have:
 *   1. A matching notification template (by event type)
 *   2. A target user with an email address
 *   3. Email delivery enabled in settings
 *
 * Event types that trigger emails (configurable via Settings):
 *   - subscription.expired → user email
 *   - payment.completed → user email (receipt)
 *   - payment.failed → user email
 *   - auth.password_recovery → user email (reset link)
 *   - user.web_registered → user email (welcome)
 *
 * This service does NOT send emails for admin-only events (audit, system).
 */
@Injectable()
export class EmailEventBridgeService implements OnModuleInit {
  private readonly logger = new Logger(EmailEventBridgeService.name);

  public constructor(
    private readonly systemEventsService: SystemEventsService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly prismaService: PrismaService,
  ) {}

  public onModuleInit(): void {
    this.systemEventsService.registerHook((event) => {
      void this.handleEvent(event).catch((err) => {
        this.logger.warn(`Email bridge error: ${(err as Error).message}`);
      });
    });
    this.logger.log('Email event bridge installed');
  }

  private async handleEvent(event: SystemEventPayload & { timestamp: string }): Promise<void> {
    // Only process user-facing events that have a userId in metadata
    const userId = this.extractUserId(event.metadata);
    if (!userId) return;

    // Check if this event type has an email template
    const template = await this.prismaService.notificationTemplate.findUnique({
      where: { type: event.type },
      select: { isActive: true },
    });
    if (!template?.isActive) return;

    // Resolve user email
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        // Without this the letter is Russian for everybody.
        language: true,
        webAccount: { select: { email: true } },
      },
    });

    const email = user?.email ?? user?.webAccount?.email;
    if (!email) return;

    // Build variables from event metadata
    const variables: Record<string, string | number | null> = {
      name: user?.name ?? 'User',
      email,
      ...(event.metadata as Record<string, string | number | null> ?? {}),
    };

    await this.emailDeliveryService.send({
      to: email,
      // `event.message` is the operator's own audit sentence and is Russian.
      // It is inert today — the renderer honours `subject` only on the
      // `rawHtml` path — but leaving it here invites somebody to add that
      // branch and ship operator prose into a customer's inbox. The template's
      // own localized title is the subject, so say nothing.
      templateType: event.type,
      variables,
      locale: coerceNotificationLocale(user?.language),
    });
  }

  private extractUserId(metadata: Record<string, unknown> | undefined): string | null {
    if (!metadata) return null;
    const userId = metadata.userId;
    return typeof userId === 'string' && userId.length > 0 ? userId : null;
  }
}
