import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { remnawaveConfig } from '../../../common/config/remnawave.config';

/**
 * Handles incoming webhook events from the Remnawave panel.
 *
 * Events are stored in `RemnawaveWebhookEvent` for the Activity Feed
 * on the dashboard. The service validates HMAC-SHA256 signatures when
 * a webhook secret is configured.
 *
 * Known event types from Remnawave panel:
 *   - user.created, user.updated, user.deleted, user.limited, user.expired
 *   - node.created, node.offline, node.online
 *   - subscription.expired
 */
@Injectable()
export class RemnawaveWebhookService {
  private readonly logger = new Logger(RemnawaveWebhookService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(remnawaveConfig.KEY)
    private readonly configuration: ConfigType<typeof remnawaveConfig>,
  ) {}

  /**
   * Validates the webhook signature (HMAC-SHA256).
   * Returns true if valid or if no secret is configured (open mode).
   */
  public validateSignature(rawBody: string, signature: string | undefined): boolean {
    const secret = this.configuration.webhookSecret;
    if (!secret) {
      // No secret configured — accept all (dev mode)
      return true;
    }
    if (!signature) {
      return false;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return signature === expected;
  }

  /**
   * Processes and stores an incoming webhook event.
   */
  public async handleEvent(
    eventType: string,
    payload: Record<string, unknown>,
    sourceIp: string | null,
  ): Promise<void> {
    // Sanitize payload — remove any sensitive fields
    const sanitized = this.sanitizePayload(payload);

    await this.prismaService.remnawaveWebhookEvent.create({
      data: {
        eventType,
        payload: JSON.parse(JSON.stringify(sanitized)),
        sourceIp,
        isProcessed: false,
      },
    });

    this.logger.log(`Webhook event received: ${eventType}`);
  }

  /**
   * Returns recent webhook events for the Activity Feed.
   */
  public async getRecentEvents(limit = 50): Promise<WebhookEventSummary[]> {
    const events = await this.prismaService.remnawaveWebhookEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventType: true,
        payload: true,
        createdAt: true,
        isProcessed: true,
      },
    });

    return events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      payload: e.payload as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
      isProcessed: e.isProcessed,
    }));
  }

  /**
   * Marks events as processed.
   */
  public async markProcessed(ids: string[]): Promise<void> {
    await this.prismaService.remnawaveWebhookEvent.updateMany({
      where: { id: { in: ids } },
      data: { isProcessed: true },
    });
  }

  /**
   * Removes sensitive fields from webhook payloads before storage.
   */
  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...payload };
    // Remove potential secrets
    delete sanitized['subscriptionUrl'];
    delete sanitized['subscription_url'];
    delete sanitized['token'];
    delete sanitized['api_token'];
    return sanitized;
  }
}

export interface WebhookEventSummary {
  readonly id: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly isProcessed: boolean;
}
