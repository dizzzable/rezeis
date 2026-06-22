import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { remnawaveConfig } from '../../../common/config/remnawave.config';
import {
  EVENT_TYPES,
  SystemEventsService,
  type SystemEventCategory,
  type SystemEventSeverity,
} from '../../../common/services/system-events.service';

/**
 * Curated map of Remnawave panel webhook event names → forwarded system events.
 *
 * Only names present here are turned into Telegram cards (audit log + realtime
 * too). Everything else (e.g. the chatty `user.online`, or our own
 * `user.created`/`updated`/`deleted` which we already emit ourselves) is stored
 * in the activity feed only — keeping the firehose quiet by default.
 *
 * Keys are the lowercased panel event name. Both the dotted (`node.offline`)
 * and underscore (`node_offline`) spellings are normalized to the dotted form
 * before lookup, so either wire format matches.
 */
const REMNAWAVE_WEBHOOK_EVENT_MAP: Record<
  string,
  { readonly type: string; readonly category: SystemEventCategory; readonly severity: SystemEventSeverity }
> = {
  // User lifecycle
  'user.first_connected': { type: EVENT_TYPES.REMNAWAVE_USER_FIRST_CONNECTED, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expired': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRED, category: 'REMNAWAVE', severity: 'WARNING' },
  'user.limited': { type: EVENT_TYPES.REMNAWAVE_USER_LIMITED, category: 'REMNAWAVE', severity: 'WARNING' },
  'user.enabled': { type: EVENT_TYPES.REMNAWAVE_USER_ENABLED, category: 'REMNAWAVE', severity: 'INFO' },
  'user.disabled': { type: EVENT_TYPES.REMNAWAVE_USER_DISABLED, category: 'REMNAWAVE', severity: 'WARNING' },
  'user.traffic_reset': { type: EVENT_TYPES.REMNAWAVE_USER_TRAFFIC_RESET, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expires_in_24_hours': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expires_in_48_hours': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expires_in_72_hours': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.expire_soon': { type: EVENT_TYPES.REMNAWAVE_USER_EXPIRE_SOON, category: 'REMNAWAVE', severity: 'INFO' },
  'user.bandwidth_usage_threshold_reached': { type: EVENT_TYPES.REMNAWAVE_BANDWIDTH_THRESHOLD, category: 'REMNAWAVE', severity: 'WARNING' },
  // Node / infrastructure
  'node.connection_lost': { type: EVENT_TYPES.NODE_CONNECTION_LOST, category: 'NODE', severity: 'WARNING' },
  'node.offline': { type: EVENT_TYPES.NODE_CONNECTION_LOST, category: 'NODE', severity: 'WARNING' },
  'node.connection_restored': { type: EVENT_TYPES.NODE_CONNECTION_RESTORED, category: 'NODE', severity: 'INFO' },
  'node.online': { type: EVENT_TYPES.NODE_CONNECTION_RESTORED, category: 'NODE', severity: 'INFO' },
  'node.created': { type: EVENT_TYPES.NODE_CREATED, category: 'NODE', severity: 'INFO' },
  'node.modified': { type: EVENT_TYPES.NODE_MODIFIED, category: 'NODE', severity: 'INFO' },
  'node.enabled': { type: EVENT_TYPES.NODE_ENABLED, category: 'NODE', severity: 'INFO' },
  'node.disabled': { type: EVENT_TYPES.NODE_DISABLED, category: 'NODE', severity: 'WARNING' },
  'node.traffic_notify': { type: EVENT_TYPES.NODE_TRAFFIC_NOTIFY, category: 'NODE', severity: 'WARNING' },
  // Service
  'service.panel_started': { type: EVENT_TYPES.REMNAWAVE_PANEL_STARTED, category: 'NODE', severity: 'INFO' },
};

/**
 * Maps a Remnawave panel user `status` string onto the local
 * `SubscriptionStatus` enum. Unknown / absent statuses yield `undefined`
 * (the caller then keeps the existing status or derives it from the event).
 * `DELETED` is local-only and never set from the panel.
 */
const PANEL_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  ACTIVE: SubscriptionStatus.ACTIVE,
  DISABLED: SubscriptionStatus.DISABLED,
  LIMITED: SubscriptionStatus.LIMITED,
  EXPIRED: SubscriptionStatus.EXPIRED,
};

/** Derive the subscription status from a user-lifecycle event name. */
function statusFromEventName(normalizedEvent: string): SubscriptionStatus | undefined {
  switch (normalizedEvent) {
    case 'user.expired':
      return SubscriptionStatus.EXPIRED;
    case 'user.limited':
      return SubscriptionStatus.LIMITED;
    case 'user.disabled':
      return SubscriptionStatus.DISABLED;
    case 'user.enabled':
      return SubscriptionStatus.ACTIVE;
    default:
      return undefined;
  }
}

/** Normalizes a panel event name to the lowercased dotted form used as a map key. */
function normalizeRemnawaveEventName(eventType: string): string {
  const lower = eventType.trim().toLowerCase();
  // Convert a leading `prefix_rest` to `prefix.rest` only when there's no dot
  // yet (some senders use `USER_EXPIRED` instead of `user.expired`).
  if (!lower.includes('.') && lower.includes('_')) {
    const idx = lower.indexOf('_');
    return `${lower.slice(0, idx)}.${lower.slice(idx + 1)}`;
  }
  return lower;
}

/**
 * Handles incoming webhook events from the Remnawave panel.
 *
 * Events are stored in `RemnawaveWebhookEvent` for the Activity Feed
 * on the dashboard. The service validates HMAC-SHA256 signatures when
 * a webhook secret is configured. Curated event types are additionally
 * forwarded to the system-event bus so they reach Telegram cards.
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
    private readonly systemEvents: SystemEventsService,
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
   * Logs a rejected webhook so operators can tell, from the logs, WHY the
   * Activity Feed stays empty: either no signature header arrived (panel not
   * configured / wrong URL) or the secret mismatches (`REMNAWAVE_WEBHOOK_SECRET`
   * ≠ the panel's `WEBHOOK_SECRET_HEADER`).
   */
  public logRejectedSignature(hadSignature: boolean, sourceIp: string | null): void {
    this.logger.warn(
      hadSignature
        ? `Remnawave webhook rejected: signature mismatch (check REMNAWAVE_WEBHOOK_SECRET matches the panel's WEBHOOK_SECRET_HEADER). sourceIp=${sourceIp ?? 'unknown'}`
        : `Remnawave webhook rejected: missing X-Remnawave-Signature header (a webhook secret is configured but the panel sent none). sourceIp=${sourceIp ?? 'unknown'}`,
    );
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

    const normalized = normalizeRemnawaveEventName(eventType);

    // Inbound reconciliation (Remnawave → rezeis): a manual operator edit in
    // the panel (status / expiry / traffic / device limits) raises a user-
    // scoped webhook. Mirror those runtime fields onto the local Subscription
    // so the bot greeting + web/TMA cabinet (which read the DB snapshot) show
    // the change immediately. Best-effort — a reconcile failure must never
    // drop the webhook (Activity Feed + cards still proceed).
    //
    // Echo-safe: this writes ONLY to the local DB and never enqueues a
    // profile-sync push (those are enqueued by subscription mutation services,
    // not by a DB write), so there is no panel↔rezeis loop. Panel is the
    // source of truth for runtime state; rezeis still owns commercial fields
    // (plan snapshot, price, isTrial), which this never touches.
    if (normalized.startsWith('user.')) {
      try {
        await this.reconcileSubscriptionFromEvent(normalized, payload);
      } catch (err: unknown) {
        this.logger.warn(
          `Subscription reconcile failed for ${eventType}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Forward curated events to the system-event bus (audit log + realtime +
    // Telegram cards). Unmapped/noisy events are stored only — no Telegram
    // spam. Best-effort: emit() is fire-and-forget and never throws.
    const mapped = REMNAWAVE_WEBHOOK_EVENT_MAP[normalized];
    if (mapped) {
      this.systemEvents.emit({
        type: mapped.type,
        category: mapped.category,
        severity: mapped.severity,
        message: `Remnawave: ${eventType}`,
        metadata: this.extractEventMetadata(eventType, payload),
      });
    }
  }

  /**
   * Reconcile the local `Subscription` snapshot from a user-scoped panel
   * event. Pulls the panel's canonical runtime fields out of the webhook
   * payload (`data`, 2.x) and overlays them onto every non-deleted
   * subscription whose `remnawaveId` matches. Partial: only fields present
   * in the payload are written; status falls back to the event name.
   */
  private async reconcileSubscriptionFromEvent(
    normalizedEvent: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data =
      payload['data'] !== null && typeof payload['data'] === 'object'
        ? (payload['data'] as Record<string, unknown>)
        : payload;
    const str = (key: string): string | undefined => {
      const v = data[key];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    const num = (key: string): number | undefined => {
      const v = data[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };

    const uuid = str('uuid') ?? str('userUuid');
    if (uuid === undefined) return;

    const update: Prisma.SubscriptionUpdateManyMutationInput = {};

    // Status: the panel's canonical `status` wins; otherwise derive it from
    // the event name (user.expired/limited/disabled/enabled).
    const panelStatus = str('status');
    const status =
      (panelStatus !== undefined
        ? PANEL_STATUS_MAP[panelStatus.trim().toUpperCase()]
        : undefined) ?? statusFromEventName(normalizedEvent);
    if (status !== undefined) update.status = status;

    // Expiry: ISO string → Date.
    const expireAt = str('expireAt');
    if (expireAt !== undefined) {
      const parsed = new Date(expireAt);
      if (!Number.isNaN(parsed.getTime())) update.expiresAt = parsed;
    }

    // Traffic limit: panel is bytes (0 = unlimited); local is GB (null =
    // unlimited). Round to the nearest GB, never below 1 for a positive cap.
    const trafficLimitBytes = num('trafficLimitBytes');
    if (trafficLimitBytes !== undefined) {
      update.trafficLimit =
        trafficLimitBytes <= 0 ? null : Math.max(1, Math.round(trafficLimitBytes / 1024 ** 3));
    }

    // Device limit: panel `hwidDeviceLimit` → local `deviceLimit`.
    const deviceLimit = num('hwidDeviceLimit');
    if (deviceLimit !== undefined && deviceLimit >= 0) update.deviceLimit = deviceLimit;

    if (Object.keys(update).length === 0) return;

    const result = await this.prismaService.subscription.updateMany({
      where: { remnawaveId: uuid, status: { not: SubscriptionStatus.DELETED } },
      data: update,
    });
    if (result.count > 0) {
      this.logger.log(
        `Reconciled ${result.count} subscription(s) from panel event ${normalizedEvent} (uuid=${uuid})`,
      );
    }
  }

  /**
   * Maps a raw Remnawave webhook payload onto the card metadata keys the
   * formatter understands. Reads from `payload.data` (2.x) with a flat
   * fallback. Only documented, non-sensitive fields are surfaced.
   */
  private extractEventMetadata(
    eventType: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const data =
      payload['data'] !== null && typeof payload['data'] === 'object'
        ? (payload['data'] as Record<string, unknown>)
        : payload;
    const str = (key: string): string | undefined => {
      const v = data[key];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    const num = (key: string): number | undefined => {
      const v = data[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };

    const meta: Record<string, unknown> = { remnawaveEvent: eventType, source: 'REMNAWAVE_WEBHOOK' };

    // User-scoped fields
    const username = str('username');
    if (username) meta['remnawaveUsername'] = username;
    const uuid = str('uuid') ?? str('userUuid');
    if (uuid) meta['remnawaveId'] = uuid;
    const telegramId = str('telegramId') ?? (num('telegramId') !== undefined ? String(num('telegramId')) : undefined);
    if (telegramId) meta['telegramId'] = telegramId;
    const expireAt = str('expireAt');
    if (expireAt) meta['expireAt'] = expireAt;
    const trafficLimit = num('trafficLimitBytes');
    if (trafficLimit !== undefined) meta['trafficLimitBytes'] = trafficLimit;
    const usedTraffic = num('usedTrafficBytes') ?? num('usedTraffic');
    if (usedTraffic !== undefined) meta['usedTrafficBytes'] = usedTraffic;

    // Node-scoped fields
    const nodeName = str('name') ?? str('nodeName');
    if (nodeName && eventType.toLowerCase().includes('node')) meta['nodeName'] = nodeName;
    const nodeUuid = str('nodeUuid');
    if (nodeUuid) meta['nodeUuid'] = nodeUuid;
    else if (eventType.toLowerCase().includes('node') && uuid) meta['nodeUuid'] = uuid;
    const countryCode = str('countryCode');
    if (countryCode) meta['countryCode'] = countryCode;
    const address = str('address');
    if (address && eventType.toLowerCase().includes('node')) meta['nodeAddress'] = address;

    return meta;
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
