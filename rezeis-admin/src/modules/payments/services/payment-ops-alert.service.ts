import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigType } from '@nestjs/config';
import {
  PaymentGatewayType,
  PaymentWebhookEvent,
} from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { paymentsConfig } from '../../../common/config/payments.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { readPaymentOpsAlertSettings } from '../../../common/utils/payment-ops-alert-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';

interface ReplayAlertContext {
  readonly reason: string;
  readonly force: boolean;
}

@Injectable()
export class PaymentOpsAlertService {
  private readonly logger = new Logger(PaymentOpsAlertService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    @Inject(paymentsConfig.KEY)
    private readonly configuration: ConfigType<typeof paymentsConfig>,
  ) {}

  public async notifyWebhookFailed(input: {
    readonly event: PaymentWebhookEvent;
  }): Promise<void> {
    await this.sendWebhookAlert({
      event: input.event,
      eventTag: '#event_webhook_failed',
      details: [
        `kind:webhook_failed`,
        `error:${redactPaymentDiagnosticMessage(input.event.lastError) ?? 'unknown'}`,
      ],
    });
  }

  public async notifyWebhookReplay(input: {
    readonly event: PaymentWebhookEvent;
    readonly context: ReplayAlertContext;
  }): Promise<void> {
    await this.sendWebhookAlert({
      event: input.event,
      eventTag: '#event_webhook_replay',
      details: [
        `kind:webhook_replay`,
        `force:${input.context.force ? 'true' : 'false'}`,
        `reason:${redactPaymentDiagnosticMessage(input.context.reason) ?? 'manual_replay'}`,
      ],
    });
  }

  private async sendWebhookAlert(input: {
    readonly event: PaymentWebhookEvent;
    readonly eventTag: string;
    readonly details: readonly string[];
  }): Promise<void> {
    const botToken = this.configuration.botToken;
    if (botToken === null) {
      return;
    }
    const settings = await this.readSettings();
    if (!settings.enabled || settings.chatId === null) {
      return;
    }
    const text = buildWebhookAlertMessage({
      event: input.event,
      eventTag: input.eventTag,
      baseHashtag: settings.hashtag,
      details: input.details,
      eventLink: this.buildEventLink(input.event.id),
    });

    const payload: Record<string, unknown> = {
      chat_id: settings.chatId,
      text,
      disable_web_page_preview: true,
    };
    if (settings.threadId !== null) {
      payload.message_thread_id = Number(settings.threadId);
    }

    try {
      await firstValueFrom(
        this.httpService.post(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          payload,
        ),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to send payment ops alert to Telegram: ${normalizeTelegramDeliveryError(error)}`,
      );
    }
  }

  private async readSettings(): Promise<{
    readonly enabled: boolean;
    readonly chatId: string | null;
    readonly threadId: string | null;
    readonly hashtag: string | null;
  }> {
    const settings = await this.prismaService.settings.findFirst({
      orderBy: { updatedAt: 'asc' },
      select: {
        systemNotifications: true,
      },
    });
    return readPaymentOpsAlertSettings(settings?.systemNotifications);
  }

  private buildEventLink(eventId: string): string | null {
    const adminPublicBaseUrl = this.configuration.domain;
    if (typeof adminPublicBaseUrl !== 'string' || adminPublicBaseUrl.trim().length === 0) {
      return null;
    }
    const normalizedBaseUrl = adminPublicBaseUrl.replace(/\/$/, '');
    return `${normalizedBaseUrl}/payments/webhooks?eventId=${encodeURIComponent(eventId)}`;
  }
}

function buildWebhookAlertMessage(input: {
  readonly event: PaymentWebhookEvent;
  readonly eventTag: string;
  readonly baseHashtag: string | null;
  readonly details: readonly string[];
  readonly eventLink: string | null;
}): string {
  const hashtags = [
    input.baseHashtag ?? '#payments_ops',
    '#payments_ops',
    input.eventTag,
    `#gateway_${normalizeTag(input.event.gatewayType)}`,
    `#status_${normalizeTag(input.event.status ?? 'unknown')}`,
  ];
  const detailLines = [
    `event_id:${input.event.id.length > 0 ? 'hidden' : 'missing'}`,
    `payment_id:${input.event.paymentId.length > 0 ? 'present' : 'missing'}`,
    `provider_event_id:${input.event.providerEventId.length > 0 ? 'present' : 'missing'}`,
    `gateway:${input.event.gatewayType}`,
    `status:${input.event.status}`,
    ...input.details,
    `link:${input.eventLink === null ? 'not_configured' : 'configured'}`,
  ];
  return [...hashtags, ...detailLines].join('\n');
}

function normalizeTag(value: string | PaymentGatewayType): string {
  return String(value).trim().toLowerCase();
}

function normalizeTelegramDeliveryError(error: unknown): string {
  const status = readHttpStatus(error);
  return status === null
    ? 'TELEGRAM_DELIVERY_FAILED'
    : `TELEGRAM_DELIVERY_FAILED (status ${status})`;
}

function readHttpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return null;
  }
  const response = (error as { readonly response?: unknown }).response;
  if (typeof response !== 'object' || response === null || !('status' in response)) {
    return null;
  }
  const status = (response as { readonly status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}
