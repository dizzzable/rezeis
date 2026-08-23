import { createHash } from 'node:crypto';
import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import {
  PaymentGatewayType,
  PaymentWebhookEvent,
} from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { paymentsConfig } from '../../../common/config/payments.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { readPaymentOpsAlertSettings } from '../../../common/utils/payment-ops-alert-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import { SettingsService } from '../../settings/services/settings.service';
import { ReiwaRelayQueueService } from '../../notifications/services/reiwa-relay-queue.service';

interface ReplayAlertContext {
  readonly reason: string;
  readonly force: boolean;
}

@Injectable()
export class PaymentOpsAlertService {
  private readonly logger = new Logger(PaymentOpsAlertService.name);

  /**
   * How long one reason stays quiet after it has been logged once.
   *
   * Volume is the whole reason this exists: `notifyWebhookFailed` fires once
   * per failed webhook, so a provider outage on a misconfigured panel would
   * put one error line per webhook into the log - thousands during an
   * incident, which is how a real signal gets thrown away. The first line
   * (the one an incident responder greps for) always goes out, and the next
   * line for the same reason says how many it stood for, so nothing is
   * hidden either.
   */
  private static readonly PROBLEM_LOG_WINDOW_MS = 5 * 60_000;

  /** Per-reason `{ last logged at, suppressed since }`. */
  private readonly problemLogState = new Map<
    string,
    { at: number; suppressed: number }
  >();

  /**
   * Lazily resolved once. `null` in a runtime where `ReiwaRelayModule` is not
   * registered, which is the same thing `SystemEventsService.resolveRelayQueue`
   * allows for.
   */
  private relayQueue: ReiwaRelayQueueService | null = null;
  private relayQueueResolved = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    @Inject(paymentsConfig.KEY)
    private readonly configuration: ConfigType<typeof paymentsConfig>,
    /**
     * Source of the panel-managed bot token. `@Optional()` only so the specs
     * that construct this service positionally keep compiling; DI always
     * supplies it - `PaymentsModule` imports `SettingsModule`, which exports
     * `SettingsService`.
     */
    @Optional()
    private readonly settingsService?: SettingsService,
    /**
     * Container handle for the lazy relay lookup. `@Optional()` for the same
     * reason as `settingsService` above: the specs construct this service
     * positionally. Nest always provides `ModuleRef`.
     */
    @Optional()
    private readonly moduleRef?: ModuleRef,
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
    const settings = await this.readSettings();
    // Switched off by the operator. Silence is the correct behaviour here and
    // this is the only one of these branches that is not a fault.
    if (!settings.enabled) {
      return;
    }
    if (settings.chatId === null) {
      this.reportUndeliverable(
        'ALERT_CHAT_NOT_CONFIGURED',
        'Alerts are enabled but no chat id is stored. Set one in Notifications -> Delivery settings -> Payment webhook alerts.',
      );
      return;
    }
    const text = buildWebhookAlertMessage({
      event: input.event,
      eventTag: input.eventTag,
      baseHashtag: settings.hashtag,
      details: input.details,
      eventLink: this.buildEventLink(input.event.id),
    });

    const botToken = await this.resolveBotToken();
    if (botToken === null) {
      // No local token. On the standard split deployment this product ships,
      // the bot token lives in reiwa and NOT here - `system-events.service.ts`
      // says so at its own relay branch - so this is the NORMAL state, not a
      // misconfiguration, and the card goes to the same relay that service and
      // `BackupService` fall back to instead of being dropped.
      //
      // Direct-first ordering matches both of them: a host that HAS a token
      // must not pay for a queue and a network hop it does not need.
      await this.relayViaReiwa({
        event: input.event,
        eventTag: input.eventTag,
        chatId: settings.chatId,
        threadId: settings.threadId,
        text,
      });
      return;
    }

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

  /**
   * Panel-managed (encrypted) token first, env `BOT_TOKEN` second.
   *
   * This method is the defect. `sendWebhookAlert` used to read only
   * `paymentsConfig.botToken`, which is `process.env.BOT_TOKEN`. On a
   * deployment that keeps every setting in the panel - the rule this product
   * is built around - that value is absent, so every alert died at the guard
   * above without a word.
   *
   * Same order as `BroadcastMediaUploadService.resolveBotToken` and
   * `BackupService.resolveBotToken`. The environment value stays a fallback
   * on purpose: a deployment that genuinely sets it would otherwise lose
   * alerting the moment this shipped, which is its own outage.
   *
   * Never throws. Neither caller of `notifyWebhook*` guards it -
   * `PaymentReconciliationService` calls it from a catch block before
   * re-throwing the original error, and `PaymentWebhookOpsService` calls it
   * in the middle of an admin replay - so a database hiccup in here must not
   * become their failure.
   */
  private async resolveBotToken(): Promise<string | null> {
    try {
      const stored = (await this.settingsService?.getDecryptedBotToken()) ?? null;
      if (stored !== null && stored.length > 0) {
        return stored;
      }
    } catch {
      this.throttledError(
        'BOT_TOKEN_LOOKUP_FAILED',
        'Payment ops alert: reading the panel-managed Telegram bot token failed; falling back to the environment value.',
      );
    }
    return this.configuration.botToken;
  }

  /**
   * Split-deployment fallback: hand the alert to the durable reiwa relay.
   *
   * Why this exists at all: on the standard split deployment the Telegram bot
   * token lives in reiwa, not in rezeis. `SystemEventsService` states that at
   * its own relay branch and routes the card through the relay rather than
   * dropping it; `BackupService.deliverToTelegram` does the same, gating on
   * `botNotifier.isEnabled` and reporting `relay_unavailable`. This service was
   * the ONLY Telegram sender in the tree with no such fallback, so on that
   * deployment a payment webhook failure reached nobody even with the panel
   * token fix in place.
   *
   * Through `ReiwaRelayQueueService`, never `BotNotifierClient` directly:
   * `RELAY_DIRECT_DELIVERY_EXCEPTIONS` names the files allowed to bypass the
   * queue and `test/reiwa-relay-bypass-invariant.spec.ts` fails on any caller
   * that is not on that list. The queue is also the better answer on its own
   * merits - `enqueue` never throws, which is exactly what the un-guarded
   * callers of `notifyWebhook*` need, and it retries four times with backoff.
   *
   * NO `parseMode`. The direct path posts `text` with no `parse_mode`, and
   * `redactPaymentDiagnosticMessage` does not escape markup - a provider error
   * carrying `<` or `&` would be read as HTML, mangling the alert or being
   * rejected outright by Telegram, which the relay treats as terminal. Both
   * paths have to render the same bytes.
   */
  private async relayViaReiwa(input: {
    readonly event: PaymentWebhookEvent;
    readonly eventTag: string;
    readonly chatId: string;
    readonly threadId: string | null;
    readonly text: string;
  }): Promise<void> {
    const queue = this.resolveRelayQueue();
    if (queue === null || !queue.isEnabled) {
      this.reportUndeliverable(
        'BOT_TOKEN_NOT_CONFIGURED',
        'Alerts are enabled but there is no Telegram bot token here and no reiwa relay to send through. Add a token in Settings -> Bot Token.',
      );
      return;
    }
    const queued = await queue.enqueue('reiwa.channel.broadcast', {
      eventId: buildRelayEventId(input.event, input.eventTag),
      chatId: input.chatId,
      ...(input.threadId === null ? {} : { topicThreadId: Number(input.threadId) }),
      text: input.text,
    });
    if (!queued) {
      // The queue refused the job (Redis) and has already made one direct
      // attempt whose outcome it logged itself, so this is `not confirmed`
      // rather than `not delivered` - and its remedy is a different place
      // entirely from a missing token: the cabinet link and Redis, not the
      // panel. Its own code so an operator can tell the two apart.
      this.throttledError(
        'RELAY_UNAVAILABLE',
        'Payment ops alert could not be queued for the reiwa relay; one direct attempt was made instead. Check the cabinet link and Redis.',
      );
    }
  }

  /** The same lazy `ModuleRef` lookup `SystemEventsService` uses for this. */
  private resolveRelayQueue(): ReiwaRelayQueueService | null {
    if (this.relayQueueResolved) return this.relayQueue;
    this.relayQueueResolved = true;
    try {
      this.relayQueue =
        this.moduleRef?.get(ReiwaRelayQueueService, { strict: false }) ?? null;
    } catch {
      this.relayQueue = null;
    }
    return this.relayQueue;
  }

  /**
   * An alert that could not be delivered for a reason the operator can fix.
   * Error level and a stable bracketed reason code, so it is greppable.
   */
  private reportUndeliverable(reason: string, remedy: string): void {
    this.throttledError(
      reason,
      `Payment ops alert NOT delivered. ${remedy}`,
    );
  }

  /** One line per reason per window; the next one carries the backlog count. */
  private throttledError(reason: string, message: string): void {
    const now = Date.now();
    const previous = this.problemLogState.get(reason);
    if (
      previous !== undefined &&
      now - previous.at < PaymentOpsAlertService.PROBLEM_LOG_WINDOW_MS
    ) {
      previous.suppressed += 1;
      return;
    }
    const suppressed = previous?.suppressed ?? 0;
    this.problemLogState.set(reason, { at: now, suppressed: 0 });
    this.logger.error(
      suppressed > 0
        ? `[${reason}] ${message} (${suppressed} further occurrence(s) suppressed since the previous line.)`
        : `[${reason}] ${message}`,
    );
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

/**
 * Idempotency key for one relayed alert.
 *
 * `reiwa.channel.broadcast` is `botDedupKeyed`, and the cabinet validates this
 * field with a REQUIRED `.max(128)` and no soft fallback - an over-long key is
 * a 400, which the relay reads as non-transient and the alert is lost outright.
 * 39 characters, always.
 *
 * HASHED, never the raw id. `buildWebhookAlertMessage` deliberately renders
 * `event_id:hidden`, and `payment-ops-alert-delivery.service.spec.ts` pins that
 * the raw id never appears in an alert; putting it in the relay metadata would
 * send it out of rezeis by another door. A digest keys the bot's dedup just as
 * well and carries nothing.
 *
 * `updatedAt` is in the input so a LATER failure of the same webhook is a new
 * alert rather than one the bot silently swallows, while every retry of one
 * queued job keeps the same key - the value is frozen into the payload at
 * enqueue, exactly as `deliverViaReiwaBroadcast` freezes the event timestamp.
 */
function buildRelayEventId(event: PaymentWebhookEvent, eventTag: string): string {
  const transition =
    event.updatedAt instanceof Date
      ? event.updatedAt.toISOString()
      : String(event.updatedAt ?? '');
  const digest = createHash('sha256')
    .update(`${event.id}:${eventTag}:${transition}`)
    .digest('hex')
    .slice(0, 32);
  return `payops:${digest}`;
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
