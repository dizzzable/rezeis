/**
 * SystemEventsService
 * ───────────────────
 * Central event bus for rezeis-admin. Every significant action in the system
 * emits an event through this service. Events are:
 *
 *   1. Persisted to `AdminAuditLog` (always) — queryable from admin UI.
 *   2. Delivered via webhook (when WEBHOOK_ENABLED=true) — signed HTTP POST
 *      to configured URL(s) with HMAC-SHA256 signature.
 *   3. Logged to stdout (always) — for container log aggregation.
 *
 * Event categories:
 *   - USER: registration, block, delete, role change
 *   - AUTH: web login, web register, telegram link, password change
 *   - SUBSCRIPTION: created, renewed, upgraded, expired, deleted, synced
 *   - PAYMENT: checkout created, completed, failed, webhook received
 *   - REFERRAL: attached, qualified, reward issued
 *   - PARTNER: created, earning, withdrawal request/approve/reject
 *   - PROMOCODE: activated, created, depleted
 *   - SYSTEM: startup, backup, broadcast, error
 *
 * Donor parity: altshop `notification_service.system_notify()` sends events
 * to DEV users via Telegram. We replace that with webhook + audit log since
 * rezeis-admin has no bot — the admin panel shows events in real-time.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { ModuleRef } from '@nestjs/core';
import { firstValueFrom } from 'rxjs';

import { webhookConfig } from '../config/webhook.config';
import { buildWebhookSignature } from '../http/webhook-signature.util';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../../modules/realtime/realtime.gateway';
import {
  resolveTelegramDeliveryTarget,
  isEventTelegramAllowed,
} from './telegram-delivery-target.util';
import {
  buildErrorReportFilename,
  formatErrorEventCardHtml,
  formatErrorReportTxt,
  getRezeisBuildInfo,
  isErrorEvent,
  type ErrorReportEvent,
} from './error-report.util';
import { resolveErrorReportsDir, writeErrorReport } from './error-report-archive.util';
import { BotNotifierClient } from '../../modules/notifications/services/bot-notifier.client';

// ── Event Types ─────────────────────────────────────────────────────────────

export type SystemEventCategory =
  | 'USER'
  | 'AUTH'
  | 'SUBSCRIPTION'
  | 'DEVICE'
  | 'PAYMENT'
  | 'REFERRAL'
  | 'PARTNER'
  | 'PROMOCODE'
  | 'SUPPORT'
  | 'FRAUD'
  | 'NODE'
  | 'REMNAWAVE'
  | 'SYSTEM';

export type SystemEventSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface SystemEventPayload {
  /** Machine-readable event type, e.g. "user.registered", "payment.completed" */
  readonly type: string;
  /** Human-readable category for filtering */
  readonly category: SystemEventCategory;
  /** Severity level */
  readonly severity: SystemEventSeverity;
  /** Short human-readable description */
  readonly message: string;
  /** Structured metadata (user IDs, amounts, plan names, etc.) */
  readonly metadata?: Record<string, unknown>;
  /** Admin who triggered the event (null for system-initiated) */
  readonly adminId?: string | null;
  /** Timestamp (auto-filled if not provided) */
  readonly timestamp?: string;
}

// ── Predefined Event Types ──────────────────────────────────────────────────

export const EVENT_TYPES = {
  // User
  USER_REGISTERED: 'user.registered',
  USER_WEB_REGISTERED: 'user.web_registered',
  USER_BLOCKED: 'user.blocked',
  USER_UNBLOCKED: 'user.unblocked',
  USER_DELETED: 'user.deleted',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_TELEGRAM_LINKED: 'user.telegram_linked',
  USER_EMAIL_LINKED: 'user.email_linked',
  USER_ACCOUNTS_MERGED: 'user.accounts_merged',

  // Auth
  AUTH_WEB_LOGIN: 'auth.web_login',
  AUTH_PASSWORD_CHANGED: 'auth.password_changed',
  AUTH_PASSWORD_RECOVERY: 'auth.password_recovery',

  // Subscription
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_RENEWED: 'subscription.renewed',
  SUBSCRIPTION_UPGRADED: 'subscription.upgraded',
  SUBSCRIPTION_EXPIRED: 'subscription.expired',
  SUBSCRIPTION_DELETED: 'subscription.deleted',
  SUBSCRIPTION_SYNCED: 'subscription.synced',
  SUBSCRIPTION_TRIAL_GRANTED: 'subscription.trial_granted',
  SUBSCRIPTION_DEVICE_REVOKED: 'user_hwid_revoked',

  // Payment
  PAYMENT_CHECKOUT_CREATED: 'payment.checkout_created',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_EXPIRED: 'payment.expired',
  PAYMENT_WEBHOOK_RECEIVED: 'payment.webhook_received',
  PAYMENT_FULFILLMENT_RECOVERED: 'payment.fulfillment_recovered',
  PAYMENT_METHOD_SAVED: 'payment.method_saved',
  PAYMENT_METHOD_UNBOUND: 'payment.method_unbound',

  // Referral
  REFERRAL_ATTACHED: 'referral.attached',
  REFERRAL_QUALIFIED: 'referral.qualified',
  REFERRAL_REWARD_ISSUED: 'referral.reward_issued',
  REFERRAL_MANUAL_ATTACHED: 'referral.manual_attached',

  // Partner
  PARTNER_CREATED: 'partner.created',
  PARTNER_ACTIVATED: 'partner.activated',
  PARTNER_DEACTIVATED: 'partner.deactivated',
  PARTNER_EARNING: 'partner.earning',
  PARTNER_WITHDRAWAL_REQUESTED: 'partner.withdrawal_requested',
  PARTNER_WITHDRAWAL_APPROVED: 'partner.withdrawal_approved',
  PARTNER_WITHDRAWAL_REJECTED: 'partner.withdrawal_rejected',
  PARTNER_BALANCE_ADJUSTED: 'partner.balance_adjusted',

  // Promocode
  PROMOCODE_ACTIVATED: 'promocode.activated',
  PROMOCODE_CREATED: 'promocode.created',
  PROMOCODE_DEPLETED: 'promocode.depleted',
  PROMOCODE_ARCHIVED: 'promocode.archived',

  // Support
  SUPPORT_TICKET_CREATED: 'support.ticket_created',
  SUPPORT_TICKET_USER_REPLY: 'support.ticket_user_reply',

  // Anti-fraud
  FRAUD_SIGNAL_OPENED: 'fraud.signal_opened',
  FRAUD_CONNECTIONS_DROPPED: 'fraud.connections_dropped',

  // Remnawave panel (forwarded webhook events)
  REMNAWAVE_USER_FIRST_CONNECTED: 'remnawave.user.first_connected',
  REMNAWAVE_USER_EXPIRED: 'remnawave.user.expired',
  REMNAWAVE_USER_LIMITED: 'remnawave.user.limited',
  REMNAWAVE_USER_EXPIRE_SOON: 'remnawave.user.expire_soon',
  REMNAWAVE_USER_ENABLED: 'remnawave.user.enabled',
  REMNAWAVE_USER_DISABLED: 'remnawave.user.disabled',
  REMNAWAVE_USER_TRAFFIC_RESET: 'remnawave.user.traffic_reset',
  REMNAWAVE_BANDWIDTH_THRESHOLD: 'remnawave.user.bandwidth_threshold',
  REMNAWAVE_PANEL_STARTED: 'remnawave.panel.started',

  // Node (forwarded webhook events)
  NODE_CONNECTION_LOST: 'node.connection_lost',
  NODE_CONNECTION_RESTORED: 'node.connection_restored',
  NODE_CREATED: 'node.created',
  NODE_MODIFIED: 'node.modified',
  NODE_ENABLED: 'node.enabled',
  NODE_DISABLED: 'node.disabled',
  NODE_TRAFFIC_NOTIFY: 'node.traffic_notify',

  // System
  SYSTEM_STARTUP: 'system.startup',
  SYSTEM_BACKUP_COMPLETED: 'system.backup_completed',
  SYSTEM_BROADCAST_SENT: 'system.broadcast_sent',
  SYSTEM_ERROR: 'system.error',
  SETTINGS_EMAIL_UPDATED: 'settings.email.updated',
  NOTIFICATION_TEMPLATE_CREATED: 'notification.template.created',
  NOTIFICATION_TEMPLATE_UPDATED: 'notification.template.updated',
  NOTIFICATION_TEMPLATE_DELETED: 'notification.template.deleted',
  NOTIFICATION_TEMPLATE_SEEDED: 'notification.template.seeded',
  SYSTEM_REMNAWAVE_SYNC: 'system.remnawave_sync',
} as const;

// ── Service ─────────────────────────────────────────────────────────────────

export type SystemEventHook = (
  event: SystemEventPayload & { timestamp: string },
) => void | Promise<void>;

@Injectable()
export class SystemEventsService {
  private readonly logger = new Logger(SystemEventsService.name);

  /**
   * Out-of-band subscribers attached at runtime via `registerHook()`.
   * Used by the Phase 6 webhook dispatcher to fan events out to operator-
   * defined endpoints without hard-wiring a circular dependency between
   * SystemEventsModule and WebhooksModule.
   *
   * Hooks are invoked AFTER persistence/realtime/telegram delivery so a
   * misbehaving hook can never block the primary event pipeline. They
   * are wrapped in try/catch + setImmediate, so any throw is caught and
   * never propagates back to the emit() caller.
   */
  private readonly hooks: SystemEventHook[] = [];

  /**
   * Lazily-resolved realtime gateway.
   *
   * We deliberately avoid declaring `RealtimeGateway` as a constructor
   * dependency to prevent a hard import cycle:
   *   realtime.module → JwtModule → AuthModule → SystemEventsModule
   *                                                        ↑
   *                                              this would close the loop
   *
   * Instead we resolve the gateway through `ModuleRef` on first use. If
   * the module is not yet registered (e.g. worker runtime), the lookup
   * returns `null` and broadcast is silently skipped.
   */
  private realtimeGateway: RealtimeGateway | null = null;
  private realtimeGatewayResolved = false;

  /**
   * Lazily-resolved reiwa bot notifier — same `ModuleRef` escape hatch as the
   * realtime gateway to avoid a hard module cycle. Used for the automatic
   * dev-fallback (`reiwa.dev.notify`): when no operator group/topic is
   * configured, system events are routed to the reiwa bot's `BOT_DEV_ID`.
   */
  private botNotifier: BotNotifierClient | null = null;
  private botNotifierResolved = false;

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(webhookConfig.KEY)
    private readonly webhookConfiguration: ConfigType<typeof webhookConfig>,
    @Optional()
    private readonly httpService?: HttpService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Emit a system event. This is the single entry point for all events.
   * Fire-and-forget — never throws, never blocks the caller.
   */
  public emit(event: SystemEventPayload): void {
    const enrichedEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };

    // 1. Log to stdout
    this.logEvent(enrichedEvent);

    // 2. Persist to audit log (async, non-blocking)
    this.persistEvent(enrichedEvent).catch((err) => {
      this.logger.error(`Failed to persist event ${event.type}: ${(err as Error).message}`);
    });

    // 3. Deliver via webhook (async, non-blocking)
    if (this.webhookConfiguration.enabled && this.webhookConfiguration.urls.length > 0) {
      this.deliverWebhook(enrichedEvent).catch((err) => {
        this.logger.error(`Webhook delivery failed for ${event.type}: ${(err as Error).message}`);
      });
    }

    // 4. Deliver to Telegram group (async, non-blocking)
    this.deliverTelegram(enrichedEvent).catch((err) => {
      this.logger.error(`Telegram delivery failed for ${event.type}: ${(err as Error).message}`);
    });

    // 4b. Auto-archive ERROR reports to disk when mode=auto (async, non-blocking)
    this.archiveErrorReport(enrichedEvent).catch((err) => {
      this.logger.warn(`Error-report archive failed for ${event.type}: ${(err as Error).message}`);
    });

    // 5. Push over WebSocket to connected admin clients (sync — no I/O)
    this.deliverRealtime(enrichedEvent);

    // 6. Out-of-band hooks (Phase 6 webhook dispatcher, future plugins).
    //    Each hook runs in its own microtask so a slow/buggy receiver
    //    never blocks the primary pipeline.
    if (this.hooks.length > 0) {
      const hooksSnapshot = [...this.hooks];
      setImmediate(() => {
        for (const hook of hooksSnapshot) {
          try {
            const result = hook(enrichedEvent);
            if (result && typeof (result as Promise<unknown>).catch === 'function') {
              (result as Promise<unknown>).catch((err) => {
                this.logger.warn(`SystemEvents hook rejected: ${(err as Error).message}`);
              });
            }
          } catch (err) {
            this.logger.warn(`SystemEvents hook threw: ${(err as Error).message}`);
          }
        }
      });
    }
  }

  /**
   * Registers an out-of-band hook called once per emitted event AFTER
   * the built-in delivery pipeline. The hook is invoked asynchronously
   * (via `setImmediate`) and any throw / rejection is swallowed —
   * downstream hooks must not be able to break primary event delivery.
   *
   * Returns an unregister function for tests / module teardown.
   */
  public registerHook(hook: SystemEventHook): () => void {
    this.hooks.push(hook);
    return () => {
      const index = this.hooks.indexOf(hook);
      if (index !== -1) this.hooks.splice(index, 1);
    };
  }

  /**
   * Convenience: emit an INFO event.
   */
  public info(
    type: string,
    category: SystemEventCategory,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit({ type, category, severity: 'INFO', message, metadata });
  }

  /**
   * Convenience: emit a WARNING event.
   */
  public warn(
    type: string,
    category: SystemEventCategory,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit({ type, category, severity: 'WARNING', message, metadata });
  }

  /**
   * Convenience: emit an ERROR event.
   */
  public error(
    type: string,
    category: SystemEventCategory,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emit({ type, category, severity: 'ERROR', message, metadata });
  }

  /**
   * Sends a one-off test card through the SAME Telegram delivery pipeline a
   * real event uses — so it honours category→topic routing, the operator
   * group, the reiwa relay (no local bot token), and the dev-DM fallback.
   * Returns where it was routed so the UI can tell the operator. The event is
   * NOT persisted to the audit log / realtime stream (delivery-only).
   */
  public async sendTelegramTest(input: {
    readonly category: SystemEventCategory;
    readonly note: string | null;
    readonly adminId: string;
  }): Promise<{ readonly via: 'primary' | 'dev' | 'none' }> {
    const tgConfig = await this.loadTelegramConfig();
    const note = input.note?.trim();
    const event: SystemEventPayload & { timestamp: string } = {
      type: 'settings.telegram.test',
      category: input.category,
      severity: 'INFO',
      message: `Тестовое сообщение Rezeis (${input.category})${note ? ` — ${note}` : ''}`,
      metadata: { adminId: input.adminId },
      timestamp: new Date().toISOString(),
    };
    const resolved = resolveTelegramDeliveryTarget(tgConfig, event);
    const via: 'primary' | 'dev' | 'none' =
      resolved === null ? 'none' : resolved.isDevFallback ? 'dev' : 'primary';
    await this.deliverTelegram(event);
    return { via };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private logEvent(event: SystemEventPayload & { timestamp: string }): void {
    const prefix = `[${event.severity}] [${event.category}]`;
    const msg = `${prefix} ${event.type}: ${event.message}`;
    switch (event.severity) {
      case 'ERROR':
        this.logger.error(msg);
        break;
      case 'WARNING':
        this.logger.warn(msg);
        break;
      default:
        this.logger.log(msg);
    }
  }

  private async persistEvent(event: SystemEventPayload & { timestamp: string }): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: {
        action: `event.${event.type}`,
        ipAddress: 'system',
        userAgent: 'rezeis-admin/system-events',
        metadata: {
          category: event.category,
          severity: event.severity,
          message: event.message,
          timestamp: event.timestamp,
          ...(event.metadata ?? {}),
        },
        adminUserId: event.adminId ?? null,
      },
    });
  }

  private async deliverWebhook(event: SystemEventPayload & { timestamp: string }): Promise<void> {
    if (!this.httpService) return;

    const payload = JSON.stringify({
      event: event.type,
      category: event.category,
      severity: event.severity,
      message: event.message,
      metadata: event.metadata ?? {},
      timestamp: event.timestamp,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Rezeis-Event': event.type,
    };

    // Unified signature: `X-Rezeis-Signature: t=<sec>,v1=<hmac>` over
    // `<t>.<body>` — the same scheme as the per-subscription dispatcher and
    // the reiwa webhook receiver, so any consumer verifies one way.
    const secret = this.webhookConfiguration.secretHeader;
    if (secret) {
      const { header, timestamp } = buildWebhookSignature({ secret, body: payload });
      headers['X-Rezeis-Signature'] = header;
      headers['X-Rezeis-Timestamp'] = String(timestamp);
    }

    for (const url of this.webhookConfiguration.urls) {
      try {
        await firstValueFrom(
          this.httpService.post(url, payload, {
            headers,
            timeout: 10_000,
          }),
        );
      } catch (err) {
        const hint = this.isLikelyReiwaUrl(url)
          ? ' — this URL points at reiwa, which has NO generic /webhook endpoint. ' +
            'The reiwa integration uses REIWA_URL (+ /api/v1/webhooks/rezeis), NOT WEBHOOK_URL. ' +
            'Set WEBHOOK_ENABLED=false or point WEBHOOK_URL at a real external consumer.'
          : '';
        this.logger.warn(`Webhook to ${url} failed: ${(err as Error).message}${hint}`);
      }
    }
  }

  /**
   * Heuristic: does a generic-webhook URL actually point at reiwa? Operators
   * sometimes set WEBHOOK_URL to the reiwa domain expecting it to deliver
   * notifications — but that's the relay's job (REIWA_URL). Comparing hosts
   * lets us surface an actionable hint instead of a bare 404.
   */
  private isLikelyReiwaUrl(url: string): boolean {
    const reiwaUrl = (process.env.REIWA_URL ?? '').trim();
    try {
      const target = new URL(url).host.toLowerCase();
      if (reiwaUrl.length > 0) {
        const reiwaHost = new URL(reiwaUrl).host.toLowerCase();
        if (target === reiwaHost) return true;
      }
      return /(^|\.)reiwa\b/.test(target) || /\/webhook$/.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  // ── Realtime Delivery ───────────────────────────────────────────────────────

  /**
   * Push the event to every connected admin socket whose subscription set
   * covers the event's category. The realtime gateway is resolved lazily
   * to avoid a circular dependency between SystemEventsModule and
   * RealtimeModule (RealtimeModule depends on JwtModule, which is wired
   * inside AuthModule, which itself emits events through this service).
   */
  private deliverRealtime(event: SystemEventPayload & { timestamp: string }): void {
    const gateway = this.resolveRealtimeGateway();
    if (!gateway) return;
    try {
      gateway.broadcast({
        type: event.type,
        category: event.category,
        severity: event.severity,
        message: event.message,
        metadata: event.metadata,
        timestamp: event.timestamp,
      });
    } catch (err) {
      this.logger.warn(`Realtime broadcast failed: ${(err as Error).message}`);
    }
  }

  private resolveRealtimeGateway(): RealtimeGateway | null {
    if (this.realtimeGatewayResolved) return this.realtimeGateway;
    this.realtimeGatewayResolved = true;
    if (!this.moduleRef) return null;
    try {
      this.realtimeGateway = this.moduleRef.get(RealtimeGateway, { strict: false });
    } catch {
      this.realtimeGateway = null;
    }
    return this.realtimeGateway;
  }

  // ── Telegram Delivery ───────────────────────────────────────────────────────

  /**
   * Sends a formatted HTML message to the configured Telegram group/topic.
   *
   * Settings are read from `Settings.systemNotifications` JSON:
   *   - `telegram.enabled` — master toggle
   *   - `telegram.botToken` — bot token for sending (uses BOT_TOKEN from payments config as fallback)
   *   - `telegram.chatId` — target group/channel chat_id
   *   - `telegram.topicId` — optional message_thread_id for forum topics
   *   - `telegram.events` — array of event types to send (empty = all)
   *
   * Message format matches altshop/STEALTHNET style:
   *   #EventType
   *   ⚙️ Событие: Description!
   *   <blockquote>structured data</blockquote>
   */
  private async deliverTelegram(event: SystemEventPayload & { timestamp: string }): Promise<void> {
    if (!this.httpService) return;

    const tgConfig = await this.loadTelegramConfig();

    // Authoritative event-selection gate. When the operator runs in
    // `selected` mode, only ticked event types reach Telegram — and that
    // applies to EVERY path (operator group, reiwa relay, AND the dev-DM
    // fallback). Unselected events go nowhere on Telegram. The panel still
    // has them (audit log + realtime already ran in emit()).
    if (
      !isEventTelegramAllowed(event.type, {
        eventsMode: tgConfig.eventsMode,
        events: tgConfig.events,
      })
    ) {
      return;
    }

    // Resolve the user's Telegram id / name / username from `metadata.userId`
    // when the emitter didn't include them, so EVERY event card shows a clear
    // "👤 Пользователь" block (payments, referrals, partner, promocode, …).
    // Centralised here so individual emit sites stay lean. Best-effort.
    const enriched = await this.enrichUserIdentity(event);

    const reportEvent = this.toErrorReportEvent(enriched);
    const errorEvent = isErrorEvent(reportEvent);
    const attachTxt =
      errorEvent && tgConfig.errorReportTelegramTxt && tgConfig.errorReportMode !== 'off';

    const resolved = resolveTelegramDeliveryTarget(tgConfig, enriched);
    if (resolved === null) {
      // No operator group AND no manual devChatId configured → automatic
      // dev-fallback: route the event to the reiwa bot's BOT_DEV_ID via the
      // internal channel (the bot knows its dev id; rezeis doesn't). The
      // event filter is intentionally NOT applied — the dev firehose sees all.
      await this.deliverToReiwaDev(enriched, { errorEvent, attachTxt, reportEvent });
      return;
    }

    // Direct send (operator group or manual devChatId) needs a bot token —
    // which on the standard split deployment lives in reiwa, NOT rezeis
    // (rezeis has no BOT_TOKEN). When we can't reach the Bot API directly we
    // must NOT silently drop a dev-fallback event: route it through the reiwa
    // relay instead (its bot delivers to BOT_DEV_ID). This keeps the screen's
    // promise true — "если доставка выключена или не указан Chat ID, события
    // всё равно придут сюда в личку бота. Не потеряются."
    if (!tgConfig.botToken) {
      if (resolved.isDevFallback) {
        await this.deliverToReiwaDev(enriched, { errorEvent, attachTxt, reportEvent });
      } else {
        // Operator group/topic configured but rezeis has no local bot token
        // (split deployment). Route the card through the reiwa relay's
        // broadcast path — the bot owns the token and posts to the exact
        // chat/topic. This is what makes category routing + the test message
        // actually work without a token on rezeis.
        const html = errorEvent
          ? formatErrorEventCardHtml(reportEvent, getRezeisBuildInfo(), false)
          : this.formatTelegramMessage(enriched);
        await this.deliverViaReiwaBroadcast(enriched, html, resolved.chatId, resolved.topicId);
      }
      return;
    }
    const targetChatId = resolved.chatId;
    const topicId = resolved.topicId;

    // ERROR events get the richly-sectioned card; everything else keeps the
    // generic event formatter.
    const html = errorEvent
      ? formatErrorEventCardHtml(reportEvent, getRezeisBuildInfo(), attachTxt)
      : this.formatTelegramMessage(enriched);

    const payload: Record<string, unknown> = {
      chat_id: targetChatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (topicId) {
      payload['message_thread_id'] = topicId;
    }

    try {
      await firstValueFrom(
        this.httpService.post(
          `https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`,
          payload,
          { timeout: 10_000 },
        ),
      );
    } catch (err) {
      this.logger.warn(`Telegram send failed: ${(err as Error).message}`);
    }

    // Attach the .txt error report as a follow-up document when enabled.
    if (attachTxt) {
      await this.sendErrorReportDocument({
        botToken: tgConfig.botToken,
        chatId: targetChatId,
        topicId,
        reportEvent,
      });
    }
  }

  /** Map an emitted system event to the normalized error-report shape. */
  private toErrorReportEvent(event: SystemEventPayload & { timestamp: string }): ErrorReportEvent {
    const meta = event.metadata ?? {};
    return {
      kind: `event.${event.type}`,
      severity: event.severity,
      category: event.category,
      message: event.message,
      timestamp: event.timestamp,
      metadata: meta,
      actor: typeof meta['adminId'] === 'string' ? (meta['adminId'] as string) : null,
    };
  }

  /**
   * Upload the formatted `.txt` error report as a Telegram document to the
   * given chat/topic via the Bot API (`sendDocument`, multipart). Best-effort.
   */
  private async sendErrorReportDocument(input: {
    readonly botToken: string;
    readonly chatId: string;
    readonly topicId: number | null;
    readonly reportEvent: ErrorReportEvent;
  }): Promise<void> {
    try {
      const txt = formatErrorReportTxt(input.reportEvent, getRezeisBuildInfo());
      const filename = buildErrorReportFilename(input.reportEvent);
      const form = new FormData();
      form.append('chat_id', input.chatId);
      if (input.topicId) form.append('message_thread_id', String(input.topicId));
      form.append('document', new Blob([txt], { type: 'text/plain' }), filename);
      const res = await fetch(`https://api.telegram.org/bot${input.botToken}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.logger.warn(`Telegram sendDocument returned ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`Telegram sendDocument failed: ${(err as Error).message}`);
    }
  }

  /**
   * Formats an event into a Telegram HTML message matching the altshop style.
   */
  /**
   * Lazily resolve the reiwa `BotNotifierClient` through `ModuleRef` (same
   * cycle-avoidance escape hatch as the realtime gateway). Returns `null` when
   * the notifications module isn't registered (e.g. minimal worker runtimes).
   */
  private resolveBotNotifier(): BotNotifierClient | null {
    if (this.botNotifierResolved) return this.botNotifier;
    this.botNotifierResolved = true;
    try {
      this.botNotifier = this.moduleRef?.get(BotNotifierClient, { strict: false }) ?? null;
    } catch {
      this.botNotifier = null;
    }
    return this.botNotifier;
  }

  /**
   * Automatic dev-fallback: deliver the event card to the reiwa bot's
   * `BOT_DEV_ID` over the internal channel. Best-effort and a no-op when the
   * notifier isn't wired (no REIWA_URL / WEBHOOK_SECRET_HEADER) — the event
   * still lives in the audit log + realtime stream.
   */
  private async deliverToReiwaDev(
    event: SystemEventPayload & { timestamp: string },
    opts: {
      readonly errorEvent: boolean;
      readonly attachTxt: boolean;
      readonly reportEvent: ErrorReportEvent;
    },
  ): Promise<void> {
    const notifier = this.resolveBotNotifier();
    if (notifier === null) return;
    const html = opts.errorEvent
      ? formatErrorEventCardHtml(opts.reportEvent, getRezeisBuildInfo(), opts.attachTxt)
      : this.formatTelegramMessage(event);
    try {
      if (opts.attachTxt) {
        // Single dev-DM message that mirrors the screenshot/operator layout:
        // the full `.txt` report as a document, the sectioned error card as
        // its caption, and a Close button (attached bot-side). The stack
        // trace + raw payload live in the attached .txt, one tap away.
        const txt = formatErrorReportTxt(opts.reportEvent, getRezeisBuildInfo());
        await notifier.notifyDevDocument({
          filename: buildErrorReportFilename(opts.reportEvent),
          content: txt,
          caption: html,
          parseMode: 'HTML',
        });
      } else {
        // Non-error events (or txt attachment disabled): inline card only.
        await notifier.notifyDev({ text: html, parseMode: 'HTML' });
      }
    } catch (err) {
      this.logger.warn(`Dev-fallback notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Split-deployment operator delivery: relay the card to a specific
   * chat/topic through the reiwa bot's broadcast path (the bot owns the
   * token). Used when an operator group is configured but rezeis has no local
   * bot token. Best-effort; documents (error `.txt`) are not relayed here —
   * the card itself carries the actionable summary.
   */
  private async deliverViaReiwaBroadcast(
    event: SystemEventPayload & { timestamp: string },
    html: string,
    chatId: string,
    topicId: number | null,
  ): Promise<void> {
    const notifier = this.resolveBotNotifier();
    if (notifier === null) {
      this.logger.warn(
        `Telegram delivery skipped for ${event.type}: no local bot token and reiwa relay unavailable`,
      );
      return;
    }
    try {
      await notifier.notifyBroadcast({
        eventId: `sysevt:${event.type}:${event.timestamp}`,
        chatId,
        topicThreadId: topicId ?? undefined,
        text: html,
        parseMode: 'HTML',
      });
    } catch (err) {
      this.logger.warn(`Reiwa broadcast relay failed: ${(err as Error).message}`);
    }
  }

  /**
   * Auto-archive: when the operator selected the `auto` error-report mode,
   * write the formatted `.txt` for every new ERROR event into the on-disk
   * archive (`data/error-reports/<date>/`). Best-effort and bounded — never
   * blocks the primary pipeline.
   */
  private async archiveErrorReport(
    event: SystemEventPayload & { timestamp: string },
  ): Promise<void> {
    const reportEvent = this.toErrorReportEvent(event);
    if (!isErrorEvent(reportEvent)) return;
    const tgConfig = await this.loadTelegramConfig();
    if (tgConfig.errorReportMode !== 'auto') return;
    const txt = formatErrorReportTxt(reportEvent, getRezeisBuildInfo());
    const result = await writeErrorReport({
      baseDir: resolveErrorReportsDir(),
      filename: buildErrorReportFilename(reportEvent),
      content: txt,
      timestamp: event.timestamp,
    });
    if (!result.written && result.reason !== 'rate-capped') {
      this.logger.warn(`Error-report archive skipped: ${result.reason}`);
    }
  }

  private formatTelegramMessage(event: SystemEventPayload & { timestamp: string }): string {
    const hashtag = `#${eventTypeToHashtag(event.type)}`;
    const meta = event.metadata ?? {};
    const present = EVENT_PRESENTATION[event.type];
    const emoji = present?.emoji ?? severityEmoji(event.severity);
    const title = present?.title ?? event.message;

    const lines: string[] = [
      hashtag,
      '',
      present
        ? `${emoji} <b>Событие: ${escapeHtml(present.title)}!</b>`
        : `${emoji} <b>${escapeHtml(title)}</b>`,
    ];

    // Fraud block — a dedicated, informative card for anti-fraud signals.
    // Uses `fraud*`-prefixed metadata so it never collides with the generic
    // user/promocode blocks below.
    if (event.category === 'FRAUD' && meta['fraudKind'] !== undefined) {
      lines.push(...formatFraudBlock(meta));
    }

    // User block
    if (meta['userId'] || meta['telegramId']) {
      lines.push('');
      lines.push('👤 <b>Пользователь:</b>');
      const userLines: string[] = [];
      if (meta['telegramId'])
        userLines.push(`🪪 Telegram ID: <code>${escapeHtml(meta['telegramId'])}</code>`);
      if (meta['userId']) userLines.push(`👾 Reiwa ID: <code>${escapeHtml(meta['userId'])}</code>`);
      const displayName = meta['userName'] ?? meta['firstName'];
      if (displayName) {
        const handle = meta['username'] ? ` (@${escapeHtml(meta['username'])})` : '';
        userLines.push(`👤 Имя: ${escapeHtml(displayName)}${handle}`);
      } else if (meta['username']) {
        userLines.push(`👤 Username: @${escapeHtml(meta['username'])}`);
      }
      if (meta['login']) userLines.push(`🔑 Login: <code>${escapeHtml(meta['login'])}</code>`);
      if (meta['email'] && !meta['fraudUserEmail'])
        userLines.push(`📧 Email: ${escapeHtml(meta['email'])}`);
      lines.push(`<blockquote>${userLines.join('\n')}</blockquote>`);
    }

    // Payment block
    if (meta['paymentId'] || meta['amount']) {
      lines.push('');
      lines.push('💰 <b>Платёж:</b>');
      const payLines: string[] = [];
      if (meta['paymentId']) payLines.push(`🆔 ID: <code>${escapeHtml(meta['paymentId'])}</code>`);
      if (meta['gatewayType'])
        payLines.push(`💳 Способ оплаты: ${escapeHtml(meta['gatewayType'])}`);
      if (meta['amount']) payLines.push(`💷 Сумма: ${fmtAmount(meta['amount'], meta['currency'])}`);
      if (meta['purchaseType'])
        payLines.push(`💥 Тип покупки: ${humanizePurchaseType(meta['purchaseType'])}`);
      if (typeof meta['receiptUrl'] === 'string')
        payLines.push(`📃 <a href="${escapeHtml(meta['receiptUrl'])}">Чек</a>`);
      else if (typeof meta['checkoutUrl'] === 'string')
        payLines.push(`🧾 <a href="${escapeHtml(meta['checkoutUrl'])}">Ссылка на оплату</a>`);
      if (meta['paidAt']) payLines.push(`⏰ Оплачено: ${fmtDate(meta['paidAt'])}`);
      lines.push(`<blockquote>${payLines.join('\n')}</blockquote>`);
    }

    // Plan/Subscription block
    if (meta['planName'] || meta['subscriptionId']) {
      lines.push('');
      lines.push('📦 <b>План / подписка:</b>');
      const planLines: string[] = [];
      // Receipt here only when there's no dedicated Payment block above (e.g.
      // a subscription.created without payment metadata) — avoids duplicating.
      if (!meta['paymentId'] && !meta['amount'] && typeof meta['receiptUrl'] === 'string') {
        planLines.push(`📃 <a href="${escapeHtml(meta['receiptUrl'])}">Чек</a>`);
      }
      if (meta['planName']) planLines.push(`🏷 План: ${escapeHtml(meta['planName'])}`);
      if (meta['planType']) planLines.push(`📦 Тип: ${humanizePlanType(meta['planType'])}`);
      else if (meta['purchaseType'])
        planLines.push(`📦 Тип: ${humanizePurchaseType(meta['purchaseType'])}`);
      if (typeof meta['trafficLimitBytes'] === 'number')
        planLines.push(`📊 Лимит трафика: ${fmtBytes(meta['trafficLimitBytes'])}`);
      if (meta['deviceLimit'] !== undefined)
        planLines.push(`📱 Лимит устройств: ${escapeHtml(meta['deviceLimit'])}`);
      if (meta['durationDays'])
        planLines.push(`⏳ Длительность: ${humanizeDuration(meta['durationDays'])}`);
      if (meta['isTrial'] !== undefined)
        planLines.push(`🎁 Триал: ${meta['isTrial'] ? 'да' : 'нет'}`);
      if (meta['expireAt'] || meta['expiresAt'])
        planLines.push(`📅 Действует до: ${fmtDate(meta['expireAt'] ?? meta['expiresAt'])}`);
      if (meta['subscriptionId'])
        planLines.push(`🗳 Подписка ID: <code>${escapeHtml(meta['subscriptionId'])}</code>`);
      if (meta['source']) planLines.push(`📌 Причина: ${humanizeSource(meta['source'])}`);
      lines.push(`<blockquote>${planLines.join('\n')}</blockquote>`);
    }

    // Remnawave profile block — which panel profile this event refers to.
    // Rendered when the event carries a Remnawave uuid/login and it isn't
    // already covered by the fraud card or the HWID/device block.
    const remnaUuid = meta['remnawaveId'] ?? meta['remnawaveUuid'];
    if ((remnaUuid || meta['remnawaveUsername']) && event.category !== 'FRAUD' && !meta['hwid']) {
      lines.push('');
      lines.push('🌐 <b>Профиль Remnawave:</b>');
      const remnaLines: string[] = [];
      if (meta['remnawaveUsername'])
        remnaLines.push(
          `🃏 Профиль на панели: <code>${escapeHtml(meta['remnawaveUsername'])}</code>`,
        );
      if (remnaUuid) remnaLines.push(`🔹 UUID: <code>${escapeHtml(remnaUuid)}</code>`);
      if (typeof meta['usedTrafficBytes'] === 'number') {
        const limit =
          typeof meta['trafficLimitBytes'] === 'number' && meta['trafficLimitBytes'] > 0
            ? ` / ${fmtBytes(meta['trafficLimitBytes'])}`
            : '';
        remnaLines.push(`📊 Трафик: ${fmtBytes(meta['usedTrafficBytes'])}${limit}`);
      }
      if (meta['expireAt'] && !meta['planName'])
        remnaLines.push(`📅 Действует до: ${fmtDate(meta['expireAt'])}`);
      lines.push(`<blockquote>${remnaLines.join('\n')}</blockquote>`);
      const panelUrl = buildRemnawavePanelUrl();
      if (panelUrl)
        lines.push(`🔗 <a href="${escapeHtml(panelUrl)}">Открыть в панели Remnawave</a>`);
    }
    if (meta['filename'] && (event.category === 'SYSTEM' || meta['backupId'])) {
      lines.push('');
      lines.push('🗄 <b>Бэкап:</b>');
      const backupLines: string[] = [];
      backupLines.push(`🗂 Файл: <code>${escapeHtml(meta['filename'])}</code>`);
      if (typeof meta['sizeBytes'] === 'number')
        backupLines.push(`🗃 Размер: ${fmtBytes(meta['sizeBytes'])}`);
      if (meta['scope']) backupLines.push(`📦 Объём: ${escapeHtml(meta['scope'])}`);
      if (typeof meta['checksum'] === 'string')
        backupLines.push(
          `📰 Контрольная сумма: <code>${escapeHtml(meta['checksum'].slice(0, 12))}</code>`,
        );
      if (meta['deliveredToTelegram'] === false)
        backupLines.push('📥 Доставка: только локально (слишком большой)');
      if (meta['initiatedBy'])
        backupLines.push(`👤 Инициатор: <code>${escapeHtml(meta['initiatedBy'])}</code>`);
      lines.push(`<blockquote>${backupLines.join('\n')}</blockquote>`);
    }

    // Node block — infrastructure events forwarded from the Remnawave panel.
    if (meta['nodeName'] || meta['nodeUuid']) {
      lines.push('');
      lines.push('🖥 <b>Нода:</b>');
      const nodeLines: string[] = [];
      if (meta['nodeName']) nodeLines.push(`🎴 Название: ${escapeHtml(meta['nodeName'])}`);
      if (meta['countryCode'])
        nodeLines.push(`🏴 Страна: ${countryCodeToFlag(meta['countryCode'])}`);
      if (meta['nodeAddress'])
        nodeLines.push(`💈 Адрес: <code>${escapeHtml(meta['nodeAddress'])}</code>`);
      if (meta['nodeUuid'])
        nodeLines.push(
          `🔹 UUID: <code>${escapeHtml(String(meta['nodeUuid']).slice(0, 12))}</code>`,
        );
      lines.push(`<blockquote>${nodeLines.join('\n')}</blockquote>`);
    }
    if (meta['partnerId'] || meta['earning']) {
      lines.push('');
      lines.push('🤝 <b>Партнёр:</b>');
      const partnerLines: string[] = [];
      if (meta['partnerId'])
        partnerLines.push(`🗳 ID: <code>${String(meta['partnerId']).slice(0, 12)}</code>`);
      if (meta['level']) partnerLines.push(`🏮 Уровень: ${meta['level']}`);
      if (meta['earning'])
        partnerLines.push(`💴 Начислено: ${(Number(meta['earning']) / 100).toFixed(2)} ₽`);
      if (meta['percent']) partnerLines.push(`🏵 Процент: ${meta['percent']}%`);
      lines.push(`<blockquote>${partnerLines.join('\n')}</blockquote>`);
    }

    // Referral block
    if (meta['referrerId'] || meta['referralId'] || meta['referredUserId']) {
      lines.push('');
      lines.push('🔗 <b>Реферал:</b>');
      const refLines: string[] = [];
      if (meta['referralId']) {
        refLines.push(`🆔 Связь: <code>${escapeHtml(meta['referralId'])}</code>`);
      }
      if (meta['referredUserId']) {
        refLines.push(`👤 Приглашённый:`);
        if (meta['referredTelegramId'])
          refLines.push(
            `   🪪 Telegram ID: <code>${escapeHtml(meta['referredTelegramId'])}</code>`,
          );
        refLines.push(`   👾 Reiwa ID: <code>${escapeHtml(meta['referredUserId'])}</code>`);
        if (meta['referredName']) {
          const h = meta['referredUsername'] ? ` (@${escapeHtml(meta['referredUsername'])})` : '';
          refLines.push(`   👤 Имя: ${escapeHtml(meta['referredName'])}${h}`);
        } else if (meta['referredUsername']) {
          refLines.push(`   👤 Username: @${escapeHtml(meta['referredUsername'])}`);
        }
        if (meta['referredLogin'])
          refLines.push(`   🔑 Login: <code>${escapeHtml(meta['referredLogin'])}</code>`);
      }
      if (meta['referrerId']) {
        refLines.push(`👥 Пригласил:`);
        if (meta['referrerTelegramId'])
          refLines.push(
            `   🪪 Telegram ID: <code>${escapeHtml(meta['referrerTelegramId'])}</code>`,
          );
        refLines.push(`   👾 Reiwa ID: <code>${escapeHtml(meta['referrerId'])}</code>`);
        if (meta['referrerName']) {
          const h = meta['referrerUsername'] ? ` (@${escapeHtml(meta['referrerUsername'])})` : '';
          refLines.push(`   👤 Имя: ${escapeHtml(meta['referrerName'])}${h}`);
        } else if (meta['referrerUsername']) {
          refLines.push(`   👤 Username: @${escapeHtml(meta['referrerUsername'])}`);
        }
        if (meta['referrerLogin'])
          refLines.push(`   🔑 Login: <code>${escapeHtml(meta['referrerLogin'])}</code>`);
      }
      if (meta['rewardType']) {
        const rv = meta['rewardValue'] !== undefined ? `: ${escapeHtml(meta['rewardValue'])}` : '';
        refLines.push(`🎊 Награда: ${humanizeRewardType(meta['rewardType'])}${rv}`);
      }
      if (meta['historicalPaymentsProcessed'] !== undefined)
        refLines.push(`📈 Платежей обработано: ${meta['historicalPaymentsProcessed']}`);
      lines.push(`<blockquote>${refLines.join('\n')}</blockquote>`);
    }

    // Promocode block
    if ((meta['code'] || meta['promocodeId']) && event.category !== 'FRAUD') {
      lines.push('');
      lines.push('🎟 <b>Промокод:</b>');
      const promoLines: string[] = [];
      if (meta['code']) promoLines.push(`🎫 Код: <code>${meta['code']}</code>`);
      if (meta['rewardType']) promoLines.push(`💥 Тип награды: ${meta['rewardType']}`);
      if (meta['rewardValue']) promoLines.push(`🎊 Значение: ${meta['rewardValue']}`);
      lines.push(`<blockquote>${promoLines.join('\n')}</blockquote>`);
    }

    // Device/HWID block
    if (meta['hwid']) {
      lines.push('');
      lines.push('📱 <b>Устройство:</b>');
      const deviceLines: string[] = [];
      deviceLines.push(`🧬 HWID: <code>${meta['hwid']}</code>`);
      if (meta['remainingDevices'] !== undefined)
        deviceLines.push(`📱 Осталось устройств: ${meta['remainingDevices']}`);
      if (meta['planName']) deviceLines.push(`🏷 План: ${escapeHtml(meta['planName'])}`);
      if (meta['subscriptionId'])
        deviceLines.push(
          `🗳 Подписка ID: <code>${String(meta['subscriptionId']).slice(0, 12)}</code>`,
        );
      if (meta['remnawaveId'])
        deviceLines.push(`🌊 Remnawave: <code>${String(meta['remnawaveId']).slice(0, 12)}</code>`);
      lines.push(`<blockquote>${deviceLines.join('\n')}</blockquote>`);
    }

    // Error block
    if (meta['error'] || event.severity === 'ERROR') {
      lines.push('');
      lines.push('⚠️ <b>Ошибка:</b>');
      const errLines: string[] = [];
      if (meta['error']) errLines.push(`💬 Сообщение: ${meta['error']}`);
      if (meta['action']) errLines.push(`🧷 Действие: <code>${meta['action']}</code>`);
      if (meta['attempt']) errLines.push(`🔁 Попытка: ${meta['attempt']}`);
      lines.push(`<blockquote>${errLines.join('\n')}</blockquote>`);
    }

    // Extra block — curated leftover keys that carry useful context but don't
    // belong to any dedicated block above. Each is optional and escaped.
    const extraLines: string[] = [];
    if (meta['reason']) extraLines.push(`📌 Причина: ${humanizeSource(meta['reason'])}`);
    if (meta['note']) extraLines.push(`📝 Заметка: ${escapeHtml(meta['note'])}`);
    if (meta['addOnType']) {
      const val = meta['addOnValue'] !== undefined ? ` ${escapeHtml(meta['addOnValue'])}` : '';
      extraLines.push(`🛒 Докупка: ${escapeHtml(meta['addOnType'])}${val}`);
    }
    if (meta['itemCount'] !== undefined)
      extraLines.push(`🧾 Позиций: ${escapeHtml(meta['itemCount'])}`);
    if (meta['count'] !== undefined) extraLines.push(`🔢 Количество: ${escapeHtml(meta['count'])}`);
    if (meta['recipients'] !== undefined)
      extraLines.push(`👥 Получателей: ${escapeHtml(meta['recipients'])}`);
    if (meta['templateName']) extraLines.push(`🫧 Шаблон: ${escapeHtml(meta['templateName'])}`);
    if (meta['ticketId'])
      extraLines.push(`🚓 Тикет: <code>${String(meta['ticketId']).slice(0, 12)}</code>`);
    if (meta['subject']) extraLines.push(`📨 Тема: ${escapeHtml(meta['subject'])}`);
    if (meta['oldRole'] && meta['newRole'])
      extraLines.push(`🥢 Роль: ${escapeHtml(meta['oldRole'])} → ${escapeHtml(meta['newRole'])}`);
    if (extraLines.length > 0) {
      lines.push('');
      lines.push('🧩 <b>Дополнительно:</b>');
      lines.push(`<blockquote>${extraLines.join('\n')}</blockquote>`);
    }

    // Context block
    lines.push('');
    lines.push('🌀 <b>Контекст:</b>');
    const ctxLines: string[] = [`💠 Категория: ${event.category}`];
    const origin = meta['source'] ?? meta['origin'];
    if (origin) ctxLines.push(`🔎 Источник: ${humanizeSource(origin)}`);
    if (meta['surface']) ctxLines.push(`🌫 Поверхность: ${escapeHtml(meta['surface'])}`);
    if (meta['operation'])
      ctxLines.push(`❄️ Операция: <code>${escapeHtml(meta['operation'])}</code>`);
    ctxLines.push(`🧮 Уровень: ${event.severity}`);
    const channel = meta['channel'] ?? meta['purchaseChannel'];
    if (channel) ctxLines.push(`📣 Канал покупки: ${humanizeChannel(channel)}`);
    ctxLines.push(`⏰ Время: ${new Date(event.timestamp).toLocaleString('ru-RU')}`);
    lines.push(`<blockquote>${ctxLines.join('\n')}</blockquote>`);

    // Build info — which release produced this event. Prefers values carried
    // in metadata (so events relayed from reiwa show reiwa's own build) and
    // falls back to rezeis's image env (APP_VERSION / REZEIS_GIT_SHA /
    // REZEIS_GIT_BRANCH baked by the Dockerfile + CI).
    const fallbackBuild = getRezeisBuildInfo();
    const buildVersion =
      (typeof meta['version'] === 'string' && meta['version']) || fallbackBuild.version;
    const buildCommit =
      (typeof meta['commit'] === 'string' && meta['commit']) || fallbackBuild.commit;
    const buildBranch =
      (typeof meta['branch'] === 'string' && meta['branch']) || fallbackBuild.branch;
    lines.push('');
    lines.push('🏗 <b>Сборка:</b>');
    lines.push(
      `<blockquote>🎯 Версия: <code>${escapeHtml(buildVersion)}</code>\n` +
        `🔩 Коммит: <code>${escapeHtml(String(buildCommit).slice(0, 12))}</code>\n` +
        `⚙️ Ветка: <code>${escapeHtml(buildBranch)}</code></blockquote>`,
    );

    return lines.join('\n');
  }

  /**
   * Best-effort identity enrichment for Telegram cards. From `metadata.userId`
   * it fills any missing `telegramId` / `userName` / `username` / `login` (the
   * last one is rarely carried by emitters). When the event references a
   * referral pair (`referredUserId` — the invited user — and `referrerId` —
   * the inviter), it resolves each side's telegramId / name / username / login
   * into `referred*` / `referrer*` keys so the referral block can render full
   * identities. Note: `referralId` is a Referral RECORD id (not a user id) and
   * is never looked up here. One bounded `findMany`; never throws; the original
   * payload is untouched on failure.
   */
  private async enrichUserIdentity(
    event: SystemEventPayload & { timestamp: string },
  ): Promise<SystemEventPayload & { timestamp: string }> {
    const meta = event.metadata;
    if (!meta) return event;
    const userId = typeof meta['userId'] === 'string' ? meta['userId'] : null;
    const referredUserId =
      typeof meta['referredUserId'] === 'string' ? meta['referredUserId'] : null;
    const referrerId = typeof meta['referrerId'] === 'string' ? meta['referrerId'] : null;

    // Resolve the main user when any of telegramId / name / login is missing
    // (login is almost never carried by emitters, so this now runs for most
    // user-bearing events — one bounded query, best-effort).
    const userNeeds =
      userId !== null &&
      (meta['telegramId'] === undefined ||
        meta['login'] === undefined ||
        (meta['userName'] === undefined && meta['username'] === undefined));
    const referredNeeds =
      referredUserId !== null &&
      meta['referredTelegramId'] === undefined &&
      meta['referredName'] === undefined;
    const referrerNeeds =
      referrerId !== null &&
      meta['referrerTelegramId'] === undefined &&
      meta['referrerName'] === undefined;

    const ids = Array.from(
      new Set(
        [
          userNeeds ? userId : null,
          referredNeeds ? referredUserId : null,
          referrerNeeds ? referrerId : null,
        ].filter((x): x is string => x !== null),
      ),
    );
    if (ids.length === 0) return event;

    try {
      const rows = await this.prismaService.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          telegramId: true,
          username: true,
          name: true,
          webAccount: { select: { login: true } },
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const merged: Record<string, unknown> = { ...meta };

      if (userNeeds && userId !== null) {
        const u = byId.get(userId);
        if (u) {
          if (u.telegramId !== null && merged['telegramId'] === undefined) {
            merged['telegramId'] = u.telegramId.toString();
          }
          if (u.username && merged['username'] === undefined) merged['username'] = u.username;
          if (u.name && merged['userName'] === undefined) merged['userName'] = u.name;
          if (u.webAccount?.login && merged['login'] === undefined)
            merged['login'] = u.webAccount.login;
        }
      }
      if (referredNeeds && referredUserId !== null) {
        const r = byId.get(referredUserId);
        if (r) {
          if (r.telegramId !== null) merged['referredTelegramId'] = r.telegramId.toString();
          if (r.name) merged['referredName'] = r.name;
          if (r.username) merged['referredUsername'] = r.username;
          if (r.webAccount?.login) merged['referredLogin'] = r.webAccount.login;
        }
      }
      if (referrerNeeds && referrerId !== null) {
        const r = byId.get(referrerId);
        if (r) {
          if (r.telegramId !== null) merged['referrerTelegramId'] = r.telegramId.toString();
          if (r.name) merged['referrerName'] = r.name;
          if (r.username) merged['referrerUsername'] = r.username;
          if (r.webAccount?.login) merged['referrerLogin'] = r.webAccount.login;
        }
      }
      return { ...event, metadata: merged };
    } catch {
      return event;
    }
  }

  private async loadTelegramConfig(): Promise<{
    enabled: boolean;
    botToken: string | null;
    chatId: string | null;
    topicMap: Record<string, number | null>;
    defaultTopicId: number | null;
    errorTopicId: number | null;
    events: string[];
    eventsMode: 'all' | 'selected';
    devChatId: string | null;
    errorReportMode: 'off' | 'manual' | 'auto';
    errorReportTelegramTxt: boolean;
  }> {
    const settings = await this.prismaService.settings.findFirst({
      select: { systemNotifications: true },
    });
    if (!settings) {
      return {
        enabled: false,
        botToken: null,
        chatId: null,
        topicMap: {},
        defaultTopicId: null,
        events: [],
        eventsMode: 'all',
        devChatId: null,
        errorReportMode: 'manual',
        errorTopicId: null,
        errorReportTelegramTxt: true,
      };
    }
    const json = settings.systemNotifications as Record<string, unknown>;
    const tg = (json?.telegram ?? {}) as Record<string, unknown>;

    // Per-category topic routing (like STEALTHNET):
    // { "USER": 377, "PAYMENT": 377, "SUPPORT": 187, "SYSTEM": 185 }
    const topics = (tg.topics ?? {}) as Record<string, unknown>;
    const topicMap: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(topics)) {
      topicMap[key.toUpperCase()] = typeof value === 'number' ? value : null;
    }

    const errorReports = (tg.errorReports ?? {}) as Record<string, unknown>;
    const mode = errorReports.mode;

    return {
      enabled: tg.enabled === true,
      botToken: typeof tg.botToken === 'string' ? tg.botToken : (process.env.BOT_TOKEN ?? null),
      chatId: typeof tg.chatId === 'string' ? tg.chatId : null,
      topicMap,
      defaultTopicId: typeof tg.topicId === 'number' ? tg.topicId : null,
      errorTopicId: typeof tg.errorTopicId === 'number' ? tg.errorTopicId : null,
      events: Array.isArray(tg.events)
        ? tg.events.filter((e): e is string => typeof e === 'string')
        : [],
      eventsMode: tg.eventsMode === 'selected' ? 'selected' : 'all',
      devChatId: typeof tg.devChatId === 'string' && tg.devChatId.length > 0 ? tg.devChatId : null,
      errorReportMode: mode === 'off' || mode === 'auto' ? mode : 'manual',
      errorReportTelegramTxt: errorReports.telegramTxt !== false,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function eventTypeToHashtag(type: string): string {
  // "payment.completed" → "EventPaymentCompleted"
  return (
    'Event' +
    type
      .split('.')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
  );
}

function severityEmoji(severity: SystemEventSeverity): string {
  switch (severity) {
    case 'ERROR':
      return '🚨';
    case 'WARNING':
      return '⚠️';
    default:
      return '⚙️';
  }
}

/** Minimal HTML escaping for user-supplied values rendered in Telegram HTML. */
function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders an ISO 3166-1 alpha-2 country code as a flag emoji + the code
 * (e.g. `DE` → `🇩🇪 DE`). Non-2-letter input is returned escaped as-is.
 */
function countryCodeToFlag(value: unknown): string {
  const cc = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return escapeHtml(value);
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  const flag = String.fromCodePoint(A + (cc.charCodeAt(0) - base), A + (cc.charCodeAt(1) - base));
  return `${flag} ${cc}`;
}

/**
 * Renders the dedicated anti-fraud block: the sharing metric, the offender's
 * rezeis profile snapshot (or a "Remnawave-only" note when unmapped), the
 * Remnawave uuid, and a deep link to the admin user page so the operator can
 * decide trust-or-block from the message itself.
 */
function formatFraudBlock(meta: Record<string, unknown>): string[] {
  const out: string[] = [];

  const kind = typeof meta['fraudKind'] === 'string' ? (meta['fraudKind'] as string) : null;
  const kindLabel =
    kind === 'ip_sharing'
      ? 'Шеринг по IP'
      : kind === 'hwid_overage'
        ? 'Превышение устройств'
        : 'Сигнал';
  const count = meta['fraudCount'];
  const limit = meta['fraudLimit'];

  out.push('');
  out.push('🚨 <b>Антифрод:</b>');
  const sig: string[] = [`🚓 Тип: ${kindLabel}`];
  if (typeof count === 'number' && typeof limit === 'number') {
    sig.push(`📈 Превышение: ${count} / ${limit}`);
  }
  if (typeof meta['fraudScore'] === 'number') {
    const conf =
      typeof meta['fraudConfidence'] === 'number' ? ` (увер. ${meta['fraudConfidence']}%)` : '';
    sig.push(`🎯 Оценка: ${meta['fraudScore']}${conf}`);
  }
  out.push(`<blockquote>${sig.join('\n')}</blockquote>`);

  out.push('');
  out.push('👤 <b>Нарушитель:</b>');
  const who: string[] = [];
  if (meta['fraudHasRezeisAccount'] === true) {
    if (meta['fraudUserName']) who.push(`👤 Имя: ${escapeHtml(meta['fraudUserName'])}`);
    if (meta['fraudUsername']) who.push(`👤 Username: @${escapeHtml(meta['fraudUsername'])}`);
    if (meta['fraudTelegramId'])
      who.push(`🪪 Telegram ID: <code>${escapeHtml(meta['fraudTelegramId'])}</code>`);
    if (meta['fraudUserEmail']) who.push(`📧 Email: ${escapeHtml(meta['fraudUserEmail'])}`);
    if (meta['fraudUserRole']) who.push(`🥢 Роль: ${escapeHtml(meta['fraudUserRole'])}`);
    if (typeof meta['fraudSubscriptions'] === 'number')
      who.push(`📦 Подписок: ${meta['fraudSubscriptions']}`);
    who.push(`🖥 Web-кабинет: ${meta['fraudHasWebAccount'] === true ? 'да' : 'нет'}`);
    who.push(`🚦 Статус: ${meta['fraudUserBlocked'] === true ? '🔴 заблокирован' : '🟢 активен'}`);
  } else {
    who.push('<i>В rezeis не найден — пользователь есть только в Remnawave</i>');
  }
  if (meta['remnawaveUuid']) {
    who.push(`🌊 Remnawave: <code>${escapeHtml(meta['remnawaveUuid'])}</code>`);
  }
  out.push(`<blockquote>${who.join('\n')}</blockquote>`);

  if (typeof meta['fraudProfileUrl'] === 'string' && meta['fraudProfileUrl'].length > 0) {
    out.push(`🔗 <a href="${escapeHtml(meta['fraudProfileUrl'])}">Открыть профиль в rezeis</a>`);
  }

  return out;
}

// ── Event presentation (emoji + Russian title) ──────────────────────────────

/**
 * Per-event-type presentation: a distinctive emoji and a human Russian title
 * for the card header. Keeps the firehose readable at a glance — every event
 * type gets its own identity instead of a generic severity icon. Falls back to
 * `severityEmoji` + the raw `event.message` when a type isn't mapped here.
 */
const EVENT_PRESENTATION: Record<string, { emoji: string; title: string }> = {
  // User
  'user.registered': { emoji: '🆕', title: 'Новый пользователь' },
  'user.web_registered': { emoji: '🆕', title: 'Регистрация через сайт' },
  'user.blocked': { emoji: '🔴', title: 'Пользователь заблокирован' },
  'user.unblocked': { emoji: '🟢', title: 'Пользователь разблокирован' },
  'user.deleted': { emoji: '🗑', title: 'Пользователь удалён' },
  'user.role_changed': { emoji: '🛡', title: 'Изменена роль пользователя' },
  'user.telegram_linked': { emoji: '🔗', title: 'Привязан Telegram' },
  'user.email_linked': { emoji: '📧', title: 'Привязан Email' },
  user_hwid_revoked: { emoji: '📱', title: 'Сброшено устройство (HWID)' },

  // Auth
  'auth.web_login': { emoji: '🔑', title: 'Вход в веб-кабинет' },
  'auth.password_changed': { emoji: '🔐', title: 'Изменён пароль' },
  'auth.password_recovery': { emoji: '🔓', title: 'Восстановление пароля' },

  // Subscription
  'subscription.created': { emoji: '✅', title: 'Подписка создана' },
  'subscription.renewed': { emoji: '🔄', title: 'Подписка продлена' },
  'subscription.upgraded': { emoji: '⬆️', title: 'Подписка улучшена' },
  'subscription.expired': { emoji: '⌛', title: 'Подписка истекла' },
  'subscription.deleted': { emoji: '🗑', title: 'Подписка удалена' },
  'subscription.synced': { emoji: '🔄', title: 'Синхронизация подписки' },
  'subscription.trial_granted': { emoji: '🎁', title: 'Выдан триал' },

  // Payment
  'payment.checkout_created': { emoji: '🧾', title: 'Создан счёт на оплату' },
  'payment.completed': { emoji: '💰', title: 'Платёж получен' },
  'payment.failed': { emoji: '❌', title: 'Платёж не прошёл' },
  'payment.expired': { emoji: '⌛', title: 'Счёт на оплату истёк' },
  'payment.webhook_received': { emoji: '📩', title: 'Вебхук платёжки' },
  'payment.fulfillment_recovered': { emoji: '🛟', title: 'Восстановлено исполнение платежа' },

  // Referral
  'referral.attached': { emoji: '🔗', title: 'Реферал привязан' },
  'referral.qualified': { emoji: '⭐', title: 'Реферал подтверждён' },
  'referral.reward_issued': { emoji: '🎉', title: 'Реферальная награда выдана' },
  'referral.manual_attached': { emoji: '🔗', title: 'Реферал привязан вручную' },

  // Partner
  'partner.created': { emoji: '🤝', title: 'Создан партнёр' },
  'partner.activated': { emoji: '🟢', title: 'Партнёр активирован' },
  'partner.deactivated': { emoji: '🔴', title: 'Партнёр деактивирован' },
  'partner.earning': { emoji: '💵', title: 'Партнёрское начисление' },
  'partner.withdrawal_requested': { emoji: '📤', title: 'Запрос на вывод средств' },
  'partner.withdrawal_approved': { emoji: '✅', title: 'Вывод средств одобрен' },
  'partner.withdrawal_rejected': { emoji: '❌', title: 'Вывод средств отклонён' },
  'partner.balance_adjusted': { emoji: '⚖️', title: 'Скорректирован баланс партнёра' },

  // Promocode
  'promocode.activated': { emoji: '🎟', title: 'Промокод активирован' },
  'promocode.created': { emoji: '🎟', title: 'Промокод создан' },
  'promocode.depleted': { emoji: '🚫', title: 'Промокод исчерпан' },

  // Support
  'support.ticket_created': { emoji: '🆘', title: 'Новое обращение в поддержку' },
  'support.ticket_user_reply': { emoji: '💬', title: 'Ответ пользователя в тикете' },

  // Anti-fraud
  'fraud.signal_opened': { emoji: '🚨', title: 'Антифрод: новый сигнал' },
  'fraud.connections_dropped': { emoji: '✂️', title: 'Антифрод: соединения сброшены' },

  // System
  'system.startup': { emoji: '🚀', title: 'Запуск системы' },
  'system.backup_completed': { emoji: '🗄', title: 'Резервная копия создана' },
  'system.broadcast_sent': { emoji: '📢', title: 'Рассылка отправлена' },
  'system.error': { emoji: '🚨', title: 'Системная ошибка' },
  'system.remnawave_sync': { emoji: '🔄', title: 'Синхронизация с Remnawave' },
  'settings.email.updated': { emoji: '⚙️', title: 'Обновлены настройки почты' },
  'notification.template.created': { emoji: '📝', title: 'Создан шаблон уведомления' },
  'notification.template.updated': { emoji: '📝', title: 'Обновлён шаблон уведомления' },
  'notification.template.deleted': { emoji: '🗑', title: 'Удалён шаблон уведомления' },
  'notification.template.seeded': { emoji: '🌱', title: 'Засеяны шаблоны уведомлений' },

  // Remnawave panel (forwarded webhook events)
  'remnawave.user.first_connected': { emoji: '🔌', title: 'Первое подключение' },
  'remnawave.user.expired': { emoji: '⌛', title: 'Профиль истёк (Remnawave)' },
  'remnawave.user.limited': { emoji: '🚧', title: 'Достигнут лимит трафика' },
  'remnawave.user.expire_soon': { emoji: '⏰', title: 'Подписка скоро истекает' },
  'remnawave.user.enabled': { emoji: '🟢', title: 'Профиль включён (Remnawave)' },
  'remnawave.user.disabled': { emoji: '🔴', title: 'Профиль отключён (Remnawave)' },
  'remnawave.user.traffic_reset': { emoji: '♻️', title: 'Сброшен трафик профиля' },
  'remnawave.user.bandwidth_threshold': { emoji: '📊', title: 'Порог трафика достигнут' },
  'remnawave.panel.started': { emoji: '🟢', title: 'Панель Remnawave запущена' },

  // Node (forwarded webhook events)
  'node.connection_lost': { emoji: '🔌', title: 'Нода офлайн' },
  'node.connection_restored': { emoji: '✅', title: 'Нода снова онлайн' },
  'node.created': { emoji: '🆕', title: 'Добавлена нода' },
  'node.modified': { emoji: '🛠', title: 'Нода изменена' },
  'node.enabled': { emoji: '🟢', title: 'Нода включена' },
  'node.disabled': { emoji: '🔴', title: 'Нода отключена' },
  'node.traffic_notify': { emoji: '📊', title: 'Уведомление о трафике ноды' },
};

/** Human label for a payment/subscription purchase type. */
function humanizePurchaseType(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'SUBSCRIPTION':
      return 'Покупка подписки';
    case 'RENEW':
    case 'RENEWAL':
      return 'Продление';
    case 'ADD_ON':
    case 'ADDON':
      return 'Докупка';
    case 'UPGRADE':
      return 'Апгрейд';
    case 'TRIAL':
      return 'Триал';
    default:
      return escapeHtml(value);
  }
}

/** Human label for a referral reward type. */
function humanizeRewardType(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'POINTS':
      return 'Баллы';
    case 'EXTRA_DAYS':
      return 'Доп. дни';
    default:
      return escapeHtml(value);
  }
}

/** Human label for a system-action `source` (why an event fired). */
function humanizeSource(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'EXPIRED_PROFILE_CLEANUP':
      return 'Очистка истёкших профилей';
    case 'ADMIN_PANEL':
    case 'PANEL':
      return 'Rezeis Админ-панель';
    case 'WEB_CABINET':
    case 'WEB':
      return 'Веб-кабинет';
    case 'BOT':
      return 'Telegram-бот / Mini App';
    case 'API':
      return 'API';
    case 'WORKER':
      return 'Worker';
    case 'SCHEDULER':
    case 'CRON':
      return 'Планировщик';
    case 'REMNAWAVE_SYNC':
      return 'Синхронизация Remnawave';
    case 'PAYMENT_WEBHOOK':
      return 'Вебхук платёжки';
    default:
      return escapeHtml(value);
  }
}

/**
 * Tolerant date formatter: ISO/Date-ish values render as `ru-RU` locale
 * date+time; anything else (already-formatted strings, plain labels) is
 * returned escaped as-is so the card never shows "Invalid Date".
 */
function fmtDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? escapeHtml(String(value))
      : value.toLocaleString('ru-RU');
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? escapeHtml(String(value)) : d.toLocaleString('ru-RU');
  }
  if (typeof value === 'string') {
    // Only attempt parsing for ISO-like strings to avoid mangling labels.
    if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString('ru-RU');
    }
    return escapeHtml(value);
  }
  return escapeHtml(String(value));
}

/** Human-readable byte size (Б/КБ/МБ/ГБ/ТБ); whole numbers drop the decimal. */
function fmtBytes(bytes: unknown): string {
  const n = typeof bytes === 'number' ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n < 0) return escapeHtml(String(bytes));
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

// ── Presentation helpers (formatting niceties) ───────────────────────────────

/** Russian pluralization: picks the form for 1 / 2-4 / 5+ (one/few/many). */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Money with a currency symbol for fiat (₽/$/€/₴/₸/£), code for the rest. */
function fmtAmount(amount: unknown, currency: unknown): string {
  const amt = escapeHtml(amount);
  const cur = currency ? String(currency).toUpperCase() : '';
  const symbols: Record<string, string> = {
    RUB: '₽',
    USD: '$',
    EUR: '€',
    UAH: '₴',
    KZT: '₸',
    GBP: '£',
  };
  if (cur && symbols[cur]) return `${amt} ${symbols[cur]}`;
  return cur ? `${amt} ${escapeHtml(cur)}` : amt;
}

/** Humanizes a duration in days into months / years / weeks when it divides
 * evenly (30 → "1 месяц", 365 → "1 год"), otherwise plain days. */
function humanizeDuration(value: unknown): string {
  const days = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(days) || days <= 0) return escapeHtml(String(value));
  if (days % 365 === 0) {
    const y = days / 365;
    return `${y} ${pluralRu(y, 'год', 'года', 'лет')}`;
  }
  if (days % 30 === 0) {
    const m = days / 30;
    return `${m} ${pluralRu(m, 'месяц', 'месяца', 'месяцев')}`;
  }
  if (days % 7 === 0) {
    const w = days / 7;
    return `${w} ${pluralRu(w, 'неделя', 'недели', 'недель')}`;
  }
  return `${days} ${pluralRu(days, 'день', 'дня', 'дней')}`;
}

/** Human label for the purchase channel (PurchaseChannel enum). */
function humanizeChannel(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'TELEGRAM':
    case 'BOT':
    case 'MINI_APP':
      return 'Bot / Mini App';
    case 'WEB':
      return 'Веб-сайт';
    case 'ADMIN':
    case 'PANEL':
      return 'Админ-панель';
    default:
      return escapeHtml(value);
  }
}

/** Human label for the plan type (PlanType enum). */
function humanizePlanType(value: unknown): string {
  switch (String(value).toUpperCase()) {
    case 'TRAFFIC':
      return 'Трафик';
    case 'DEVICES':
      return 'Устройства';
    case 'BOTH':
      return 'Трафик + устройства';
    default:
      return escapeHtml(value);
  }
}

/**
 * Builds a link to the Remnawave panel users page when `REMNAWAVE_HOST` is a
 * public domain (contains a dot). Docker-internal service names (no dot) are
 * unreachable from a Telegram client, so we omit the link there and just show
 * the searchable login + uuid.
 */
function buildRemnawavePanelUrl(): string | null {
  const host = (process.env.REMNAWAVE_HOST ?? '').trim();
  if (host.length === 0 || !host.includes('.')) return null;
  return `https://${host}/dashboard/management/users`;
}
