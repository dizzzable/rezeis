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

// ── Event Types ─────────────────────────────────────────────────────────────

export type SystemEventCategory =
  | 'USER'
  | 'AUTH'
  | 'SUBSCRIPTION'
  | 'PAYMENT'
  | 'REFERRAL'
  | 'PARTNER'
  | 'PROMOCODE'
  | 'SUPPORT'
  | 'FRAUD'
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

  // Support
  SUPPORT_TICKET_CREATED: 'support.ticket_created',
  SUPPORT_TICKET_USER_REPLY: 'support.ticket_user_reply',

  // Anti-fraud
  FRAUD_SIGNAL_OPENED: 'fraud.signal_opened',

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
  public info(type: string, category: SystemEventCategory, message: string, metadata?: Record<string, unknown>): void {
    this.emit({ type, category, severity: 'INFO', message, metadata });
  }

  /**
   * Convenience: emit a WARNING event.
   */
  public warn(type: string, category: SystemEventCategory, message: string, metadata?: Record<string, unknown>): void {
    this.emit({ type, category, severity: 'WARNING', message, metadata });
  }

  /**
   * Convenience: emit an ERROR event.
   */
  public error(type: string, category: SystemEventCategory, message: string, metadata?: Record<string, unknown>): void {
    this.emit({ type, category, severity: 'ERROR', message, metadata });
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
        this.logger.warn(`Webhook to ${url} failed: ${(err as Error).message}`);
      }
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
    if (!tgConfig.enabled || !tgConfig.botToken || !tgConfig.chatId) return;

    // Filter: if events list is specified, only send matching events
    if (tgConfig.events.length > 0 && !tgConfig.events.includes(event.type)) return;

    // Resolve topic ID: per-category mapping → default → null (general chat)
    const topicId = tgConfig.topicMap[event.category] ?? tgConfig.defaultTopicId ?? null;

    const html = this.formatTelegramMessage(event);

    const payload: Record<string, unknown> = {
      chat_id: tgConfig.chatId,
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
  }

  /**
   * Formats an event into a Telegram HTML message matching the altshop style.
   */
  private formatTelegramMessage(event: SystemEventPayload & { timestamp: string }): string {
    const hashtag = `#${eventTypeToHashtag(event.type)}`;
    const emoji = severityEmoji(event.severity);
    const meta = event.metadata ?? {};

    const lines: string[] = [
      hashtag,
      '',
      `${emoji} <b>Событие: ${event.message}</b>`,
    ];

    // User block
    if (meta['userId'] || meta['telegramId']) {
      lines.push('');
      lines.push('👤 <b>Пользователь:</b>');
      const userLines: string[] = [];
      if (meta['telegramId']) userLines.push(`• <b>ID:</b> <code>${meta['telegramId']}</code>`);
      if (meta['userId']) userLines.push(`• <b>User ID:</b> <code>${String(meta['userId']).slice(0, 12)}</code>`);
      if (meta['userName']) userLines.push(`• <b>Имя:</b> ${meta['userName']}`);
      if (meta['username']) userLines.push(`• <b>Username:</b> @${meta['username']}`);
      lines.push(`<blockquote>${userLines.join('\n')}</blockquote>`);
    }

    // Payment block
    if (meta['paymentId'] || meta['amount']) {
      lines.push('');
      lines.push('💰 <b>Платёж:</b>');
      const payLines: string[] = [];
      if (meta['paymentId']) payLines.push(`• <b>ID:</b> <code>${meta['paymentId']}</code>`);
      if (meta['gatewayType']) payLines.push(`• <b>Способ оплаты:</b> ${meta['gatewayType']}`);
      if (meta['amount']) payLines.push(`• <b>Сумма:</b> ${meta['amount']}${meta['currency'] ? ` ${meta['currency']}` : ''}`);
      lines.push(`<blockquote>${payLines.join('\n')}</blockquote>`);
    }

    // Plan/Subscription block
    if (meta['planName'] || meta['subscriptionId']) {
      lines.push('');
      lines.push('📦 <b>План:</b>');
      const planLines: string[] = [];
      if (meta['planName']) planLines.push(`• <b>План:</b> ${meta['planName']}`);
      if (meta['purchaseType']) planLines.push(`• <b>Тип:</b> ${meta['purchaseType']}`);
      if (meta['durationDays']) planLines.push(`• <b>Длительность:</b> ${meta['durationDays']} дней`);
      if (meta['subscriptionId']) planLines.push(`• <b>Подписка:</b> <code>${String(meta['subscriptionId']).slice(0, 12)}</code>`);
      lines.push(`<blockquote>${planLines.join('\n')}</blockquote>`);
    }

    // Partner block
    if (meta['partnerId'] || meta['earning']) {
      lines.push('');
      lines.push('🤝 <b>Партнёр:</b>');
      const partnerLines: string[] = [];
      if (meta['partnerId']) partnerLines.push(`• <b>ID:</b> <code>${String(meta['partnerId']).slice(0, 12)}</code>`);
      if (meta['level']) partnerLines.push(`• <b>Уровень:</b> L${meta['level']}`);
      if (meta['earning']) partnerLines.push(`• <b>Начислено:</b> ${(Number(meta['earning']) / 100).toFixed(2)} ₽`);
      if (meta['percent']) partnerLines.push(`• <b>Процент:</b> ${meta['percent']}%`);
      lines.push(`<blockquote>${partnerLines.join('\n')}</blockquote>`);
    }

    // Referral block
    if (meta['referrerId'] || meta['referralId']) {
      lines.push('');
      lines.push('🔗 <b>Реферал:</b>');
      const refLines: string[] = [];
      if (meta['referralId']) refLines.push(`• <b>Referral ID:</b> <code>${String(meta['referralId']).slice(0, 12)}</code>`);
      if (meta['referrerId']) refLines.push(`• <b>Реферер:</b> <code>${String(meta['referrerId']).slice(0, 12)}</code>`);
      if (meta['historicalPaymentsProcessed'] !== undefined) refLines.push(`• <b>Платежей обработано:</b> ${meta['historicalPaymentsProcessed']}`);
      lines.push(`<blockquote>${refLines.join('\n')}</blockquote>`);
    }

    // Promocode block
    if (meta['code'] || meta['promocodeId']) {
      lines.push('');
      lines.push('🎟 <b>Промокод:</b>');
      const promoLines: string[] = [];
      if (meta['code']) promoLines.push(`• <b>Код:</b> <code>${meta['code']}</code>`);
      if (meta['rewardType']) promoLines.push(`• <b>Тип награды:</b> ${meta['rewardType']}`);
      if (meta['rewardValue']) promoLines.push(`• <b>Значение:</b> ${meta['rewardValue']}`);
      lines.push(`<blockquote>${promoLines.join('\n')}</blockquote>`);
    }

    // Device/HWID block
    if (meta['hwid']) {
      lines.push('');
      lines.push('📱 <b>Устройство:</b>');
      const deviceLines: string[] = [];
      deviceLines.push(`• <b>HWID:</b> <code>${meta['hwid']}</code>`);
      if (meta['remainingDevices'] !== undefined) deviceLines.push(`• <b>Осталось устройств:</b> ${meta['remainingDevices']}`);
      if (meta['subscriptionId']) deviceLines.push(`• <b>Подписка:</b> <code>${String(meta['subscriptionId']).slice(0, 12)}</code>`);
      if (meta['remnawaveId']) deviceLines.push(`• <b>Remnawave:</b> <code>${String(meta['remnawaveId']).slice(0, 12)}</code>`);
      lines.push(`<blockquote>${deviceLines.join('\n')}</blockquote>`);
    }

    // Error block
    if (meta['error'] || event.severity === 'ERROR') {
      lines.push('');
      lines.push('⚠️ <b>Ошибка:</b>');
      const errLines: string[] = [];
      if (meta['error']) errLines.push(`• <b>Сообщение:</b> ${meta['error']}`);
      if (meta['action']) errLines.push(`• <b>Действие:</b> <code>${meta['action']}</code>`);
      if (meta['attempt']) errLines.push(`• <b>Попытка:</b> ${meta['attempt']}`);
      lines.push(`<blockquote>${errLines.join('\n')}</blockquote>`);
    }

    // Context block
    lines.push('');
    lines.push('<b>Контекст:</b>');
    const ctxLines: string[] = [
      `• <b>Категория:</b> ${event.category}`,
      `• <b>Уровень:</b> ${event.severity}`,
      `• <b>Время:</b> ${new Date(event.timestamp).toLocaleString('ru-RU')}`,
    ];
    lines.push(`<blockquote>${ctxLines.join('\n')}</blockquote>`);

    return lines.join('\n');
  }

  private async loadTelegramConfig(): Promise<{
    enabled: boolean;
    botToken: string | null;
    chatId: string | null;
    topicMap: Record<string, number | null>;
    defaultTopicId: number | null;
    events: string[];
  }> {
    const settings = await this.prismaService.settings.findFirst({
      select: { systemNotifications: true },
    });
    if (!settings) {
      return { enabled: false, botToken: null, chatId: null, topicMap: {}, defaultTopicId: null, events: [] };
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

    return {
      enabled: tg.enabled === true,
      botToken: typeof tg.botToken === 'string' ? tg.botToken : (process.env.BOT_TOKEN ?? null),
      chatId: typeof tg.chatId === 'string' ? tg.chatId : null,
      topicMap,
      defaultTopicId: typeof tg.topicId === 'number' ? tg.topicId : null,
      events: Array.isArray(tg.events) ? tg.events.filter((e): e is string => typeof e === 'string') : [],
    };
  }
}


// ── Helpers ─────────────────────────────────────────────────────────────────

function eventTypeToHashtag(type: string): string {
  // "payment.completed" → "EventPaymentCompleted"
  return 'Event' + type
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function severityEmoji(severity: SystemEventSeverity): string {
  switch (severity) {
    case 'ERROR': return '🚨';
    case 'WARNING': return '⚠️';
    default: return '⚙️';
  }
}
